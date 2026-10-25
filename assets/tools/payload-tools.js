/* Looking inside message payloads (JSON, XML and OMS JSON) without a schema:
     lib.payloadFields(x)       flatten to path -> value
     lib.payloadDiff(a, b)      field-level difference of two payloads
     lib.fieldQuery(text)       compile "Latitude > 0.5 and SystemID = alpha" into a matcher
   Used by the message diff, content alerts and field search in the NATS and CAL explorers and the Traffic Lab. */
(function () {
  const lib = DT.lib, TD = new TextDecoder();
  const local = n => String(n).replace(/^[^:]+:/, "");
  const textOf = x => (typeof x === "string" ? x : x && x.length !== undefined ? TD.decode(x) : String(x));

  /* -> { kind: "json" | "xml" | "text", fields: Map<path, string | number | boolean | null> }.
     JSON paths look like a.b[0].c; XML paths like Root.Child[1].Leaf and Root.Child.@attr. Containers are not listed, only leaves. */
  lib.payloadFields = function (input, { limit = 5000 } = {}) {
    const text = textOf(input), t = text.trimStart(), fields = new Map();
    const put = (p, v) => { if (fields.size < limit) fields.set(p, v); };
    if (t[0] === "{" || t[0] === "[") {
      let v; try { v = JSON.parse(text); } catch (_) { v = undefined; }
      if (v !== undefined) {
        const walk = (x, p) => {
          if (x && typeof x === "object") {
            if (Array.isArray(x)) { if (!x.length) put(p, "[]"); x.forEach((y, i) => walk(y, `${p}[${i}]`)); }
            else { const ks = Object.keys(x); if (!ks.length) put(p, "{}"); ks.forEach(k => walk(x[k], p ? p + "." + k : k)); }
          } else put(p, x);
        };
        walk(v, ""); return { kind: "json", fields };
      }
    }
    if (t[0] === "<") {
      let tree; try { tree = lib.xmlParse(text); } catch (_) { tree = null; }
      if (tree && tree.root) {
        const walk = (el, here) => {                       // here: this element's own path
          for (const [k, v] of el.attrs) put(here + ".@" + local(k), v);
          const kids = el.kids.filter(k => k.t === "el");
          if (!kids.length) { put(here, el.kids.filter(k => k.t === "text").map(k => k.v).join("").trim()); return; }
          const seen = new Map(), total = new Map();
          kids.forEach(k => total.set(local(k.name), (total.get(local(k.name)) || 0) + 1));
          for (const k of kids) {
            const n = local(k.name), i = seen.get(n) || 0; seen.set(n, i + 1);
            walk(k, here + "." + n + (total.get(n) > 1 ? "[" + i + "]" : ""));
          }
        };
        walk(tree.root, local(tree.root.name));
        return { kind: "xml", fields };
      }
    }
    return { kind: "text", fields };
  };

  /* Loose equality for comparing the same data from two encodings: 1 = 1.0 = "1", true = "TRUE", surrounding spaces ignored. */
  const looseEq = (x, y) => {
    if (x === y) return true;
    const n = v => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : NaN);
    if (!isNaN(n(x)) && !isNaN(n(y))) return Math.abs(n(x) - n(y)) <= 1e-9 * Math.max(1, Math.abs(n(x)));
    return String(x).trim().toLowerCase() === String(y).trim().toLowerCase();
  };
  lib.looseEq = looseEq;
  /* { kind, same, changes: [{ path, type: "added" | "removed" | "changed", a, b }] }. Plain text compares as a whole (use lib.lineDiff to show it).
     opts.loose compares values with looseEq. */
  lib.payloadDiff = function (a, b, opts = {}) {
    const A = lib.payloadFields(a), B = lib.payloadFields(b);
    if (A.kind === "text" || B.kind === "text" || A.kind !== B.kind) {
      const ta = textOf(a), tb = textOf(b);
      return { kind: A.kind === B.kind ? A.kind : "mixed", structured: false, same: ta === tb, changes: [] };
    }
    const changes = [], paths = [...new Set([...A.fields.keys(), ...B.fields.keys()])];
    for (const p of paths) {
      const ha = A.fields.has(p), hb = B.fields.has(p), va = A.fields.get(p), vb = B.fields.get(p);
      if (ha && !hb) changes.push({ path: p, type: "removed", a: va, b: undefined });
      else if (!ha && hb) changes.push({ path: p, type: "added", a: undefined, b: vb });
      else if (opts.loose ? !looseEq(va, vb) : va !== vb) changes.push({ path: p, type: "changed", a: va, b: vb });
    }
    return { kind: A.kind, structured: true, same: !changes.length, changes };
  };

  /* ---- field queries ----
     expr   := and ( "or" and )*        and := term ( "and" term )*
     term   := path op value | path exists | text   (a bare word matches anywhere in the payload, case-insensitive)
     op     := = != > >= < <= ~   (~ is "contains", or a /regex/)
     A path matches a field when it equals the field path or is its trailing part: "Latitude" matches Pos.Point.Latitude.
     Indexes are ignored when matching, so "Item.Id" matches Item[2].Id. Names compare case-insensitively. */
  const stripIdx = s => s.replace(/\[\d+\]/g, "");
  const OPS = ["!=", ">=", "<=", "=", ">", "<", "~"];
  lib.fieldQuery = function (src) {
    const text = String(src || "").trim();
    if (!text) return { ok: false, error: "Type a query, for example Latitude > 0.5 or SystemID = alpha." };
    const orParts = text.split(/\s+or\s+/i), groups = [];
    for (const og of orParts) {
      const terms = [];
      for (const raw of og.split(/\s+and\s+/i)) {
        const s = raw.trim(); if (!s) return { ok: false, error: "Empty condition: check around \"and\" / \"or\"." };
        const ex = /^(\S+)\s+exists$/i.exec(s);
        if (ex) { terms.push({ path: ex[1], op: "exists" }); continue; }
        const m = /^([^\s=!<>~]+)\s*(!=|>=|<=|=|>|<|~)\s*(.*)$/.exec(s);
        if (!m) { terms.push({ op: "text", value: s.toLowerCase() }); continue; }
        if (!m[3].trim()) return { ok: false, error: `Missing a value after "${m[2]}" in "${s}".` };
        let value = m[3].trim().replace(/^"(.*)"$/, "$1");
        let re = null;
        if (m[2] === "~") { const r = /^\/(.+)\/([a-z]*)$/.exec(value); if (r) { try { re = new RegExp(r[1], r[2].includes("i") ? r[2] : r[2] + "i"); } catch (e) { return { ok: false, error: "Bad regular expression: " + e.message }; } } }
        terms.push({ path: m[1], op: m[2], value, re, num: value !== "" && !isNaN(Number(value)) ? Number(value) : null });
      }
      groups.push(terms);
    }
    const pathMatch = (q, p) => { const a = stripIdx(p).toLowerCase(), b = stripIdx(q).toLowerCase(); return a === b || a.endsWith("." + b); };
    const cmp = (t, v) => {
      if (v === undefined) return t.op === "!=";
      const s = String(v);
      switch (t.op) {
        case "=": return t.num !== null && typeof v === "number" ? v === t.num : s.toLowerCase() === t.value.toLowerCase();
        case "!=": return !(t.num !== null && typeof v === "number" ? v === t.num : s.toLowerCase() === t.value.toLowerCase());
        case "~": return t.re ? t.re.test(s) : s.toLowerCase().includes(t.value.toLowerCase());
        default: {
          const n = typeof v === "number" ? v : s !== "" && !isNaN(Number(s)) ? Number(s) : NaN;
          if (t.num === null || isNaN(n)) return false;
          return t.op === ">" ? n > t.num : t.op === ">=" ? n >= t.num : t.op === "<" ? n < t.num : n <= t.num;
        }
      }
    };
    const test = (fields, ctx = {}) => groups.some(terms => terms.every(t => {
      if (t.op === "text") return ctx.raw !== undefined ? ctx.raw.toLowerCase().includes(t.value) : [...fields.values()].some(v => String(v).toLowerCase().includes(t.value));
      if (/^(topic|subject)$/i.test(t.path) && ctx.topic !== undefined) return t.op === "exists" || cmp(t, ctx.topic);
      let found = false;
      for (const [p, v] of fields) {
        if (!pathMatch(t.path, p)) continue;
        found = true;
        if (t.op === "exists" || cmp(t, v)) return true;
      }
      return t.op === "!=" && !found;
    }));
    return { ok: true, test, text };
  };
})();
