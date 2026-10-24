/* Schema-aware decoding of XML payloads (built for UCI, works with any XSD set): no DOM, pure functions on DT.lib.
   The schema is whatever model the user loaded (xsd-model.js), so any UCI version works. Messages are matched by the
   local name of their root element; namespaces are compared and reported, never required. */
(function () {
  const lib = DT.lib;
  const local = n => n.replace(/^[^:]+:/, "");
  const STRICT = new TextDecoder("utf-8", { fatal: true });
  const SKIP_ATTR = k => k === "xmlns" || k.startsWith("xmlns:") || /^xsi:/.test(k);

  /* Namespace of an element: its own default / prefix declaration, else the root's. */
  function nsOf(el, root) {
    const i = el.name.indexOf(":"), key = i < 0 ? "xmlns" : "xmlns:" + el.name.slice(0, i);
    for (const e of [el, root]) { const a = e.attrs.find(x => x[0] === key); if (a) return a[1]; }
    return "";
  }

  /* Line/column of character offsets, in O(log n) each. */
  function lineIndex(text) {
    const starts = [0];
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
    return pos => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return { line: lo + 1, col: pos - starts[lo] + 1 }; };
  }

  lib.uciFirstPara = d => (d || "").split(/\n\s*\n/)[0].trim();

  /* Documentation of an enumeration value, searching the type and its bases. */
  lib.uciEnumDoc = function (model, typeName, value) {
    const seen = new Set();
    for (let t = model.types.get(typeName); t && !seen.has(t.name); t = t.base ? model.types.get(t.base) : null) {
      seen.add(t.name);
      const en = t.facets && t.facets.enumeration;
      if (en) { const e = en.find(x => x.value === value); return e ? e.doc || "" : null; }   // null: the value is not in the enumeration
    }
    return undefined;                                                                      // the type is not an enumeration
  };

  /* Annotate an element tree with what the schema says about each node:
     { name, local, type, doc, path, text, attrs:[{name,value,type,doc,known}], kids, known, enumDoc, enumBad, occurs, pos } */
  lib.uciAnnotate = function (model, rootEl, decl) {
    function build(el, typeName, doc, path, occurs, known) {
      const xt = el.attrs.find(([k, v]) => /:type$/.test(k) && model.types.has(local(v)));
      const tn = xt ? local(xt[1]) : typeName;
      const t = model.types.get(tn);
      const complex = t && t.kind === "complex";
      const members = complex ? lib.xsdMembers(model, tn) : [];
      const elMembers = new Map(), attMembers = new Map();
      for (const m of members) { if (m.kind === "element" && !elMembers.has(m.name)) elMembers.set(m.name, m); else if (m.kind === "attribute") attMembers.set(m.name, m); }
      const n = { name: el.name, local: local(el.name), type: tn || "", doc: doc || (t && t.doc) || "", path, occurs, known, pos: el.pos, kids: [], attrs: [], text: "" };
      n.text = el.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join("").trim();
      for (const [k, v] of el.attrs) {
        if (SKIP_ATTR(k)) continue;
        const m = attMembers.get(local(k));
        n.attrs.push({ name: k, value: v, type: m ? m.type : "", doc: m ? m.doc : "", known: !complex || !!m || !known });
      }
      const kids = el.kids.filter(k => k.t === "el"), seen = new Map();
      if (!kids.length && n.text && t && (t.kind === "simple" || t.simpleContent)) {
        const ed = lib.uciEnumDoc(model, tn, n.text);
        if (ed !== undefined) { n.isEnum = true; n.enumDoc = ed || ""; n.enumBad = ed === null; }
      }
      for (const c of kids) {
        const ln = local(c.name), i = (seen.get(ln) || 0) + 1; seen.set(ln, i);
        const m = elMembers.get(ln);
        const same = kids.filter(k => local(k.name) === ln).length;
        const p = path + "/" + ln + (same > 1 ? `[${i}]` : "");
        if (m) n.kids.push(build(c, m.type, m.doc, p, lib.xsdFmtOccurs(m.min, m.max), known));
        else n.kids.push(build(c, "", "", p, "", false));
      }
      return n;
    }
    return build(rootEl, decl.type, decl.doc, "/" + local(rootEl.name), "", true);
  };

  /* Identifying fields for the summary line: the leaves of MessageHeader (UCI) when there is one, else the first leaves of the root. */
  lib.uciFacts = function (node, limit = 14) {
    const out = [];
    const leaves = (n, prefix) => { if (out.length >= limit) return; if (!n.kids.length) { if (n.text) out.push([prefix || n.local, n.text]); return; } for (const k of n.kids) leaves(k, prefix ? prefix + "/" + k.local : k.local); };
    const hdr = node.kids.find(k => k.local === "MessageHeader");
    if (hdr) for (const k of hdr.kids) leaves(k, k.local);
    else for (const k of node.kids.slice(0, 6)) leaves(k, k.local);
    return out;
  };

  /* Nearest global elements to a name that is not in the schema (substring, then edit distance). */
  lib.uciSuggest = function (model, name, limit = 6) {
    const lo = name.toLowerCase(), names = [...model.elements.keys()];
    const lev = (a, b) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } } return d[b.length]; };
    const scored = [];
    for (const n of names) {
      const l = n.toLowerCase();
      if (l.includes(lo) || lo.includes(l)) scored.push([0, n]);
      else if (Math.abs(l.length - lo.length) <= 4) { const d = lev(l, lo); if (d <= 4) scored.push([d, n]); }
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, limit).map(x => x[1]);
  };

  /* Decode an XML payload against the model (model may be null: then only the XML structure is returned).
     -> null when the text does not look like XML; { xml:false, error } for broken XML; otherwise
        { xml:true, tree, rootName, ns, known, msgName?, wrapped?, schemaNs?, nsMatch?, node?, facts?, validation?, suggest? } */
  lib.uciDecode = function (model, text, { validate = false } = {}) {
    if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]{0,400}?-->\s*)*<[A-Za-z_]/.test(text.slice(0, 1500))) return null;
    let tree;
    try { tree = lib.xmlParse(text); } catch (e) { return { xml: false, error: e.message, line: e.line, col: e.col }; }
    const out = { xml: true, tree, rootName: local(tree.root.name), ns: nsOf(tree.root, tree.root), known: false };
    if (!model) return out;
    let el = tree.root, decl = model.elements.get(out.rootName);
    if (!decl) {                                                      // a wrapper around a known message
      const k = el.kids.find(x => x.t === "el" && model.elements.has(local(x.name)));
      if (k) { out.wrapped = out.rootName; el = k; decl = model.elements.get(local(k.name)); }
    }
    if (!decl) { out.suggest = lib.uciSuggest(model, out.rootName); return out; }
    const f = model.files.find(x => x.name === decl.file);
    Object.assign(out, { known: true, msgName: decl.name, decl, element: el, ns: nsOf(el, tree.root), schemaNs: f ? f.targetNamespace : "", schemaVersion: decl.version || (f && f.version) || "" });
    out.nsMatch = out.ns === out.schemaNs;
    out.node = lib.uciAnnotate(model, el, decl);
    out.facts = lib.uciFacts(out.node);
    if (validate && !out.wrapped) {
      const v = lib.xsdValidate(model, text), at = lineIndex(text);
      out.validation = v;
      out.errorAt = new Map();
      for (const e of v.errors) { const k = e.line + ":" + e.col; (out.errorAt.get(k) || out.errorAt.set(k, []).get(k)).push(e); }
      (function mark(n) { const p = at(n.pos || 0); n.line = p.line; n.col = p.col; n.errors = out.errorAt.get(p.line + ":" + p.col) || []; n.kids.forEach(mark); })(out.node);
    }
    return out;
  };

  /* Numeric leaves of a JSON or XML payload as Map(path -> number), for plotting. JSON paths look like a.b[0].c,
     XML paths like /Root/Child[2]/@attr (an index only appears when a name repeats among its siblings). */
  lib.natsNumericFields = function (bytes, limit = 400) {
    const out = new Map();
    let text; try { text = STRICT.decode(bytes); } catch (_) { return out; }
    const t = text.trim(), add = (p, v) => { if (out.size < limit) out.set(p, v); };
    const isNum = s => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s);
    if (t[0] === "{" || t[0] === "[") {
      try {
        (function walk(v, p) {
          if (typeof v === "number" && isFinite(v)) add(p || "(value)", v);
          else if (Array.isArray(v)) v.slice(0, 16).forEach((x, i) => walk(x, p + "[" + i + "]"));
          else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], p ? p + "." + k : k);
        })(JSON.parse(t), "");
      } catch (_) { /* not JSON */ }
    } else if (t[0] === "<") {
      try {
        (function walk(e, p) {
          const kids = e.kids.filter(k => k.t === "el"), counts = new Map();
          for (const k of kids) counts.set(local(k.name), (counts.get(local(k.name)) || 0) + 1);
          for (const [k, v] of e.attrs) if (!SKIP_ATTR(k) && isNum(v.trim())) add(p + "/@" + k, +v);
          if (!kids.length) { const tx = e.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join("").trim(); if (isNum(tx)) add(p, +tx); return; }
          const seen = new Map();
          for (const k of kids) { const ln = local(k.name), i = (seen.get(ln) || 0) + 1; seen.set(ln, i); walk(k, p + "/" + ln + (counts.get(ln) > 1 ? `[${i}]` : "")); }
        })(lib.xmlParse(t).root, "/" + local(lib.xmlParse(t).root.name));
      } catch (_) { /* not XML */ }
    } else if (isNum(t)) out.set("(value)", +t);
    return out;
  };

  /* A sample message for a global element, as XML text. */
  lib.uciSample = (model, name, { all = false } = {}) => lib.xsdSkeleton(model, name, { all, hints: false }).xml;

  /* ---- the decoded-message view (tree, docs, enum meanings, validation errors), shared by the NATS and CAL explorers ---- */
  const esc = DT.esc;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const plainNode = (e, path) => ({ name: e.name, local: local(e.name), type: "", doc: "", path, occurs: "", known: true, errors: [], pos: e.pos,
    text: e.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join("").trim(),
    attrs: e.attrs.filter(([k]) => k !== "xmlns" && !k.startsWith("xmlns:")).map(([k, v]) => ({ name: k, value: v, known: true })),
    kids: e.kids.filter(k => k.t === "el").map(c => plainNode(c, path + "/" + local(c.name))) });

  function renderNode(n, depth, expandTo, locs) {
    const wrap = el("div"), row = el("div", "row"), open = depth < expandTo, hasKids = n.kids.length > 0;
    const tg = el("span", "tg", hasKids ? (open ? "▾" : "▸") : "");
    const nm = el("span", "nm" + (n.known ? "" : " unk"), n.local); nm.title = n.path + (n.known ? "" : "\nNot defined here by the loaded schema.");
    row.append(tg, nm);
    for (const a of n.attrs) { const s = el("span", "ty"); s.append("@" + a.name + "="); const v = el("span", "vl" + (a.known ? "" : " unk"), a.value); if (!a.known) v.title = "Attribute not defined by the loaded schema."; s.append(v); row.append(s); }
    if (!hasKids && n.text) {
      row.append(el("span", "vl", "= " + (n.text.length > 300 ? n.text.slice(0, 300) + "…" : n.text)));
      if (n.isEnum) { const full = lib.uciFirstPara(n.enumDoc || ""), short = full.length > 110 ? (/^.{40,110}?[.;]/.exec(full) || [full.slice(0, 107) + "…"])[0] : full; const ed = el("span", n.enumBad ? "ed bad" : "ed", n.enumBad ? "✗ not one of the allowed values" : short ? "— " + short : ""); if (full.length > short.length) ed.title = full; row.append(ed); }
    }
    if (n.type) row.append(el("span", "ty", ": " + n.type));
    if (n.occurs && n.occurs !== "1..1") row.append(el("span", "oc", "[" + n.occurs + "]"));
    wrap.append(row);
    const dc = el("div", "dc", n.doc ? n.doc : ""); dc.hidden = true; wrap.append(dc);
    for (const e of n.errors || []) wrap.append(el("div", "errl", (locs ? `line ${e.line}, col ${e.col}: ` : "") + e.message));
    if (hasKids) {
      const kids = el("div", "kids"); kids.hidden = !open;
      for (const k of n.kids) kids.append(renderNode(k, depth + 1, expandTo, locs));
      wrap.append(kids);
      tg.onclick = () => { kids.hidden = !kids.hidden; tg.textContent = kids.hidden ? "▸" : "▾"; };
    }
    if (n.doc) { nm.style.cursor = "pointer"; nm.onclick = () => { dc.hidden = !dc.hidden; }; }
    return wrap;
  }

  lib.uciView = uciView;
  function uciView(d, model, opts = {}) {
    const locs = opts.locs !== false;
    const box = el("div", "uci");
    if (!d.xml) { box.append(el("div", "status err", "Not well-formed XML: " + d.error)); return box; }
    const head = el("div", "opts"); head.style.margin = "0 0 6px";
    const badge = (cls, text, title) => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
    let bits = "";
    if (d.known) {
      const v = d.validation;
      bits += `<b style="font-size:16px">${esc(d.msgName)}</b>` + badge("info", lib.xsdFamily(d.msgName));
      if (v) bits += v.ok ? badge("ok", "schema-valid") : badge("err", `${v.errors.length}${v.truncated ? "+" : ""} schema error${v.errors.length === 1 ? "" : "s"}`);
      else if (d.wrapped) bits += badge("warn", `wrapped in <${d.wrapped}>, not validated`);
      bits += d.nsMatch ? badge("ok", "namespace matches", d.ns) : badge("warn", "namespace differs", `message: ${d.ns || "(none)"}\nschema: ${d.schemaNs || "(none)"}\nA different schema version, or a missing xmlns.`);
      if (d.schemaVersion) bits += badge("info", "schema " + d.schemaVersion);
    } else bits += `<b style="font-size:16px">&lt;${esc(d.rootName)}&gt;</b>` + (model ? badge("warn", "not in the loaded schema") : badge("info", "no schema loaded"));
    head.innerHTML = bits; box.append(head);
    if (d.known) { const p = lib.uciFirstPara(d.decl.doc || (model.types.get(d.decl.type) || {}).doc); if (p) box.append(el("div", "doc-block", p)); }
    else if (model && d.suggest && d.suggest.length) box.append(el("div", "hint", `Closest message names in the schema: ${d.suggest.join(", ")}. A different UCI version may have renamed it; load that version's schema above.`));
    else if (!model) box.append(el("div", "hint", "Load the schema above to see message documentation, types, enumeration meanings and validation."));
    if (d.facts && d.facts.length) box.insertAdjacentHTML("beforeend", DT.kv(d.facts));
    if (d.validation && !d.validation.ok) {
      const list = el("div", "errlist"); list.style.margin = "8px 0";
      for (const e of d.validation.errors.slice(0, 25)) { const r = el("div", "er"); r.append(el("span", "ln", locs ? `${e.line}:${e.col}` : ""), el("span", "ms", e.message), el("span", "pa", e.path || "")); list.append(r); }
      if (d.validation.errors.length > 25) list.append(el("div", "hint", `…and ${d.validation.errors.length - 25} more.`));
      box.append(list);
    }
    if (d.validation && d.validation.warnings && Array.from(d.validation.warnings).length) box.append(el("div", "hint", Array.from(d.validation.warnings).slice(0, 3).join(" ")));
    const bar = el("div", "btns"), ex = el("button", "btn", "Expand all"), co = el("button", "btn", "Collapse all");
    ex.type = co.type = "button"; bar.append(ex, co); box.append(bar);
    const tree = el("div", "ux"), n = d.node || plainNode(d.tree.root, "/" + d.rootName);
    tree.append(renderNode(n, 0, 3, locs)); box.append(tree);
    const rootKids = tree.querySelector(".kids"), rootTg = tree.querySelector(".row .tg");
    const setAll = openIt => { tree.querySelectorAll(".kids").forEach(k => { k.hidden = !openIt && k !== rootKids; }); tree.querySelectorAll(".row .tg").forEach(t => { if (t.textContent) t.textContent = openIt || t === rootTg ? "▾" : "▸"; }); };
    ex.onclick = () => setAll(true); co.onclick = () => setAll(false);
    return box;
  }


})();
