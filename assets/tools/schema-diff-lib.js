/* Compare two loaded XSD sets (two versions of a schema, e.g. UCI 2.5 and 2.6). Pure functions on DT.lib, no DOM.
   Every change gets a severity from the point of view of a system that already works with the OLD schema:
     breaking  existing valid messages or code can stop working (something removed, narrowed, retyped, a new required member)
     review    may or may not matter (a pattern changed, member order changed, a choice was reshaped)
     additive  the new schema only allows more (new message, new optional member, new enumeration value, loosened limit)
     docs      only the documentation text changed (reported when asked)                                                    */
(function () {
  const lib = DT.lib;
  const RANK = { docs: 0, additive: 1, review: 2, breaking: 3 };
  const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);
  lib.diffSeverities = ["breaking", "review", "additive", "docs"];

  const NUMERIC_MIN = new Set(["minInclusive", "minExclusive", "minLength", "totalDigits"]);
  const NUMERIC_MAX = new Set(["maxInclusive", "maxExclusive", "maxLength", "length", "fractionDigits"]);
  const num = v => (v !== undefined && v !== "" && Number.isFinite(+v) ? +v : NaN);
  const fmtMax = m => (m === Infinity ? "∞" : String(m));
  const norm = s => (s || "").replace(/\s+/g, " ").trim();

  function memberKey(p) { return p.kind + ":" + p.name; }

  /* Changes between the same-named type in the old (a) and new (b) model. */
  /* A member that changed type: the new type restricting the old one may reject values that used to be fine (review), the new type being
     a base of the old one only widens (additive), anything else is a different type (breaking). */
  function retype(A, B, from, to) {
    if (lib.xsdDerivesFrom(B, to, from)) return ["review", " (the new type restricts the old one)"];
    if (lib.xsdDerivesFrom(A, from, to)) return ["additive", " (the new type is wider)"];
    return ["breaking", ""];
  }
  function compareType(ta, tb, docs, A, B) {
    const ch = [];
    const add = (severity, text) => ch.push({ severity, text });
    if (ta.kind !== tb.kind) add("breaking", `was a ${ta.kind} type, now a ${tb.kind} type`);
    if ((ta.base || "") !== (tb.base || "")) add("breaking", `base type ${ta.base || "(none)"} → ${tb.base || "(none)"}`);
    else if ((ta.derivation || "") !== (tb.derivation || "")) add("breaking", `derivation ${ta.derivation} → ${tb.derivation}`);
    if (!!ta.abstract !== !!tb.abstract) add(tb.abstract ? "breaking" : "additive", tb.abstract ? "became abstract" : "no longer abstract");
    if (!!ta.mixed !== !!tb.mixed) add("review", tb.mixed ? "now allows mixed content" : "no longer allows mixed content");

    // members (complex types): own declared members, with attributes
    const ma = new Map(ta.parts.map(p => [memberKey(p), p])), mb = new Map(tb.parts.map(p => [memberKey(p), p]));
    for (const [k, p] of ma) if (!mb.has(k)) add("breaking", `removed ${p.kind === "attribute" ? "attribute @" : "member "}${p.name}${p.choice ? " (a choice alternative)" : ""}`);
    for (const [k, p] of mb) {
      if (ma.has(k)) continue;
      const required = p.min >= 1 && !p.choice;
      add(required ? "breaking" : "additive", `added ${p.kind === "attribute" ? "attribute @" : "member "}${p.name} : ${p.type} [${p.min}..${fmtMax(p.max)}]${required ? " (required: senders must now include it)" : p.choice ? " (new choice alternative)" : ""}`);
    }
    for (const [k, p] of ma) {
      const q = mb.get(k); if (!q) continue;
      if ((p.type || "") !== (q.type || "")) { const [sev, note] = retype(A, B, p.type, q.type); add(sev, `${p.name}: type ${p.type || "(none)"} → ${q.type || "(none)"}${note}`); }
      if (p.min !== q.min) add(q.min > p.min ? "breaking" : "additive", `${p.name}: minimum occurrences ${p.min} → ${q.min}`);
      if (p.max !== q.max) add(q.max < p.max ? "breaking" : "additive", `${p.name}: maximum occurrences ${fmtMax(p.max)} → ${fmtMax(q.max)}`);
      if (!!p.choice !== !!q.choice || (p.choice && q.choice && (p.choice.of !== q.choice.of))) add("review", `${p.name}: choice structure changed (${p.choice ? `${p.choice.of} alternatives` : "not in a choice"} → ${q.choice ? `${q.choice.of} alternatives` : "not in a choice"})`);
      if (docs && norm(p.doc) !== norm(q.doc)) add("docs", `${p.name}: documentation changed`);
    }
    const oa = ta.parts.filter(p => p.kind === "element" && mb.has(memberKey(p))).map(p => p.name), ob = tb.parts.filter(p => p.kind === "element" && ma.has(memberKey(p))).map(p => p.name);
    if (oa.join("|") !== ob.join("|")) add("review", "member order changed (breaks XML, harmless for OMS JSON)");

    // simple types
    const fa = ta.facets || {}, fb = tb.facets || {};
    if (fa.enumeration || fb.enumeration) {
      const va = new Map((fa.enumeration || []).map(e => [e.value, e])), vb = new Map((fb.enumeration || []).map(e => [e.value, e]));
      if (!fa.enumeration && fb.enumeration) add("breaking", `now restricted to ${vb.size} enumeration values`);
      else if (fa.enumeration && !fb.enumeration) add("additive", "no longer restricted to an enumeration");
      else {
        const removed = [...va.keys()].filter(v => !vb.has(v)), added = [...vb.keys()].filter(v => !va.has(v));
        if (removed.length) add("breaking", `removed value${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}`);
        if (added.length) add("additive", `added value${added.length === 1 ? "" : "s"}: ${added.join(", ")} (receivers that do not know them may reject them)`);
        if (docs) for (const [v, e] of va) { const f = vb.get(v); if (f && norm(e.doc) !== norm(f.doc)) add("docs", `value ${v}: documentation changed`); }
      }
    }
    const pa = (fa.pattern || []).join(" | "), pb = (fb.pattern || []).join(" | ");
    if (pa !== pb) add(!pa ? "breaking" : !pb ? "additive" : "review", !pa ? `new pattern restriction ${pb}` : !pb ? "pattern restriction removed" : `pattern changed: ${pa} → ${pb}`);
    for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (k === "enumeration" || k === "pattern") continue;
      const x = fa[k], y = fb[k];
      if (x === y) continue;
      const nx = num(x), ny = num(y);
      if (x === undefined) add("breaking", `new restriction ${k} = ${y}`);
      else if (y === undefined) add("additive", `restriction ${k} removed (was ${x})`);
      else if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
        const tighter = NUMERIC_MIN.has(k) ? ny > nx : NUMERIC_MAX.has(k) ? ny < nx : null;
        add(tighter === null ? "review" : tighter ? "breaking" : "additive", `${k} ${x} → ${y}${tighter === null ? "" : tighter ? " (narrower)" : " (wider)"}`);
      } else add("review", `${k} ${x} → ${y}`);
    }
    if (ta.simpleKind !== tb.simpleKind) add("breaking", `simple type form ${ta.simpleKind || "restriction"} → ${tb.simpleKind || "restriction"}`);
    if ((ta.itemType || "") !== (tb.itemType || "")) add("breaking", `list item type ${ta.itemType} → ${tb.itemType}`);
    if ((ta.memberTypes || []).join("|") !== (tb.memberTypes || []).join("|")) add("review", `union members changed`);
    if (docs && norm(ta.doc) !== norm(tb.doc)) add("docs", "documentation changed");
    return ch;
  }

  /* -> { a, b, types: [...], messages: [...], summary } where each item is
       { name, status: "added"|"removed"|"changed", severity, changes: [{severity, text}], impacts?: [{type, severity}] } */
  lib.schemaDiff = function (A, B, { docs = false } = {}) {
    const info = m => ({ files: m.files.length, versions: [...new Set(m.files.map(f => f.version).filter(Boolean))], namespaces: [...new Set(m.files.map(f => f.targetNamespace).filter(Boolean))], messages: m.elements.size, types: m.types.size });
    const types = [], typeSev = new Map();
    for (const n of new Set([...A.types.keys(), ...B.types.keys()])) {
      const ta = A.types.get(n), tb = B.types.get(n);
      if (!ta) { types.push({ name: n, status: "added", severity: "additive", kind: tb.kind, changes: [{ severity: "additive", text: `new ${tb.kind} type${tb.facets && tb.facets.enumeration ? ` (${tb.facets.enumeration.length} values)` : ""}` }] }); continue; }
      if (!tb) {
        const used = (A.elementsOfType.get(n) || []).length || (A.usedBy.get(n) || []).length;
        const sev = used ? "breaking" : "review";
        types.push({ name: n, status: "removed", severity: sev, kind: ta.kind, changes: [{ severity: sev, text: used ? "removed, and the old schema used it" : "removed (nothing in the old schema used it)" }] }); typeSev.set(n, sev); continue;
      }
      const changes = compareType(ta, tb, docs, A, B);
      if (!changes.length) continue;
      const severity = changes.reduce((s, c) => worst(s, c.severity), "docs");
      types.push({ name: n, status: "changed", severity, kind: tb.kind, changes });
      if (severity !== "docs" || docs) typeSev.set(n, severity);
    }
    const order = (a, b) => RANK[b.severity] - RANK[a.severity] || a.name.localeCompare(b.name);
    types.sort(order);

    // messages: direct changes plus the changed types they contain
    const impacts = new Map();
    for (const [t, sev] of typeSev) {
      const model = B.types.has(t) ? B : A;
      for (const m of lib.xsdMessagesUsing(model, t, 5000)) { let a = impacts.get(m); if (!a) impacts.set(m, a = []); a.push({ type: t, severity: sev }); }
    }
    const messages = [];
    for (const n of new Set([...A.elements.keys(), ...B.elements.keys()])) {
      const ea = A.elements.get(n), eb = B.elements.get(n);
      if (!ea) { messages.push({ name: n, status: "added", severity: "additive", changes: [{ severity: "additive", text: `new message (type ${eb.type})` }], impacts: [] }); continue; }
      if (!eb) { messages.push({ name: n, status: "removed", severity: "breaking", changes: [{ severity: "breaking", text: "message removed" }], impacts: [] }); continue; }
      const changes = [];
      if (ea.type !== eb.type) { const [sev, note] = retype(A, B, ea.type, eb.type); changes.push({ severity: sev, text: `type ${ea.type} → ${eb.type}${note}` }); }
      if (!!ea.abstract !== !!eb.abstract) changes.push({ severity: "review", text: eb.abstract ? "became abstract" : "no longer abstract" });
      if ((ea.substitutionGroup || "") !== (eb.substitutionGroup || "")) changes.push({ severity: "review", text: `substitution group ${ea.substitutionGroup || "(none)"} → ${eb.substitutionGroup || "(none)"}` });
      if (docs && norm(ea.doc) !== norm(eb.doc)) changes.push({ severity: "docs", text: "documentation changed" });
      const imp = (impacts.get(n) || []).sort((x, y) => RANK[y.severity] - RANK[x.severity] || x.type.localeCompare(y.type));
      if (!changes.length && !imp.length) continue;
      const severity = [...changes, ...imp].reduce((s, c) => worst(s, c.severity), "docs");
      messages.push({ name: n, status: "changed", severity, changes, impacts: imp });
    }
    messages.sort(order);

    const count = list => { const c = { added: 0, removed: 0, changed: 0, breaking: 0, review: 0, additive: 0, docs: 0 }; for (const x of list) { c[x.status]++; c[x.severity]++; } return c; };
    return { a: info(A), b: info(B), types, messages, summary: { messages: count(messages), types: count(types) } };
  };

  /* Reports */
  lib.schemaDiffMarkdown = function (d, { labelA = "old", labelB = "new", min = "review" } = {}) {
    const keep = x => RANK[x.severity] >= RANK[min];
    const lines = [`# Schema comparison: ${labelA} → ${labelB}`, "",
      `| | ${labelA} | ${labelB} |`, "|---|---|---|", `| versions | ${d.a.versions.join(", ") || "?"} | ${d.b.versions.join(", ") || "?"} |`, `| messages | ${d.a.messages} | ${d.b.messages} |`, `| types | ${d.a.types} | ${d.b.types} |`, ""];
    const s = d.summary;
    lines.push(`**Messages:** ${s.messages.added} added, ${s.messages.removed} removed, ${s.messages.changed} changed (${s.messages.breaking} breaking, ${s.messages.review} to review).  `, `**Types:** ${s.types.added} added, ${s.types.removed} removed, ${s.types.changed} changed (${s.types.breaking} breaking, ${s.types.review} to review).`, "");
    lines.push(`## Messages (${min} and above)`, "");
    for (const m of d.messages.filter(keep)) {
      lines.push(`- **${m.name}** (${m.status}, ${m.severity})`);
      for (const c of m.changes) lines.push(`  - ${c.text}`);
      if (m.impacts.length) lines.push(`  - affected through: ${m.impacts.slice(0, 12).map(i => i.type + " (" + i.severity + ")").join(", ")}${m.impacts.length > 12 ? `, and ${m.impacts.length - 12} more` : ""}`);
    }
    lines.push("", `## Types (${min} and above)`, "");
    for (const t of d.types.filter(keep)) { lines.push(`- **${t.name}** (${t.status}, ${t.severity})`); for (const c of t.changes.filter(c => RANK[c.severity] >= RANK[min])) lines.push(`  - ${c.severity}: ${c.text}`); }
    return lines.join("\n") + "\n";
  };
  const csvCell = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  lib.schemaDiffCsv = function (d) {
    const rows = [["scope", "name", "status", "severity", "change"]];
    for (const [scope, list] of [["message", d.messages], ["type", d.types]]) for (const x of list) for (const c of x.changes) rows.push([scope, x.name, x.status, c.severity, c.text]);
    return rows.map(r => r.map(csvCell).join(",")).join("\n") + "\n";
  };
})();
