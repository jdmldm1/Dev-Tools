/* Validate an XML instance against a loaded XSD model (see xsd-model.js).

   Supported: element/type resolution, sequence / choice / group occurrence counts (via regular-expression derivatives, so errors say
   exactly what was expected next), extension and restriction chains, substitution groups, xsi:type and xsi:nil, attributes (required,
   unknown, simple-typed), and simple types with enumeration, pattern, length, min/max and digit facets, lists and unions.
   Approximations: xs:all is treated as "any order, any number up to the total"; xs:any wildcards accept any element; key/keyref/unique
   identity constraints and XSD 1.1 assertions are not checked. For formal conformance, also run xmllint or .NET (see the XML sheet). */
(function () {
  const lib = DT.lib;
  const local = n => (n || "").replace(/^[^:]+:/, "");
  const XSI = "http://www.w3.org/2001/XMLSchema-instance";

  /* ---- content-model algebra ------------------------------------------------------------------- */
  const EMPTY = { t: "empty" }, FAIL = { t: "fail" };
  const mkSeq = items => {
    const out = [];
    for (const i of items) { if (i === FAIL) return FAIL; if (i === EMPTY) continue; if (i.t === "seq") out.push(...i.items); else out.push(i); }
    return out.length === 0 ? EMPTY : out.length === 1 ? out[0] : { t: "seq", items: out };
  };
  const mkAlt = items => {
    const out = []; let sawEmpty = false;
    for (const i of items) {
      if (i === FAIL) continue;
      if (i === EMPTY) { if (!sawEmpty) { sawEmpty = true; out.push(i); } continue; }
      if (i.t === "alt") { for (const j of i.items) { if (j === EMPTY) { if (!sawEmpty) { sawEmpty = true; out.push(j); } } else out.push(j); } } else out.push(i);
    }
    return out.length === 0 ? FAIL : out.length === 1 ? out[0] : { t: "alt", items: out };
  };
  const mkRep = (item, min, max) => {
    if (max === 0 || item === EMPTY) return EMPTY;
    if (item === FAIL) return min === 0 ? EMPTY : FAIL;
    if (min === 1 && max === 1) return item;
    return { t: "rep", item, min, max };
  };
  const nullable = r => {
    switch (r.t) {
      case "empty": return true;
      case "all": return r.items.every((it, i) => r.counts[i] >= it.min);
      case "fail": case "el": case "any": return false;
      case "seq": return r.items.every(nullable);
      case "alt": return r.items.some(nullable);
      case "rep": return r.min === 0 || nullable(r.item);
    }
  };
  /* Residual content model after consuming one element named `name`. */
  const deriv = (r, name) => {
    switch (r.t) {
      case "empty": case "fail": return FAIL;
      case "el": return r.name === name ? EMPTY : FAIL;
      case "any": return EMPTY;
      case "all": {   // xs:all: each member any order, within its own min/max
        const idx = r.items.findIndex((it, i) => it.names.includes(name) && r.counts[i] < it.max);
        return idx < 0 ? FAIL : { t: "all", items: r.items, counts: r.counts.map((c, j) => j === idx ? c + 1 : c) };
      }
      case "alt": return mkAlt(r.items.map(i => deriv(i, name)));
      case "seq": {
        const [a, ...rest] = r.items, restNode = mkSeq(rest);
        const d = mkSeq([deriv(a, name), restNode]);
        return nullable(a) ? mkAlt([d, deriv(restNode, name)]) : d;
      }
      case "rep": {
        const d = deriv(r.item, name);
        if (d === FAIL) return FAIL;
        return mkSeq([d, mkRep(r.item, Math.max(r.min - 1, 0), r.max === Infinity ? Infinity : r.max - 1)]);
      }
    }
  };
  /* Element names that may come next. "*" means a wildcard is allowed. */
  const first = (r, out = new Set()) => {
    switch (r.t) {
      case "el": out.add(r.name); break;
      case "any": out.add("*"); break;
      case "all": r.items.forEach((it, i) => { if (r.counts[i] < it.max) it.names.forEach(n => out.add(n)); }); break;
      case "alt": r.items.forEach(i => first(i, out)); break;
      case "seq": for (const i of r.items) { first(i, out); if (!nullable(i)) break; } break;
      case "rep": if (r.max > 0) first(r.item, out); break;
    }
    return out;
  };
  lib.xsdAlgebra = { EMPTY, FAIL, deriv, nullable, first, mkSeq, mkAlt, mkRep };

  /* ---- effective content of a type ---------------------------------------------------------------- */

  function substitutesOf(model, name, seen = new Set()) {
    const out = [];
    for (const s of model.substitutes.get(name) || []) if (!seen.has(s)) { seen.add(s); out.push(s, ...substitutesOf(model, s, seen)); }
    return out;
  }

  /* Names an element particle can appear under (itself, unless abstract, plus substitution-group members); registers their types. */
  function elementNames(model, p, elems) {
    const head = p.ref ? model.elements.get(p.name) : null;
    const type = p.type || (head && head.type) || "anyType";
    const abstract = p.abstract || (head && head.abstract);
    const names = (abstract ? [] : [p.name]).concat(substitutesOf(model, p.name));
    for (const n of names) {
      const decl = model.elements.get(n), own = n === p.name;
      elems.set(n, { type: own ? type : (decl ? decl.type : type), nillable: p.nillable || (decl && decl.nillable), ns: own ? lib.xsdElementNs(model, p) : lib.xsdElementNs(model, decl || p, true) });
    }
    return names;
  }

  function build(model, p, elems, depth) {
    if (!p || depth > 60) return EMPTY;
    const wrap = n => mkRep(n, p.min, p.max);
    switch (p.k) {
      case "seq": return wrap(mkSeq(p.items.map(i => build(model, i, elems, depth + 1))));
      case "choice": return wrap(mkAlt(p.items.map(i => build(model, i, elems, depth + 1))));
      case "all": {
        const items = p.items.filter(i => i.k === "el").map(i => ({ names: elementNames(model, i, elems), min: i.min, max: i.max }));
        return wrap({ t: "all", items, counts: items.map(() => 0) });
      }
      case "group": { const g = model.groups.get(p.ref); return g ? wrap(build(model, g.particle, elems, depth + 1)) : EMPTY; }
      case "any": return wrap({ t: "any" });
      case "el": {
        const names = elementNames(model, p, elems);
        return wrap(names.length === 1 ? { t: "el", name: names[0] } : mkAlt(names.map(n => ({ t: "el", name: n }))));
      }
    }
    return EMPTY;
  }

  lib.xsdEffective = function (model, typeName) {
    const cache = model._eff || (model._eff = new Map());
    if (cache.has(typeName)) return cache.get(typeName);
    const t = model.types.get(typeName);
    if (!t) { cache.set(typeName, null); return null; }
    const chain = lib.xsdChain(model, typeName), elems = new Map();
    const content = mkSeq(chain.map(c => c.content ? build(model, c.content, elems, 0) : EMPTY));
    const attrs = new Map(); let anyAttribute = false;
    const addAttr = a => attrs.set(a.name, a);
    for (const c of chain) {
      anyAttribute = anyAttribute || c.anyAttribute;
      for (const a of c.attributes) {
        if (a.group) { const g = model.attributeGroups.get(a.group); if (g) g.attributes.forEach(x => addAttr(resolveAttr(model, x))); }
        else addAttr(resolveAttr(model, a));
      }
    }
    const eff = { type: t, chain, content, elems, attributes: [...attrs.values()], anyAttribute, mixed: chain.some(c => c.mixed), abstract: t.abstract,
      empty: t.kind === "complex" && !t.simpleContent && chain.every(c => !c.content) };      // no content model at all: not even whitespace is allowed
    cache.set(typeName, eff);
    return eff;
  }
  const resolveAttr = (model, a) => a.ref && model.attributes.has(a.name) ? { ...model.attributes.get(a.name), use: a.use || "optional" } : a;

  lib.xsdDerivesFrom = function (model, typeName, ancestor) {
    const seen = new Set();
    for (let n = typeName; n && !seen.has(n); n = (model.types.get(n) || {}).base) { if (n === ancestor) return true; seen.add(n); }
    return ancestor === "anyType";
  };

  /* ---- simple types ---------------------------------------------------------------------------------- */

  /* Resolve a simple type to { builtin, facets, patterns:[[alternatives]], list?, union?, enumeration? } */
  lib.xsdSimpleInfo = function (model, name, depth = 0) {
    const cache = model._simple || (model._simple = new Map());
    if (cache.has(name)) return cache.get(name);
    let info;
    const bn = local(name);
    if (!name || depth > 40) info = { builtin: "anySimpleType", facets: {}, patterns: [] };
    else if (lib.xsdIsBuiltin(bn) && !model.types.has(name)) info = { builtin: bn, facets: {}, patterns: [] };
    else {
      const t = model.types.get(name);
      if (!t) info = { builtin: "anySimpleType", facets: {}, patterns: [], unknown: true };
      else if (t.simpleKind === "list") info = { builtin: "list", list: lib.xsdSimpleInfo(model, t.itemType, depth + 1), facets: { ...t.facets }, patterns: [] };
      else if (t.simpleKind === "union") info = { builtin: "union", union: t.memberTypes.map(m => lib.xsdSimpleInfo(model, m, depth + 1)), facets: {}, patterns: [] };
      else {
        const parent = t.base ? lib.xsdSimpleInfo(model, t.base, depth + 1) : { builtin: "anySimpleType", facets: {}, patterns: [] };
        const f = { ...parent.facets };
        for (const [k, v] of Object.entries(t.facets)) if (k !== "pattern" && k !== "enumeration") f[k] = v;
        info = { ...parent, name, facets: f, patterns: t.facets.pattern ? [...parent.patterns, t.facets.pattern] : parent.patterns,
          enumeration: t.facets.enumeration ? t.facets.enumeration.map(e => e.value) : parent.enumeration };
      }
    }
    cache.set(name, info);
    return info;
  };

  const INT = { byte: [-128n, 127n], short: [-32768n, 32767n], int: [-2147483648n, 2147483647n], long: [-(2n ** 63n), 2n ** 63n - 1n],
    unsignedByte: [0n, 255n], unsignedShort: [0n, 65535n], unsignedInt: [0n, 4294967295n], unsignedLong: [0n, 2n ** 64n - 1n],
    integer: [null, null], nonNegativeInteger: [0n, null], positiveInteger: [1n, null], nonPositiveInteger: [null, 0n], negativeInteger: [null, -1n] };
  const TZ = "(Z|[+-]\\d{2}:\\d{2})?";
  const LEX = {
    boolean: /^(true|false|1|0)$/,
    decimal: /^[+-]?(\d+(\.\d*)?|\.\d+)$/,
    float: /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/,
    dateTime: new RegExp(`^-?\\d{4,}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?${TZ}$`),
    date: new RegExp(`^-?\\d{4,}-\\d{2}-\\d{2}${TZ}$`),
    time: new RegExp(`^\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?${TZ}$`),
    gYear: new RegExp(`^-?\\d{4,}${TZ}$`), gYearMonth: new RegExp(`^-?\\d{4,}-\\d{2}${TZ}$`), gMonthDay: new RegExp(`^--\\d{2}-\\d{2}${TZ}$`),
    gDay: new RegExp(`^---\\d{2}${TZ}$`), gMonth: new RegExp(`^--\\d{2}${TZ}$`),
    duration: /^-?P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
    hexBinary: /^([0-9a-fA-F]{2})*$/,
    base64Binary: /^[A-Za-z0-9+/\s]*={0,2}\s*$/,
    NCName: /^[A-Za-z_][\w.-]*$/, Name: /^[A-Za-z_:][\w.:-]*$/, QName: /^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/,
    language: /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/, NMTOKEN: /^[\w.:-]+$/,
  };
  LEX.double = LEX.float; LEX.ID = LEX.IDREF = LEX.ENTITY = LEX.NCName;

  const daysIn = (y, m) => m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  function dateOk(s) {
    const m = /^(-?\d{4,})-(\d{2})-(\d{2})/.exec(s); if (!m) return true;
    const y = +m[1], mo = +m[2], d = +m[3];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
  }
  function timeOk(s) {
    const m = /(\d{2}):(\d{2}):(\d{2})(\.\d+)?/.exec(s); if (!m) return true;
    const h = +m[1], mi = +m[2], se = +m[3];
    return (h < 24 && mi < 60 && se < 60) || (h === 24 && mi === 0 && se === 0 && !m[4]);
  }

  /* -> { err } or { num } (number or BigInt for numeric types) */
  function checkBuiltin(b, v) {
    if (INT[b]) {
      if (!/^[+-]?\d+$/.test(v)) return { err: `"${v}" is not a valid xs:${b} (whole number expected)` };
      if (/^unsigned/.test(b) && v[0] === "+") return { err: `"${v}" is not a valid xs:${b} (a leading "+" is rejected by .NET and several other validators; remove it)` };
      const n = BigInt(v), [lo, hi] = INT[b];
      if ((lo !== null && n < lo) || (hi !== null && n > hi)) return { err: `${v} is outside the range of xs:${b}${lo !== null && hi !== null ? ` (${lo} to ${hi})` : lo !== null ? ` (min ${lo})` : ` (max ${hi})`}` };
      return { num: n };
    }
    if (LEX[b]) {
      if (!LEX[b].test(v)) return { err: `"${v}" is not a valid xs:${b}` };
      if (b === "base64Binary") { const c = v.replace(/\s+/g, ""); if (c.length % 4) return { err: `"${v}" is not a valid xs:base64Binary (length must be a multiple of 4)` }; }
      if ((b === "date" || b === "dateTime") && !dateOk(v)) return { err: `"${v}" is not a real calendar date` };
      if ((b === "time" || b === "dateTime") && !timeOk(v)) return { err: `"${v}" is not a valid time of day` };
      if ((b === "time" || b === "dateTime") && /(^|T)24:00:00/.test(v)) return { err: `"${v}" uses 24:00:00, which XSD 1.0 allows but .NET and other validators reject; use 00:00:00 of the next day` };
      if (b === "decimal" || b === "float" || b === "double") return { num: v === "NaN" ? NaN : /INF/.test(v) ? (v[0] === "-" ? -Infinity : Infinity) : Number(v) };
    }
    return {};
  }
  const WS_COLLAPSE = new Set(["token", "language", "NMTOKEN", "Name", "NCName", "ID", "IDREF", "ENTITY", "QName"]);
  const NUMERIC = b => INT[b] || b === "decimal" || b === "float" || b === "double";
  const stringy = b => !NUMERIC(b) && !["boolean", "dateTime", "date", "time", "duration", "hexBinary", "base64Binary"].includes(b);
  const cmpNum = (a, b) => (typeof a === "bigint" && typeof b === "bigint") ? (a < b ? -1 : a > b ? 1 : 0) : (Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0);
  const parseFacetNum = (b, s) => { try { return INT[b] ? BigInt(s) : Number(s); } catch (_) { return Number(s); } };

  const patCache = new Map();
  function compilePattern(p) {
    if (patCache.has(p)) return patCache.get(p);
    let re = null;
    for (const flags of ["u", ""]) { try { re = new RegExp("^(?:" + p + ")$", flags); break; } catch (_) { /* try the next dialect */ } }
    patCache.set(p, re);
    return re;
  }

  /* -> error message or null. `notes` collects non-fatal limitations (e.g. unsupported pattern syntax). */
  lib.xsdCheckValue = function (model, info, raw, notes = []) {
    const b = info.builtin;
    if (b === "anySimpleType" || b === "anyType") return null;
    const wsMode = info.facets.whiteSpace || (b === "string" ? "preserve" : b === "normalizedString" ? "replace" : (!stringy(b) || WS_COLLAPSE.has(b) || b === "list" || b === "union") ? "collapse" : "preserve");
    let v = raw;
    if (wsMode !== "preserve") v = v.replace(/[\t\n\r]/g, " ");
    if (wsMode === "collapse") v = v.replace(/ +/g, " ").trim();
    const lengthErr = (len, what) => {
      const f = info.facets;
      if (f.length !== undefined && len !== +f.length) return `${what} ${len} is not the required length ${f.length}`;
      if (f.minLength !== undefined && len < +f.minLength) return `${what} ${len} is shorter than minLength ${f.minLength}`;
      if (f.maxLength !== undefined && len > +f.maxLength) return `${what} ${len} is longer than maxLength ${f.maxLength}`;
      return null;
    };
    if (b === "list") {
      const items = v === "" ? [] : v.split(" ");
      const le = lengthErr(items.length, "list length"); if (le) return le;
      for (const it of items) { const e = lib.xsdCheckValue(model, info.list, it, notes); if (e) return `list item: ${e}`; }
      return null;
    }
    if (b === "union") {
      const errs = [];
      for (const m of info.union) { const e = lib.xsdCheckValue(model, m, raw, notes); if (!e) return null; errs.push(e); }
      return `"${v}" matches none of the union's member types (${errs[0]}${errs.length > 1 ? "; …" : ""})`;
    }
    const c = checkBuiltin(b, v);
    if (c.err) return c.err;
    const f = info.facets;
    if (info.enumeration) {
      const hit = info.enumeration.some(e => e === v || (NUMERIC(b) && c.num !== undefined && cmpNum(c.num, parseFacetNum(b, e)) === 0) || (b === "boolean" && (e === "1") === (v === "true" || v === "1")));
      if (!hit) { const n = info.enumeration.length; return `"${v}" is not one of the ${n} allowed value${n === 1 ? "" : "s"}: ${info.enumeration.slice(0, 12).join(", ")}${n > 12 ? ", …" : ""}`; }
    }
    for (const group of info.patterns) {
      let ok = false, usable = false;
      for (const p of group) { const re = compilePattern(p); if (re) { usable = true; if (re.test(v)) { ok = true; break; } } }
      if (!usable) { notes.push(`Pattern "${group[0]}" uses syntax this tool cannot evaluate; it was not checked.`); continue; }
      if (!ok) {
        const pat = group.map(g => `"${g.length > 90 ? g.slice(0, 87) + "…" : g}"`).join(" or ");
        return `"${v.length > 60 ? v.slice(0, 57) + "…" : v}" does not match the pattern ${pat}${info.name ? ` of ${info.name}` : ""}`;
      }
    }
    if (stringy(b) || b === "hexBinary" || b === "base64Binary") {
      const len = b === "hexBinary" ? v.length / 2 : b === "base64Binary" ? Math.floor(v.replace(/\s+/g, "").replace(/=+$/, "").length * 3 / 4) : [...v].length;
      const le = lengthErr(len, b === "hexBinary" || b === "base64Binary" ? "byte length" : "length"); if (le) return le;
    }
    if (c.num !== undefined) {
      for (const [k, op] of [["minInclusive", x => x >= 0], ["maxInclusive", x => x <= 0], ["minExclusive", x => x > 0], ["maxExclusive", x => x < 0]]) {
        if (f[k] !== undefined && !op(cmpNum(c.num, parseFacetNum(b, f[k])))) return `${v} violates ${k} ${f[k]}`;
      }
      if (f.totalDigits !== undefined || f.fractionDigits !== undefined) {
        const [ip, fp = ""] = v.replace(/^[+-]/, "").split("."), frac = fp.replace(/0+$/, ""), total = (ip.replace(/^0+/, "") + frac).length || 1;
        if (f.totalDigits !== undefined && total > +f.totalDigits) return `${v} has more than totalDigits ${f.totalDigits} digits`;
        if (f.fractionDigits !== undefined && frac.length > +f.fractionDigits) return `${v} has more than fractionDigits ${f.fractionDigits} decimals`;
      }
    }
    return null;
  };

  /* ---- instance validation --------------------------------------------------------------------------- */

  lib.xsdValidate = function (model, xml, { maxErrors = 200 } = {}) {
    let tree;
    try { tree = lib.xmlParse(xml); }
    catch (e) { return { ok: false, errors: [{ kind: "xml", message: e.message.replace(/ \(line \d+, column \d+\)$/, ""), line: e.line, col: e.col, path: "" }], warnings: [], elements: 0, root: null, truncated: false }; }
    const errors = [], warnings = new Set();
    let count = 0, truncated = false;
    const err = (el, message, path, kind = "schema") => {
      if (errors.length >= maxErrors) { truncated = true; return; }
      const lc = lib.xmlLineCol(xml, el.pos || 0);
      errors.push({ kind, message, path, line: lc.line, col: lc.col });
    };
    const nsFlagged = new Set();
    const nsScope = (el, scope) => {
      let s = scope;
      for (const [k, v] of el.attrs) if (k === "xmlns" || k.startsWith("xmlns:")) { if (s === scope) s = new Map(scope); s.set(k === "xmlns" ? "" : k.slice(6), v); }
      return s;
    };
    const elNs = (el, scope) => { const i = el.name.indexOf(":"); return scope.get(i < 0 ? "" : el.name.slice(0, i)) || ""; };
    const attrNs = (a, scope) => { const i = a.indexOf(":"); return i < 0 ? "" : scope.get(a.slice(0, i)) || ""; };

    function typeKind(name) {
      if (!name || name === "anyType") return "any";
      if (lib.xsdIsBuiltin(name) && !model.types.has(name)) return "simple";
      const t = model.types.get(name);
      return !t ? null : (t.kind === "simple" || t.simpleContent) ? "simple" : "complex";
    }

    function validate(el, decl, path, scope, expectNs) {
      count++;
      const sc = nsScope(el, scope);
      const actualNs = elNs(el, sc);
      if (actualNs !== expectNs && !nsFlagged.has(actualNs + "|" + expectNs)) {
        nsFlagged.add(actualNs + "|" + expectNs);
        err(el, expectNs ? (actualNs ? `<${el.name}> is in namespace "${actualNs}" but the schema expects "${expectNs}"` : `<${el.name}> has no namespace; the schema expects "${expectNs}" (add xmlns="${expectNs}")`) : `<${el.name}> is in namespace "${actualNs}" but the schema expects no namespace`, path, "namespace");
      }
      let typeName = decl.type;
      const xt = el.attrs.find(([k]) => attrNs(k, sc) === XSI && local(k) === "type");
      if (xt) {
        const tn = local(xt[1]);
        if (!model.types.has(tn) && !lib.xsdIsBuiltin(tn)) err(el, `xsi:type "${xt[1]}" is not defined in the schema`, path);
        else if (!lib.xsdDerivesFrom(model, tn, typeName)) err(el, `xsi:type "${tn}" is not derived from "${typeName}"`, path);
        else typeName = tn;
      }
      const nil = el.attrs.find(([k]) => attrNs(k, sc) === XSI && local(k) === "nil");
      const kids = el.kids.filter(k => k.t === "el"), text = el.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join("");
      if (nil && nil[1].trim() === "true") {
        if (!decl.nillable) err(el, `<${el.name}> is marked xsi:nil but is not nillable`, path);
        if (kids.length || text.trim()) err(el, `<${el.name}> is xsi:nil, so it must be empty`, path);
        return;
      }
      const kind = typeKind(typeName);
      if (kind === null) { warnings.add(`Type "${typeName}" (for <${el.name}>) is not in the loaded schema files; its content was not checked.`); return; }
      const tdef = model.types.get(typeName);
      const eff = tdef && tdef.kind === "complex" ? lib.xsdEffective(model, typeName) : null;      // includes simple-content types, which can carry attributes
      checkAttributes(el, sc, eff, kind, typeName, path);
      if (kind === "any") return;
      if (kind === "simple") {
        if (kids.length) { err(el, `<${el.name}> contains element <${kids[0].name}>, but its type "${typeName}" only allows text`, path); return; }
        const notes = [], e = lib.xsdCheckValue(model, lib.xsdSimpleInfo(model, typeName), text, notes);
        notes.forEach(n => warnings.add(n));
        if (e) err(el, `<${el.name}> ${e}`, path, "value");
        return;
      }
      if (eff.abstract && !xt) err(el, `<${el.name}> uses abstract type "${typeName}"; select a concrete type with xsi:type`, path);
      if (eff.empty && text !== "") err(el, `<${el.name}> must be empty (its type "${typeName}" has no content), but contains text`, path);
      else if (!eff.mixed && text.trim()) err(el, `<${el.name}> has text ("${text.trim().slice(0, 40)}${text.trim().length > 40 ? "…" : ""}") but its type "${typeName}" only allows child elements`, path);
      const total = {}, seen = {};
      kids.forEach(k => { total[k.name] = (total[k.name] || 0) + 1; });
      let state = eff.content;
      for (const k of kids) {
        const key = local(k.name);
        seen[k.name] = (seen[k.name] || 0) + 1;
        const cpath = `${path}/${k.name}${total[k.name] > 1 ? `[${seen[k.name]}]` : ""}`;
        const d = deriv(state, key);
        if (d === FAIL) {
          const exp = [...first(state)];
          const hint = exp.length ? `expected ${exp.length === 1 ? "" : "one of: "}${exp.slice(0, 12).map(x => x === "*" ? "(any element)" : `<${x}>`).join(", ")}${exp.length > 12 ? ", …" : ""}` : `no more elements are allowed here`;
          const known = eff.elems.has(key) ? ` (<${key}> is allowed, but not at this position or this many times)` : "";
          err(k, `unexpected element <${k.name}>${known}; ${hint}`, cpath, "structure");
          continue;
        }
        state = d;
        const cd = eff.elems.get(key);
        if (cd) validate(k, cd, cpath, sc, cd.ns);
        else count++;   // wildcard-matched element: accepted without further checks
      }
      if (!nullable(state)) {
        const exp = [...first(state)];
        err(el, `<${el.name}> is incomplete: ${exp.length === 1 ? "required element" : "one of the required elements"} ${exp.slice(0, 12).map(x => x === "*" ? "(any element)" : `<${x}>`).join(exp.length === 1 ? "" : " or ")} is missing`, path, "structure");
      }
    }

    function checkAttributes(el, sc, eff, kind, typeName, path) {
      const declared = eff ? new Map(eff.attributes.map(a => [a.name, a])) : new Map();
      const present = new Set();
      for (const [k, v] of el.attrs) {
        if (k === "xmlns" || k.startsWith("xmlns:")) continue;
        const ns = attrNs(k, sc);
        if (ns === XSI) continue;
        present.add(local(k));
        const a = declared.get(local(k));
        if (!a) { if (!(eff && eff.anyAttribute)) err(el, `unexpected attribute "${k}" on <${el.name}>${declared.size ? `; allowed: ${[...declared.keys()].join(", ")}` : " (this type has no attributes)"}`, `${path}/@${k}`, "attribute"); continue; }
        const notes = [], e = lib.xsdCheckValue(model, lib.xsdSimpleInfo(model, a.type), v, notes);
        notes.forEach(n => warnings.add(n));
        if (e) err(el, `attribute "${k}" ${e}`, `${path}/@${k}`, "value");
        if (a.fixed !== undefined && v !== a.fixed) err(el, `attribute "${k}" must be "${a.fixed}"`, `${path}/@${k}`, "value");
      }
      for (const [n, a] of declared) if (a.use === "required" && !present.has(n)) err(el, `missing required attribute "${n}" on <${el.name}>`, path, "attribute");
    }

    const rootName = local(tree.root.name), decl = model.elements.get(rootName);
    if (!decl) {
      const lower = rootName.toLowerCase(), names = [...model.elements.keys()];
      const near = names.filter(n => n.toLowerCase() === lower || n.toLowerCase().startsWith(lower.slice(0, 5)) || lower.startsWith(n.toLowerCase())).slice(0, 5);
      err(tree.root, `<${tree.root.name}> is not a global element in the loaded schema${near.length ? `. Did you mean: ${near.join(", ")}?` : ""}`, "/" + tree.root.name, "root");
      return { ok: false, errors, warnings: [...warnings], elements: 1, root: rootName, truncated };
    }
    const f = model.files.find(x => x.name === decl.file) || model.files[0];
    validate(tree.root, decl, "/" + tree.root.name, new Map(), f ? f.targetNamespace : "");
    return { ok: errors.length === 0, errors, warnings: [...warnings], elements: count, root: rootName, truncated };
  };
})();
