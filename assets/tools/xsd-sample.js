/* Generate schema-valid sample data from a loaded XSD model (see xsd-model.js, xsd-validate.js).
   lib.regexSample(pattern, opts)   a string matching an XSD pattern
   lib.xsdSampleValue(model, info)  a value for a simple type
   lib.xsdSkeleton(model, element)  an XML message skeleton (required content, or everything with all:true) */
(function () {
  const lib = DT.lib;
  const local = n => (n || "").replace(/^[^:]+:/, "");

  /* ---- regex -> sample string ---------------------------------------------------------------------- */

  /* Parse the regex subset used by XSD patterns: literals, escapes, classes, groups, alternation, quantifiers. */
  function parseRegex(src) {
    let i = 0;
    const peek = () => src[i], eat = () => src[i++];
    const CLASS_ESC = { d: [["0", "9"]], w: [["a", "z"], ["A", "Z"], ["0", "9"], ["_", "_"]], s: [[" ", " "], ["\t", "\t"]] };
    const CTRL = { n: "\n", t: "\t", r: "\r" };

    function parseClass() {                                  // after "["
      let negate = false; const ranges = [];
      if (peek() === "^") { negate = true; i++; }
      let firstItem = true;
      while (i < src.length && (peek() !== "]" || firstItem)) {
        firstItem = false;
        let c = eat();
        if (c === "[") { continue; }
        if (c === "\\") {
          const e = eat();
          if (CLASS_ESC[e]) { ranges.push(...CLASS_ESC[e]); continue; }
          if (/[DWS]/.test(e)) continue;                      // negated shorthand inside a class: ignored
          c = CTRL[e] || e;
        }
        if (peek() === "-" && src[i + 1] !== "]" && src[i + 1] !== undefined) {
          i++;
          let hi = eat();
          if (hi === "\\") { const e = eat(); hi = CTRL[e] || e; }
          ranges.push([c, hi]);
        } else ranges.push([c, c]);
      }
      i++;                                                    // "]"
      return { t: "class", negate, ranges };
    }
    function parseAtom() {
      const c = eat();
      if (c === "(") {
        if (src.startsWith("?:", i)) i += 2;
        const alt = parseAlt(); i++;                           // ")"
        return alt;
      }
      if (c === "[") return parseClass();
      if (c === ".") return { t: "class", negate: false, ranges: [["a", "a"]] };
      if (c === "\\") {
        const e = eat();
        if (CLASS_ESC[e]) return { t: "class", negate: false, ranges: CLASS_ESC[e] };
        if (e === "D" || e === "W" || e === "S") return { t: "lit", v: e === "S" ? "a" : e === "W" ? "-" : "a" };
        if (e === "p" || e === "P") { if (peek() === "{") while (i < src.length && eat() !== "}"); return { t: "lit", v: "a" }; }
        return { t: "lit", v: CTRL[e] || e };
      }
      return { t: "lit", v: c };
    }
    function parseQuant(atom) {
      const c = peek();
      let min = 1, max = 1;
      if (c === "*") { i++; min = 0; max = Infinity; }
      else if (c === "+") { i++; min = 1; max = Infinity; }
      else if (c === "?") { i++; min = 0; max = 1; }
      else if (c === "{") {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i));
        if (m) { i += m[0].length; min = +m[1]; max = m[2] ? (m[3] === "" ? Infinity : +m[3]) : min; }
      } else return atom;
      return { t: "rep", item: atom, min, max };
    }
    function parseSeq() {
      const items = [];
      while (i < src.length && peek() !== "|" && peek() !== ")") items.push(parseQuant(parseAtom()));
      return { t: "seq", items };
    }
    function parseAlt() {
      const alts = [parseSeq()];
      while (peek() === "|") { i++; alts.push(parseSeq()); }
      return alts.length === 1 ? alts[0] : { t: "alt", alts };
    }
    return parseAlt();
  }

  const inRanges = (ranges, ch) => ranges.some(([a, b]) => ch >= a && ch <= b);
  /* variant 0: friendly low characters (A, a, 0 …). variant 1: the top of each class (Z, z, 9 …), which satisfies "ends in 9"-style
     second patterns that a restriction chain can add. */
  function pickChar(node, variant) {
    const { negate, ranges } = node;
    const pref = variant ? ["Z", "z", "9", "8", "~", "_", "-", "A", "a", "0"] : ["A", "a", "0", "1", "X", "x", "-", "_", " ", "."];
    if (!negate) {
      for (const p of pref) if (inRanges(ranges, p)) return p;
      for (const [a, b] of ranges) if (a >= " " && a <= "~") return a;
      return ranges.length ? ranges[0][0] : "a";
    }
    for (const p of ["a", "A", "0", "x", "1", "z"]) if (!inRanges(ranges, p)) return p;
    for (let c = 33; c < 127; c++) if (!inRanges(ranges, String.fromCharCode(c))) return String.fromCharCode(c);
    return "a";
  }
  /* cap: how many repetitions to use for open-ended quantifiers beyond their minimum. */
  function emit(node, cap, altPick, variant) {
    switch (node.t) {
      case "lit": return node.v;
      case "class": return pickChar(node, variant);
      case "seq": return node.items.map(n => emit(n, cap, altPick, variant)).join("");
      case "alt": return emit(node.alts[Math.min(altPick, node.alts.length - 1)], cap, altPick, variant);
      case "rep": { const n = Math.max(node.min, Math.min(node.max, cap)); return Array.from({ length: n }, () => emit(node.item, cap, altPick, variant)).join(""); }
    }
    return "";
  }

  const CAPS = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 512, 1024, 4096];

  /* Distinct strings matching `pattern` with length in [minLen, maxLen] (most natural first), up to `limit`. */
  lib.regexSamples = function (pattern, { minLen = 0, maxLen = Infinity, tryAlts = 4, limit = 40 } = {}) {
    let ast, re;
    try { ast = parseRegex(pattern); } catch (_) { return []; }
    for (const flags of ["u", ""]) { try { re = new RegExp("^(?:" + pattern + ")$", flags); break; } catch (_) { /* next */ } }
    if (!re) return [];
    const out = new Set();
    for (let alt = 0; alt < tryAlts && out.size < limit; alt++) {
      for (const cap of CAPS) {
        let tooLong = true;
        for (let variant = 0; variant < 2; variant++) {         // interleave variants so a small `limit` still sees both
          const s = emit(ast, cap, alt, variant);
          if (s.length <= maxLen) tooLong = false;
          if (s.length <= maxLen && s.length >= minLen && re.test(s)) out.add(s);
        }
        if (tooLong || out.size >= limit) break;
      }
    }
    return [...out];
  };

  /* A string matching `pattern` whose length is within [minLen, maxLen]; null if none was found. */
  lib.regexSample = (pattern, opts = {}) => lib.regexSamples(pattern, { ...opts, limit: 1 })[0] ?? null;

  /* ---- sample values for simple types --------------------------------------------------------------- */

  const INT_RANGE = { byte: [-128, 127], short: [-32768, 32767], int: [-2147483648, 2147483647], unsignedByte: [0, 255], unsignedShort: [0, 65535], unsignedInt: [0, 4294967295], unsignedLong: [0, Number.MAX_SAFE_INTEGER], long: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    integer: [-Infinity, Infinity], nonNegativeInteger: [0, Infinity], positiveInteger: [1, Infinity], nonPositiveInteger: [-Infinity, 0], negativeInteger: [-Infinity, -1] };

  lib.xsdSampleValue = function (model, info, depth = 0) {
    const f = info.facets, b = info.builtin;
    if (b === "list") {                                                   // as many items as the length facets require (at least one)
      const lo = f.length !== undefined ? +f.length : f.minLength !== undefined ? +f.minLength : 1;
      const item = lib.xsdSampleValue(model, info.list, depth + 1);
      return Array.from({ length: Math.max(lo, 1) }, () => item).join(" ");
    }
    if (b === "union") { for (const m of info.union) { const v = lib.xsdSampleValue(model, m, depth + 1); if (v !== null && !lib.xsdCheckValue(model, m, v)) return v; } return ""; }
    if (info.enumeration && info.enumeration.length) return info.enumeration[0];
    const minLen = f.length !== undefined ? +f.length : f.minLength !== undefined ? +f.minLength : 0;
    const maxLen = f.length !== undefined ? +f.length : f.maxLength !== undefined ? +f.maxLength : Infinity;
    const numeric = INT_RANGE[b] || b === "decimal" || b === "float" || b === "double";
    if (numeric) {
      const [bl, bh] = INT_RANGE[b] || [-Infinity, Infinity];
      const isInt = !!INT_RANGE[b];
      let lo = bl, hi = bh;
      if (f.minInclusive !== undefined) lo = Math.max(lo, +f.minInclusive);
      if (f.maxInclusive !== undefined) hi = Math.min(hi, +f.maxInclusive);
      let loX = false, hiX = false;
      if (f.minExclusive !== undefined && +f.minExclusive >= lo) { lo = +f.minExclusive; loX = true; }
      if (f.maxExclusive !== undefined && +f.maxExclusive <= hi) { hi = +f.maxExclusive; hiX = true; }
      let v;
      if (lo > 0 || (lo === 0 && loX)) v = loX ? (isInt ? lo + 1 : (hi !== Infinity ? (lo + hi) / 2 : lo + 1)) : lo;
      else if (hi < 0 || (hi === 0 && hiX)) v = hiX ? (isInt ? hi - 1 : (lo !== -Infinity ? (lo + hi) / 2 : hi - 1)) : hi;
      else v = 0;
      return String(v);
    }
    switch (b) {
      case "boolean": return "false";
      case "dateTime": return "2026-01-01T00:00:00Z";
      case "date": return "2026-01-01";
      case "time": return "00:00:00Z";
      case "duration": return "PT0S";
      case "gYear": return "2026"; case "gYearMonth": return "2026-01"; case "gMonthDay": return "--01-01"; case "gDay": return "---01"; case "gMonth": return "--01";
      case "hexBinary": return "00".repeat(Math.max(1, minLen));
      case "base64Binary": return minLen > 1 ? btoa("a".repeat(minLen)) : "AA==";
      case "anyURI": return "urn:example:value";
      case "QName": case "NCName": case "Name": case "ID": case "IDREF": case "NMTOKEN": case "language": return b === "language" ? "en" : "name";
    }
    // strings: honour patterns, then length facets
    const pats = info.patterns;
    if (pats.length) {
      const holds = cand => cand.length >= minLen && cand.length <= maxLen && pats.every(g => g.some(p => { try { return new RegExp("^(?:" + p + ")$").test(cand); } catch (_) { return true; } }));
      // recognisable, realistic values first, then generated ones (blank-only strings last: they are legal but useless as samples)
      for (const nice of NICE) if (holds(nice)) return nice;
      const gen = [...candidates(pats, minLen, maxLen)].filter(holds);
      const real = gen.find(c => c.trim() !== "");
      if (real !== undefined) return real;
      if (gen.length) return gen[0];
    }
    let s = "string";
    if (s.length > maxLen) s = s.slice(0, maxLen);
    if (s.length < minLen) s = s.padEnd(minLen, "x");
    return s;
  };
  const NICE = ["123e4567-e89b-12d3-a456-426614174000", "192.0.2.1", "2001:db8::1"];   // documentation-range UUID / IPv4 / IPv6
  /* Candidates from every pattern in a restriction chain; the caller keeps the first that satisfies all of them. */
  function* candidates(groups, minLen, maxLen) {
    for (const g of groups) for (const p of g) yield* lib.regexSamples(p, { minLen, maxLen, limit: 12 });
  }

  /* ---- message skeleton ------------------------------------------------------------------------------- */

  lib.xsdSkeleton = function (model, elementName, opts = {}) {
    const o = { all: false, maxDepth: 14, hints: true, indent: "  ", ...opts };
    let decl = model.elements.get(elementName);
    if (!decl && model.types.has(elementName)) {                // a bare type: wrap it in a root element so it can be shown as XML
      const t = model.types.get(elementName);
      decl = { name: o.rootName || elementName, type: elementName, file: t.file };
    }
    if (!decl) throw new Error(`"${elementName}" is not a global element or type in the loaded schema.`);
    const file = model.files.find(f => f.name === decl.file) || model.files[0];
    const tns = file ? file.targetNamespace : "", qualified = file && file.elementFormDefault === "qualified";
    const warnings = [];
    let nodes = 0;

    /* First non-abstract type derived (directly or not) from `typeName`, or null. */
    const concrete = typeName => {
      const queue = [...(model.derived.get(typeName) || [])], seen = new Set();
      while (queue.length) { const n = queue.shift(); if (seen.has(n)) continue; seen.add(n); const t = model.types.get(n); if (t && !t.abstract) return t; queue.push(...(model.derived.get(n) || [])); }
      return null;
    };
    const instantiable = typeName => { const t = model.types.get(typeName); return !(t && t.abstract && !concrete(typeName)); };
    const text = v => ({ t: "text", v });
    const comment = v => ({ t: "comment", v: ` ${v} ` });

    function simpleKids(typeName, name) {
      const info = lib.xsdSimpleInfo(model, typeName);
      const v = lib.xsdSampleValue(model, info);
      const bad = lib.xsdCheckValue(model, info, v);
      if (bad) warnings.push(`${name}: sample value may be invalid (${bad})`);
      const kids = [];
      if (o.hints && info.enumeration && info.enumeration.length > 1) kids.push({ hint: ` ${info.enumeration.slice(0, 12).join(" | ")}${info.enumeration.length > 12 ? " | …" : ""} ` });
      return { value: v, hint: kids[0] };
    }

    /* Name and namespace declarations for an element in namespace `ns`, given what is already in scope. */
    function qualify(name, ns, scope) {
      if (ns === scope.def) return { qname: name, attrs: [], def: scope.def };
      const pfx = scope.prefixes.get(ns);
      if (pfx) return { qname: pfx + ":" + name, attrs: [], def: scope.def };
      return { qname: name, attrs: [["xmlns", ns]], def: ns };
    }
    const nsOfType = typeName => ((model.files.find(f => f.name === (model.types.get(typeName) || {}).file) || {}).targetNamespace) || "";
    /* A QName for xsi:type (unprefixed QNames in attribute values use the default namespace). */
    const typeQName = (typeName, scope) => { const ns = nsOfType(typeName), pfx = scope.prefixes.get(ns); return ns === scope.def || !pfx ? typeName : pfx + ":" + typeName; };

    function makeElement(name, typeName, depth, stack, ns, scope) {
      if (++nodes > 20000) throw new Error("Sample is too large (over 20,000 elements); try a lower depth or required-only.");
      const q = qualify(name, ns, scope), inner = { def: q.def, prefixes: scope.prefixes };
      const el = { t: "el", name: q.qname, attrs: [...q.attrs], kids: [], pos: 0 };
      const kind = !typeName || typeName === "anyType" ? "any" : (lib.xsdIsBuiltin(typeName) && !model.types.has(typeName)) ? "simple" : (() => { const t = model.types.get(typeName); return !t ? "unknown" : (t.kind === "simple" || t.simpleContent) ? "simple" : "complex"; })();
      if (kind === "any" || kind === "unknown") return { el };
      if (kind === "simple") { const s = simpleKids(typeName, name); el.kids.push(text(s.value)); if (typeName && model.types.has(typeName) && model.types.get(typeName).simpleContent) addAttrs(lib.xsdEffective(model, typeName), el); return { el, hint: s.hint }; }
      const eff = lib.xsdEffective(model, typeName);
      if (eff.abstract) {                                   // pick the first concrete subtype
        const sub = concrete(typeName);
        if (sub) {
          const r = makeElement(name, sub.name, depth, stack, ns, scope);
          r.el.attrs.unshift(["xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance"], ["xsi:type", typeQName(sub.name, inner)]);
          return r;
        }
        warnings.push(`${name}: type ${typeName} is abstract and has no concrete subtype`);
      }
      addAttrs(eff, el);
      const st = stack.concat(typeName);
      for (const t of eff.chain) if (t.content) walk(t.content, el.kids, depth, st, inner);
      return { el };
    }
    function addAttrs(eff, el) {
      if (!eff) return;
      for (const a of eff.attributes) {
        if (a.use !== "required" && !o.all) continue;
        const v = a.fixed !== undefined ? a.fixed : a.default !== undefined ? a.default : lib.xsdSampleValue(model, lib.xsdSimpleInfo(model, a.type));
        el.attrs.push([a.name, v]);
      }
    }
    function walk(p, out, depth, stack, scope) {
      if (!p) return;
      if (p.min === 0 && !o.all) return;
      switch (p.k) {
        case "seq": case "all": p.items.forEach(i => walk(i, out, depth, stack, scope)); break;
        case "group": { const g = model.groups.get(p.ref); if (g) walk(g.particle, out, depth, stack, scope); break; }
        case "any": break;
        case "choice": {
          // first alternative that does not require infinite recursion
          for (const alt of p.items) {
            const scratch = [], before = warnings.length;
            walk({ ...alt, min: Math.max(alt.min === undefined ? 1 : alt.min, 1) }, scratch, depth, stack, scope);
            if (warnings.length === before) {
              if (o.hints && p.items.length > 1) out.push(comment(`choice: ${p.items.map(altLabel).join(" | ")}`));
              out.push(...scratch); return;
            }
            warnings.length = before;
          }
          break;
        }
        case "el": {
          const head = p.ref ? model.elements.get(p.name) : null;
          const typeName = p.type || (head && head.type) || "anyType";
          const n = Math.max(p.min, o.all ? 1 : 0);          // never fewer than minOccurs; the node-count guard in makeElement bounds the total
          if (n === 0) return;
          if (stack.includes(typeName) && typeName !== "anyType" && !(lib.xsdIsBuiltin(typeName))) { if (p.min === 0) return; warnings.push(`${p.name}: required recursion into ${typeName}`); return; }
          if (depth > o.maxDepth && p.min === 0) return;
          if (!instantiable(typeName)) {                    // abstract extension point with nothing to extend it in the loaded schema
            if (p.min === 0) { if (o.hints) out.push(comment(`${p.name}: abstract type ${typeName}; add a subtype via xsi:type if you need it`)); return; }
            warnings.push(`${p.name}: required element of abstract type ${typeName} has no concrete subtype`); return;
          }
          const ns = lib.xsdElementNs(model, p);
          for (let k = 0; k < n; k++) {
            const r = makeElement(p.name, typeName, depth + 1, stack, ns, scope);
            if (r.hint) out.push(comment(r.hint.hint.trim()));
            out.push(r.el);
          }
          break;
        }
      }
    }
    const altLabel = a => a.k === "el" ? a.name : a.k === "choice" ? "(choice)" : a.k === "group" ? a.ref : "(sequence)";

    // Global elements always live in the target namespace. Qualified schemas use it as the default namespace; others get a "tns" prefix,
    // and local (unqualified) children then correctly stay out of any namespace.
    const scope = { def: "", prefixes: new Map() };
    if (tns && !qualified) scope.prefixes.set(tns, "tns");
    const { el: root } = makeElement(decl.name, decl.type, 1, [], tns, scope);
    if (tns && !qualified) root.attrs.unshift(["xmlns:tns", tns]);
    const xml = lib.xmlSerialize({ decl: 'xml version="1.0" encoding="UTF-8"', root }, { indent: o.indent });
    return { xml, warnings, elements: nodes };
  };
})();
