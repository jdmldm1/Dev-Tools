/* XSD model: parse one or many schema files into a navigable, indexed structure.
   Pure functions on DT.lib; no DOM. See xsd-validate.js / xsd-sample.js for instance validation and sample generation.

   model = {
     files:    [{ name, size, targetNamespace, version, elementFormDefault, includes, imports, counts }]
     elements: Map name -> { name, type, doc, version, nillable, abstract, substitutionGroup, file }
     types:    Map name -> { name, kind:"complex"|"simple", base, derivation, abstract, mixed, doc, version, file,
                             content: particle|null, attributes: [...], anyAttribute, simpleContent,
                             facets: {...}, itemType, memberTypes, parts: [flattened own members] }
     groups, attributeGroups, attributes: Map
     namespaces: Set, targetNamespace, elementFormDefault
     problems: [{ level:"error"|"warn", kind, message, file? }]
     usedBy, derived, elementsOfType: Map   (reverse indexes)
   }
   particle = { k:"seq"|"choice"|"all", min, max, items } | { k:"el", name, ref, type, min, max, doc, ... } | { k:"any", ... } | { k:"group", ref, min, max }
   min/max are numbers; max may be Infinity. */
(function () {
  const lib = DT.lib;
  const local = n => (n || "").replace(/^[^:]+:/, "");
  const base = p => (p || "").split(/[\\/]/).pop();

  const BUILTINS = new Set(("string normalizedString token language NMTOKEN NMTOKENS Name NCName ID IDREF IDREFS ENTITY ENTITIES boolean decimal float double duration dateTime time date " +
    "gYearMonth gYear gMonthDay gDay gMonth hexBinary base64Binary anyURI QName NOTATION integer nonPositiveInteger negativeInteger long int short byte nonNegativeInteger " +
    "unsignedLong unsignedInt unsignedShort unsignedByte positiveInteger anyType anySimpleType").split(" "));
  lib.xsdIsBuiltin = n => BUILTINS.has(local(n));

  /* Namespace an element particle's instances belong to: global elements and refs are always in their schema's target namespace;
     local elements only when qualified (elementFormDefault or the element's own `form`). */
  lib.xsdElementNs = function (model, p, isGlobal = false) {
    const tnsOf = fname => ((model.files.find(f => f.name === fname) || {}).targetNamespace) || "";
    if (isGlobal || p.ref) { const g = p.ref ? model.elements.get(p.name) : p; return tnsOf((g || p).file); }
    const f = model.files.find(x => x.name === p.file) || model.files[0];
    const qualified = p.form ? p.form === "qualified" : !!f && f.elementFormDefault === "qualified";
    return qualified ? tnsOf(p.file) : "";
  };

  lib.xsdFmtMax = m => m === Infinity ? "∞" : String(m);
  lib.xsdFmtOccurs = (min, max) => `${min}..${lib.xsdFmtMax(max)}`;
  const occ = (v, dflt) => v === undefined ? dflt : v === "unbounded" ? Infinity : (Number.isFinite(+v) ? +v : dflt);
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : a * b;

  /* Tidy documentation text: keep the author's line breaks (some docs are lists), trim indentation, squeeze runs of spaces, limit blank lines. */
  const reflow = t => t.split("\n").map(l => l.replace(/\s+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  lib.xsdModel = function (inputs) {
    const files = inputs.map((x, i) => typeof x === "string" ? { name: `schema${i + 1}.xsd`, text: x } : x);
    const model = {
      files: [], elements: new Map(), types: new Map(), groups: new Map(), attributeGroups: new Map(), attributes: new Map(),
      namespaces: new Set(), targetNamespace: "", elementFormDefault: "unqualified", problems: [],
      usedBy: new Map(), derived: new Map(), elementsOfType: new Map(), substitutes: new Map(),
    };
    const problem = (level, kind, message, file) => model.problems.push({ level, kind, message, file });
    const fatals = [];

    for (const f of files) {
      let tree;
      try { tree = lib.xmlParse(f.text); } catch (e) { fatals.push(`${f.name}: ${e.message}`); problem("error", "parse", e.message, f.name); continue; }
      if (local(tree.root.name) !== "schema") { const m = `Root element is <${tree.root.name}>, not an xs:schema.`; fatals.push(`${f.name}: ${m}`); problem("error", "not-schema", m, f.name); continue; }
      addFile(model, tree, f, problem);
    }
    if (!model.files.length) throw new Error(fatals[0] || "No schema files to load.");
    finalize(model, problem);
    return model;
  };

  function addFile(model, tree, f, problem) {
    const root = tree.root;
    const attr = (el, n) => (el.attrs.find(a => a[0] === n) || [])[1];
    const kids = (el, ...names) => el.kids.filter(k => k.t === "el" && (!names.length || names.includes(local(k.name))));
    const tns = attr(root, "targetNamespace") || "";
    const info = { name: f.name, size: f.text.length, targetNamespace: tns, version: attr(root, "version") || "", elementFormDefault: attr(root, "elementFormDefault") || "unqualified", includes: [], imports: [], counts: { elements: 0, types: 0 } };
    model.files.push(info);
    if (tns) { model.namespaces.add(tns); if (!model.targetNamespace) model.targetNamespace = tns; }
    if (model.files.length === 1) model.elementFormDefault = info.elementFormDefault;

    const verOf = el => { const a = el.attrs.find(x => /^[^:]+:version$/.test(x[0])); return a ? a[1] : ""; };
    const docOf = el => {
      const ann = kids(el, "annotation")[0]; if (!ann) return "";
      const docs = kids(ann, "documentation").map(d => reflow(d.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join(""))).filter(Boolean);
      return [...new Set(docs)].join("\n\n");
    };
    const define = (map, key, value, what) => {
      if (map.has(key)) { problem("warn", "duplicate", `${what} "${key}" is defined more than once (kept the first, from ${map.get(key).file}).`, f.name); return false; }
      map.set(key, value); return true;
    };

    function elementDecl(k, owner) {
      const name = attr(k, "name"), ref = attr(k, "ref");
      const d = { k: "el", name: local(name || ref), ref: !!ref, min: occ(attr(k, "minOccurs"), 1), max: occ(attr(k, "maxOccurs"), 1), doc: docOf(k), version: verOf(k),
        nillable: attr(k, "nillable") === "true", abstract: attr(k, "abstract") === "true", substitutionGroup: local(attr(k, "substitutionGroup")), default: attr(k, "default"), fixed: attr(k, "fixed"), form: attr(k, "form"), file: f.name };
      const inline = kids(k, "complexType", "simpleType")[0];
      if (attr(k, "type")) d.type = local(attr(k, "type"));
      else if (inline) { const syn = owner ? `${owner}.${d.name}` : `${d.name}(anonymous)`; addType(inline, syn); d.type = syn; d.anon = true; }
      else d.type = ref ? "" : "anyType";
      return d;
    }
    function particle(el, owner) {
      const ln = local(el.name), min = occ(attr(el, "minOccurs"), 1), max = occ(attr(el, "maxOccurs"), 1);
      if (ln === "sequence" || ln === "choice" || ln === "all") return { k: ln === "sequence" ? "seq" : ln, min, max, doc: docOf(el), items: kids(el).map(c => particle(c, owner)).filter(Boolean) };
      if (ln === "element") return elementDecl(el, owner);
      if (ln === "any") return { k: "any", min, max, ns: attr(el, "namespace") || "##any", process: attr(el, "processContents") || "strict" };
      if (ln === "group") return { k: "group", ref: local(attr(el, "ref")), min, max };
      return null;
    }
    function attrDecl(k, owner) {
      const name = attr(k, "name"), ref = attr(k, "ref");
      const a = { name: local(name || ref), ref: !!ref, type: local(attr(k, "type")), use: attr(k, "use") || "optional", default: attr(k, "default"), fixed: attr(k, "fixed"), doc: docOf(k), version: verOf(k) };
      const inline = kids(k, "simpleType")[0];
      if (!a.type && inline) { const syn = `${owner || "attribute"}.@${a.name}`; addType(inline, syn); a.type = syn; a.anon = true; }
      if (!a.type) a.type = ref ? "" : "anySimpleType";
      return a;
    }
    function collectAttrs(container, type) {
      for (const k of kids(container)) {
        const ln = local(k.name);
        if (ln === "attribute") type.attributes.push(attrDecl(k, type.name));
        else if (ln === "attributeGroup") type.attributes.push({ group: local(attr(k, "ref")) });
        else if (ln === "anyAttribute") type.anyAttribute = true;
      }
    }
    function readFacets(restr, type) {
      for (const x of kids(restr)) {
        const ln = local(x.name), v = attr(x, "value");
        if (ln === "enumeration") (type.facets.enumeration = type.facets.enumeration || []).push({ value: v, doc: docOf(x) });
        else if (ln === "pattern") (type.facets.pattern = type.facets.pattern || []).push(v);
        else if (v !== undefined && ln !== "simpleType") type.facets[ln] = v;
      }
    }
    function contentOf(container, type) {
      for (const k of kids(container)) {
        const ln = local(k.name);
        if (["sequence", "choice", "all", "group"].includes(ln)) type.content = particle(k, type.name);
      }
      collectAttrs(container, type);
    }
    function addType(el, forcedName) {
      const name = forcedName || attr(el, "name"); if (!name) return;
      const ln = local(el.name);
      const type = { name, kind: ln === "complexType" ? "complex" : "simple", base: "", derivation: "", abstract: attr(el, "abstract") === "true", mixed: attr(el, "mixed") === "true",
        doc: docOf(el), version: verOf(el), file: f.name, content: null, attributes: [], anyAttribute: false, facets: {}, parts: [] };
      if (ln === "complexType") {
        contentOf(el, type);
        for (const k of kids(el, "complexContent", "simpleContent")) {
          const inner = kids(k, "extension", "restriction")[0];
          if (!inner) continue;
          type.base = local(attr(inner, "base")); type.derivation = local(inner.name);
          if (local(k.name) === "simpleContent") { type.simpleContent = true; readFacets(inner, type); }
          if (attr(k, "mixed") === "true") type.mixed = true;
          contentOf(inner, type);
        }
      } else {
        const r = kids(el, "restriction")[0], l = kids(el, "list")[0], u = kids(el, "union")[0];
        if (r) {
          type.base = local(attr(r, "base")); type.derivation = "restriction";
          const innerST = kids(r, "simpleType")[0];
          if (innerST && !type.base) { type.base = `${name}.base`; addType(innerST, type.base); }
          readFacets(r, type);
        } else if (l) {
          type.simpleKind = "list"; type.itemType = local(attr(l, "itemType"));
          const innerST = kids(l, "simpleType")[0]; if (innerST) { type.itemType = `${name}.item`; addType(innerST, type.itemType); }
        } else if (u) {
          type.simpleKind = "union"; type.memberTypes = (attr(u, "memberTypes") || "").split(/\s+/).filter(Boolean).map(local);
          kids(u, "simpleType").forEach((st, i) => { const n = `${name}.member${i + 1}`; addType(st, n); type.memberTypes.push(n); });
        }
      }
      if (define(model.types, name, type, "Type")) info.counts.types++;
    }

    for (const k of kids(root)) {
      const ln = local(k.name);
      if (ln === "include") info.includes.push(base(attr(k, "schemaLocation")));
      else if (ln === "import") info.imports.push({ namespace: attr(k, "namespace") || "", location: base(attr(k, "schemaLocation")) });
      else if (ln === "complexType" || ln === "simpleType") addType(k);
      else if (ln === "element") {
        const e = elementDecl(k, null); e.k = undefined;
        if (define(model.elements, e.name, e, "Element")) info.counts.elements++;
      } else if (ln === "group") model.groups.set(attr(k, "name"), { name: attr(k, "name"), particle: particle(kids(k, "sequence", "choice", "all")[0] || { name: "xs:sequence", kids: [], attrs: [] }, attr(k, "name")), file: f.name });
      else if (ln === "attributeGroup") { const t = { name: attr(k, "name"), attributes: [] }; collectAttrs(k, t); model.attributeGroups.set(t.name, { ...t, file: f.name }); }
      else if (ln === "attribute") { const a = attrDecl(k, null); model.attributes.set(a.name, a); }
      else if (ln === "redefine" || ln === "override") problem("warn", "unsupported", `<xs:${ln}> is not supported; its contents were ignored.`, f.name);
    }
  }

  /* Display list of a type's own declared members, with effective cardinality through enclosing groups. */
  function flattenOwn(model, type) {
    const out = [];
    let choiceN = 0;
    const walk = (p, mult, choice, depth) => {
      if (!p || depth > 40) return;
      const m = { min: mul(mult.min, p.min), max: mul(mult.max, p.max) };
      if (p.k === "seq" || p.k === "all") p.items.forEach(i => walk(i, m, choice, depth + 1));
      else if (p.k === "choice") { const id = ++choiceN; p.items.forEach((i, ix) => walk(i, m, { id, alt: ix + 1, of: p.items.length }, depth + 1)); }
      else if (p.k === "group") { const g = model.groups.get(p.ref); out.push({ kind: "group", name: p.ref, type: "(group)", min: m.min, max: m.max, choice, resolved: !!g }); if (g) walk(g.particle, m, choice, depth + 1); }
      else if (p.k === "any") out.push({ kind: "any", name: "(any element)", type: "xs:any", min: m.min, max: m.max, choice });
      else if (p.k === "el") out.push({ kind: "element", name: p.name, type: p.type || (p.ref && model.elements.has(p.name) ? model.elements.get(p.name).type : ""), min: m.min, max: m.max, choice, doc: p.doc, version: p.version, ref: p.ref, anon: p.anon, nillable: p.nillable });
    };
    walk(type.content, { min: 1, max: 1 }, null, 0);
    for (const a of type.attributes) {
      if (a.group) { const g = model.attributeGroups.get(a.group); if (g) g.attributes.forEach(x => out.push({ kind: "attribute", name: x.name, type: x.type, min: x.use === "required" ? 1 : 0, max: 1, use: x.use, doc: x.doc })); else out.push({ kind: "attributeGroup", name: a.group, type: "(attribute group)", min: 0, max: 1 }); }
      else out.push({ kind: "attribute", name: a.name, type: a.type || (a.ref && model.attributes.has(a.name) ? model.attributes.get(a.name).type : ""), min: a.use === "required" ? 1 : 0, max: 1, use: a.use, doc: a.doc, version: a.version });
    }
    return out;
  }

  function finalize(model, problem) {
    // flattened member lists and reverse indexes
    const push = (map, k, v) => { let a = map.get(k); if (!a) map.set(k, a = []); a.push(v); };
    for (const t of model.types.values()) {
      t.parts = flattenOwn(model, t);
      if (t.base) push(model.derived, t.base, t.name);
      for (const p of t.parts) if (p.type) push(model.usedBy, p.type, { owner: t.name, member: p.name, kind: p.kind });
      if (t.simpleKind === "list" && t.itemType) push(model.usedBy, t.itemType, { owner: t.name, member: "(list item)", kind: "list" });
      if (t.simpleKind === "union") t.memberTypes.forEach(m => push(model.usedBy, m, { owner: t.name, member: "(union member)", kind: "union" }));
    }
    for (const e of model.elements.values()) {
      push(model.elementsOfType, e.type, e.name);
      if (e.substitutionGroup) push(model.substitutes, e.substitutionGroup, e.name);
    }
    // diagnostics: unresolved references and missing included files
    const known = n => !n || lib.xsdIsBuiltin(n) || model.types.has(n);
    const seen = new Set(), flag = (kind, msg, file) => { const k = kind + msg; if (!seen.has(k)) { seen.add(k); problem("error", kind, msg, file); } };
    for (const t of model.types.values()) {
      if (!known(t.base)) flag("unresolved", `Type "${t.name}" extends/restricts unknown type "${t.base}".`, t.file);
      if (t.itemType && !known(t.itemType)) flag("unresolved", `List type "${t.name}" has unknown item type "${t.itemType}".`, t.file);
      for (const m of t.memberTypes || []) if (!known(m)) flag("unresolved", `Union type "${t.name}" has unknown member type "${m}".`, t.file);
      for (const p of t.parts) {
        if (p.kind === "element" && p.type && !known(p.type)) flag("unresolved", `"${t.name}" member "${p.name}" has unknown type "${p.type}".`, t.file);
        if (p.kind === "element" && p.ref && !model.elements.has(p.name)) flag("unresolved", `"${t.name}" refers to unknown element "${p.name}".`, t.file);
        if (p.kind === "group" && !p.resolved) flag("unresolved", `"${t.name}" refers to unknown group "${p.name}".`, t.file);
        if (p.kind === "attribute" && p.type && !known(p.type)) flag("unresolved", `"${t.name}" attribute "${p.name}" has unknown type "${p.type}".`, t.file);
      }
    }
    for (const e of model.elements.values()) if (e.type && !known(e.type)) flag("unresolved", `Element "${e.name}" has unknown type "${e.type}".`, e.file);
    const have = new Set(model.files.map(f => f.name.split(/[\\/]/).pop()));
    for (const f of model.files) for (const inc of f.includes) if (inc && !have.has(inc)) problem("warn", "missing-include", `${f.name} includes "${inc}", which was not loaded.`, f.name);
    for (const f of model.files) for (const im of f.imports) if (im.location && !have.has(im.location) && !model.namespaces.has(im.namespace)) problem("warn", "missing-import", `${f.name} imports namespace "${im.namespace}" from "${im.location}", which was not loaded.`, f.name);
  }

  lib.xsdSummary = m => {
    const types = [...m.types.values()];
    return {
      elements: m.elements.size, types: types.length,
      complex: types.filter(t => t.kind === "complex").length, simple: types.filter(t => t.kind === "simple").length,
      enums: types.filter(t => t.facets && t.facets.enumeration).length,
    };
  };

  /* ---- effective content: base chain resolved -------------------------------------- */

  /* Chain of types from the most basic ancestor down to `typeName`. A complexContent restriction replaces what its ancestors declared. */
  lib.xsdChain = function (model, typeName) {
    const chain = [], seen = new Set();
    for (let t = model.types.get(typeName); t && !seen.has(t.name); t = t.base ? model.types.get(t.base) : null) { seen.add(t.name); chain.unshift(t); }
    let start = 0;
    chain.forEach((t, i) => { if (t.derivation === "restriction" && t.kind === "complex" && !t.simpleContent) start = i; });
    return chain.slice(start);
  };

  /* Every member of a type including inherited ones (base first). */
  lib.xsdMembers = function (model, typeName) {
    const out = [];
    for (const t of lib.xsdChain(model, typeName)) for (const p of t.parts) out.push({ ...p, from: t.name, inherited: t.name !== typeName });
    return out;
  };

  /* Indented text outline of what a type or element contains. */
  lib.xsdTree = function (model, typeName, depth = 3, { docs = false } = {}) {
    const lines = [];
    const enumLine = t => { const en = t && t.facets.enumeration; return en && en.length ? `enum: ${en.slice(0, 8).map(e => e.value).join(" | ")}${en.length > 8 ? ` … (+${en.length - 8})` : ""}` : ""; };
    function expand(tn, lvl, seen) {
      const t = model.types.get(tn);
      if (!t) return;
      if (t.kind === "simple") { const l = enumLine(t); if (l && lvl > 0) lines.push("  ".repeat(lvl) + l); return; }
      if (seen.has(tn)) { lines.push("  ".repeat(lvl) + "↺ recursive"); return; }
      const s2 = new Set(seen).add(tn);
      const inherited = lib.xsdChain(model, tn).slice(0, -1).map(x => x.name);
      if (inherited.length) lines.push("  ".repeat(lvl) + `⤷ extends ${t.base}`);
      for (const p of lib.xsdMembers(model, tn)) {
        const card = p.min === 1 && p.max === 1 ? "" : ` [${lib.xsdFmtOccurs(p.min, p.max)}]`;
        lines.push("  ".repeat(lvl) + (p.choice ? "│ " : "") + `${p.kind === "attribute" ? "@" : ""}${p.name}${card}  : ${p.type}${p.use === "required" ? "  (required)" : ""}${docs && p.doc ? "   — " + p.doc.split("\n")[0].slice(0, 100) : ""}`);
        if (lvl < depth && p.type) expand(p.type, lvl + 1, s2);
      }
    }
    expand(typeName, 0, new Set());
    return lines;
  };

  /* Every path under a type or message, depth-first: [{ path, type, min, max, kind, leaf, recursive }].
     Stops at recursion and at maxDepth; `limit` bounds the output. */
  lib.xsdPaths = function (model, typeName, rootName, { maxDepth = 14, limit = 20000 } = {}) {
    const out = [];
    let truncated = false;
    (function walk(tn, path, depth, anc) {
      if (out.length >= limit) { truncated = true; return; }
      const t = model.types.get(tn);
      const members = t && t.kind === "complex" ? lib.xsdMembers(model, tn) : [];
      for (const m of members) {
        if (m.kind === "group" || m.kind === "any") continue;
        const p = path + "/" + (m.kind === "attribute" ? "@" : "") + m.name;
        const sub = model.types.get(m.type), complex = sub && sub.kind === "complex" && !sub.simpleContent;
        const recursive = complex && anc.includes(m.type);
        const expand = complex && !recursive && depth < maxDepth;
        out.push({ path: p, type: m.type, min: m.min, max: m.max, kind: m.kind, leaf: !expand, recursive: !!recursive, depth });
        if (out.length >= limit) { truncated = true; return; }
        if (expand) walk(m.type, p, depth + 1, anc.concat(m.type));
      }
    })(typeName, "/" + rootName, 1, [typeName]);
    out.truncated = truncated;
    return out;
  };

  /* ---- categories, families, reverse lookups ---------------------------------------- */

  lib.xsdCategory = function (model, t) {
    if (t.facets && t.facets.enumeration) return "enum";
    if (model.elementsOfType.has(t.name)) return "msgtype";          // the type of a global element (a message)
    if (/ID_Type$/.test(t.name)) return "id";
    if (/ChoiceType$/.test(t.name)) return "choice";
    if (t.abstract || /(BaseType|PET)$/.test(t.name)) return "base";
    if (/MDT$/.test(t.name) && t.kind === "complex") return "data";
    if (t.kind === "simple") return "simple";
    return "complex";
  };
  lib.xsdCategoryLabels = { msgtype: "Message types", data: "Message data", enum: "Enumerations", id: "ID types", choice: "Choice types", base: "Base / abstract", complex: "Other complex", simple: "Other simple" };

  /* Last PascalCase word, for grouping long lists of message names (…Status, …Command, …Request). */
  lib.xsdFamily = name => { const m = name.match(/[A-Z][a-z0-9]*$|[A-Z]+$/); return m ? m[0] : "Other"; };

  /* Messages (global elements) that include `typeName` somewhere in their structure, found by walking the reverse indexes. */
  lib.xsdMessagesUsing = function (model, typeName, limit = 500) {
    const roots = new Set(model.elements.keys()), byType = model.elementsOfType;
    const seen = new Set([typeName]), queue = [typeName], found = new Set();
    while (queue.length && found.size < limit) {
      const t = queue.shift();
      for (const e of byType.get(t) || []) found.add(e);
      for (const u of model.usedBy.get(t) || []) if (!seen.has(u.owner)) { seen.add(u.owner); queue.push(u.owner); }
      for (const d of model.derived.get(t) || []) if (!seen.has(d)) { seen.add(d); queue.push(d); }
    }
    return [...found].filter(e => roots.has(e)).sort();
  };
  /* Every type that `typeName` is built from, to `depth` levels (members' types and base types). */
  lib.xsdDependencies = function (model, typeName, depth = 50) {
    const seen = new Set([typeName]); let frontier = [typeName];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const n of frontier) {
        const t = model.types.get(n); if (!t) continue;
        const refs = t.parts.map(p => p.type).concat(t.base ? [t.base] : [], t.itemType ? [t.itemType] : [], t.memberTypes || []);
        for (const r of refs) if (r && model.types.has(r) && !seen.has(r)) { seen.add(r); next.push(r); }
      }
      frontier = next;
    }
    seen.delete(typeName);
    return [...seen];
  };

  /* ---- search --------------------------------------------------------------------------------- */

  /* Build once per model. entries: elements, types, members and enumeration values. */
  lib.xsdIndex = function (model) {
    const entries = [];
    const words = n => " " + String(n).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase();
    const add = o => { o.nameL = String(o.name).toLowerCase(); o.wL = words(o.name); o.docL = (o.docL || "").toLowerCase(); entries.push(o); };
    for (const e of model.elements.values()) add({ kind: "element", name: e.name, type: e.type, owner: "", docL: e.doc });
    for (const t of model.types.values()) {
      add({ kind: "type", name: t.name, docL: t.doc, cat: lib.xsdCategory(model, t), tk: t.kind });
      for (const p of t.parts) if (p.kind === "element" || p.kind === "attribute") add({ kind: "member", name: p.name, owner: t.name, type: p.type, docL: p.doc });
      if (t.facets && t.facets.enumeration) for (const v of t.facets.enumeration) add({ kind: "value", name: v.value, owner: t.name, docL: v.doc });
    }
    return entries;
  };

  /* Ranked search. opts: { docs, kinds:Set, cat, limit }. All whitespace-separated terms must match.
     Rank: exact name, prefix, word start, substring, then documentation-only matches. */
  lib.xsdSearch = function (index, query, { docs = false, kinds = null, cat = null, filter = null, limit = 250 } = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    for (const e of index) {
      if (kinds && !kinds.has(e.kind)) continue;
      if (cat && !(e.kind === "type" && e.cat === cat)) continue;
      if (filter && !filter(e)) continue;
      let score = 0, ok = true;
      for (const term of terms) {
        let s;
        if (e.nameL === term) s = 0;
        else if (e.nameL.startsWith(term)) s = 1;
        else if (e.wL.includes(" " + term)) s = 2;
        else if (e.nameL.includes(term)) s = 3;
        else if (docs && e.docL.includes(term)) s = 5;
        else { ok = false; break; }
        score += s;
      }
      if (ok) scored.push([score + (e.kind === "member" ? 0.4 : e.kind === "value" ? 0.6 : 0), e]);
    }
    // with no search terms there is nothing to rank by: list alphabetically
    scored.sort(terms.length
      ? (a, b) => a[0] - b[0] || String(a[1].name).length - String(b[1].name).length || String(a[1].name).localeCompare(String(b[1].name))
      : (a, b) => String(a[1].name).localeCompare(String(b[1].name)));
    return { results: scored.slice(0, limit).map(x => x[1]), total: scored.length };
  };
})();
