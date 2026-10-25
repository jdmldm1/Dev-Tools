/* Working with captures beyond a single view: fault injection for replay, comparing two captures, per-service conformance,
   and a shareable report (Markdown and a self-contained HTML page). Stores are lib.TrafficStore instances that have been processed. */
(function () {
  const lib = DT.lib, esc = DT.esc;

  /* ---- fault injection ----
     plan: [{ at (ms), rec }] -> { plan, stats: { dropped, duplicated, jittered, reordered } }
     opts: { drop: 0..1, dup: 0..1, dupDelay (ms), jitter (ms, +/-), reorder (window size, 0 = off) }; rng() -> [0,1) is injectable for tests. */
  lib.capFaults = function (plan, opts = {}, rng = Math.random) {
    const stats = { dropped: 0, duplicated: 0, jittered: 0, reordered: 0 };
    const drop = Math.min(1, Math.max(0, +opts.drop || 0)), dup = Math.min(1, Math.max(0, +opts.dup || 0)), jitter = Math.max(0, +opts.jitter || 0), dupDelay = Math.max(0, opts.dupDelay === undefined ? 50 : +opts.dupDelay);
    let out = [];
    for (const p of plan) {
      if (drop && rng() < drop) { stats.dropped++; continue; }
      let at = p.at;
      if (jitter) { at = Math.max(0, at + (rng() * 2 - 1) * jitter); stats.jittered++; }
      out.push({ at, rec: p.rec });
      if (dup && rng() < dup) { out.push({ at: at + dupDelay, rec: p.rec, dup: true }); stats.duplicated++; }
    }
    out.sort((a, b) => a.at - b.at);
    const w = Math.floor(+opts.reorder || 0);
    if (w > 1) {                                           // within each window of w messages, keep the send times but shuffle which message goes at which time
      for (let i = 0; i + 1 < out.length; i += w) {
        const end = Math.min(out.length, i + w), recs = out.slice(i, end).map(p => p.rec);
        for (let j = recs.length - 1; j > 0; j--) { const k = Math.floor(rng() * (j + 1)); [recs[j], recs[k]] = [recs[k], recs[j]]; }
        for (let j = i; j < end; j++) { if (out[j].rec !== recs[j - i]) stats.reordered++; out[j] = { ...out[j], rec: recs[j - i] }; }
      }
    }
    return { plan: out, stats };
  };

  /* ---- conformance ----
     Pass / fail per service (MessageHeader ServiceID, else SystemID) from the validated records. -> rows sorted by failures */
  lib.conformance = function (store) {
    const by = new Map();
    for (const r of store.records.slice(0, store.cursor)) {
      const m = r.meta, key = m.header.serviceId || m.header.systemId || "(no MessageHeader)";
      let s = by.get(key); if (!s) by.set(key, s = { service: key, total: 0, valid: 0, invalid: 0, unchecked: 0, unknown: 0, types: new Map() });
      s.total++;
      if (m.valid === true) s.valid++; else if (m.valid === false) s.invalid++; else s.unchecked++;
      if (store.model && m.format !== "other" && !m.known) s.unknown++;
      if (m.valid === false) for (const e of m.errors) { const k = e.message.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "#").slice(0, 140); s.types.set(m.name + ": " + k, (s.types.get(m.name + ": " + k) || 0) + 1); }
    }
    return [...by.values()].map(s => ({ service: s.service, total: s.total, valid: s.valid, invalid: s.invalid, unchecked: s.unchecked, unknown: s.unknown,
      passRate: s.valid + s.invalid ? s.valid / (s.valid + s.invalid) : null, topProblems: [...s.types].sort((a, b) => b[1] - a[1]).slice(0, 3) }))
      .sort((a, b) => b.invalid - a.invalid || b.total - a.total);
  };

  /* ---- comparing two captures ---- */
  const status = (a, b) => (!a ? "new" : !b ? "gone" : "both");
  lib.captureDiff = function (A, B) {
    const aa = A.analysis(), ab = B.analysis(), minutes = x => Math.max(x.spanMs / 60000, 1 / 60);
    const nameMap = x => new Map(x.messages.map(n => [n.name, n]));
    const na = nameMap(aa), nb = nameMap(ab);
    const names = [...new Set([...na.keys(), ...nb.keys()])].map(name => {
      const x = na.get(name), y = nb.get(name);
      const rate = (n, an) => (n ? n.count / minutes(an) : 0);
      const bad = n => (n && n.valid + n.invalid ? n.invalid / (n.valid + n.invalid) : null);
      return { name, status: status(x, y), a: x ? x.count : 0, b: y ? y.count : 0, rateA: rate(x, aa), rateB: rate(y, ab), invalidA: x ? x.invalid : 0, invalidB: y ? y.invalid : 0,
        invalidRateA: bad(x), invalidRateB: bad(y), unknownA: x ? x.unknown : 0, unknownB: y ? y.unknown : 0 };
    }).sort((p, q) => (p.status === "both") - (q.status === "both") || Math.abs(q.rateB - q.rateA) - Math.abs(p.rateB - p.rateA));
    const sa = new Map(A.bus(0).map(s => [s.id, s])), sb = new Map(B.bus(0).map(s => [s.id, s]));
    const systems = [...new Set([...sa.keys(), ...sb.keys()])].map(id => ({ id, status: status(sa.get(id), sb.get(id)), a: sa.has(id) ? sa.get(id).count : 0, b: sb.has(id) ? sb.get(id).count : 0 }))
      .sort((p, q) => (p.status === "both") - (q.status === "both") || q.a + q.b - (p.a + p.b));
    const topics = x => new Set(x.messages.flatMap(n => n.topics)), ta = topics(aa), tb = topics(ab);
    const lat = (x, y) => (x.latency && y.latency ? { p50: [x.latency.p50, y.latency.p50], p95: [x.latency.p95, y.latency.p95] } : null);
    return {
      totals: { a: aa.total, b: ab.total, invalidA: aa.invalid, invalidB: ab.invalid, unknownA: aa.unknown, unknownB: ab.unknown, spanA: aa.spanMs, spanB: ab.spanMs },
      names, systems, topicsOnlyA: [...ta].filter(t => !tb.has(t)).sort(), topicsOnlyB: [...tb].filter(t => !ta.has(t)).sort(), latency: lat(aa, ab),
      newTypes: names.filter(n => n.status === "new").map(n => n.name), goneTypes: names.filter(n => n.status === "gone").map(n => n.name),
      newSystems: systems.filter(s => s.status === "new").map(s => s.id), goneSystems: systems.filter(s => s.status === "gone").map(s => s.id),
    };
  };
  const ms = v => (Number.isFinite(v) ? (v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms") : "-");
  lib.captureDiffMarkdown = function (d, { labelA = "A", labelB = "B" } = {}) {
    const L = [`# Capture comparison: ${labelA} vs ${labelB}`, "", `| | ${labelA} | ${labelB} |`, "|---|---|---|", `| Messages | ${d.totals.a.toLocaleString()} | ${d.totals.b.toLocaleString()} |`,
      `| Invalid | ${d.totals.invalidA.toLocaleString()} | ${d.totals.invalidB.toLocaleString()} |`, `| Not in schema | ${d.totals.unknownA.toLocaleString()} | ${d.totals.unknownB.toLocaleString()} |`];
    if (d.latency) L.push(`| Latency p50 | ${ms(d.latency.p50[0])} | ${ms(d.latency.p50[1])} |`, `| Latency p95 | ${ms(d.latency.p95[0])} | ${ms(d.latency.p95[1])} |`);
    const list = (title, xs) => { if (xs.length) L.push("", `## ${title}`, "", ...xs.map(x => "- " + x)); };
    list(`Message types only in ${labelB}`, d.newTypes); list(`Message types only in ${labelA}`, d.goneTypes);
    list(`Systems only in ${labelB}`, d.newSystems); list(`Systems only in ${labelA}`, d.goneSystems);
    list(`Topics only in ${labelB}`, d.topicsOnlyB); list(`Topics only in ${labelA}`, d.topicsOnlyA);
    L.push("", "## Message types", "", `| Type | ${labelA} | ${labelB} | rate/min ${labelA} | rate/min ${labelB} | invalid ${labelA} | invalid ${labelB} |`, "|---|---|---|---|---|---|---|");
    for (const n of d.names) L.push(`| ${n.name} | ${n.a} | ${n.b} | ${n.rateA.toFixed(1)} | ${n.rateB.toFixed(1)} | ${n.invalidA} | ${n.invalidB} |`);
    return L.join("\n") + "\n";
  };

  /* ---- report ---- */
  lib.captureReport = function (store, { title = "Traffic report", now = new Date() } = {}) {
    const an = store.analysis(), bus = store.bus(now.getTime()), cf = lib.conformance(store), tx = store.transactions({ min: 2 }).sort((a, b) => b.span - a.span).slice(0, 10);
    const checked = an.valid + an.invalid, pass = checked ? an.valid / checked : null;
    const data = { title, generated: now.toISOString(), total: an.total, spanMs: an.spanMs, systems: an.systems, valid: an.valid, invalid: an.invalid, unknown: an.unknown, passRate: pass,
      duplicates: an.duplicates, outOfOrder: an.outOfOrder, latency: an.latency, bus: bus.slice(0, 20), messages: an.messages, conformance: cf, slowTransactions: tx, gaps: an.gaps.slice(0, 10), schema: !!store.model };
    const pc = v => (v === null ? "n/a" : (v * 100).toFixed(1) + "%");
    const L = [`# ${title}`, "", `Generated ${data.generated}. ${store.model ? "Validated against the loaded schema." : "No schema was loaded, so nothing was validated."}`, "",
      "## Summary", "", `- Messages: ${an.total.toLocaleString()} over ${ms(an.spanMs)} from ${an.systems} system${an.systems === 1 ? "" : "s"}`,
      `- Validation: ${an.valid.toLocaleString()} valid, ${an.invalid.toLocaleString()} invalid, pass rate ${pc(pass)}`, `- Message types not in the schema: ${an.unknown.toLocaleString()} messages`,
      `- Duplicates: ${an.duplicates}, out of order: ${an.outOfOrder}`];
    if (an.latency) L.push(`- Latency (receive time minus header timestamp): p50 ${ms(an.latency.p50)}, p95 ${ms(an.latency.p95)}, max ${ms(an.latency.max)}`);
    L.push("", "## Who was on the bus", "", "| System | Messages | Types | Last seen |", "|---|---|---|---|", ...bus.slice(0, 20).map(s => `| ${s.id} | ${s.count} | ${s.types} | ${new Date(s.last).toISOString()} |`));
    L.push("", "## Message types", "", "| Type | Count | Valid | Invalid | Not in schema | Most common problem |", "|---|---|---|---|---|---|", ...an.messages.slice(0, 40).map(n => `| ${n.name} | ${n.count} | ${n.valid} | ${n.invalid} | ${n.unknown} | ${n.errors[0] ? n.errors[0][0].replace(/\|/g, "/") + " (" + n.errors[0][1] + ")" : ""} |`));
    L.push("", "## Conformance by service", "", "| Service | Messages | Valid | Invalid | Pass rate |", "|---|---|---|---|---|", ...cf.map(s => `| ${s.service} | ${s.total} | ${s.valid} | ${s.invalid} | ${pc(s.passRate)} |`));
    if (tx.length) L.push("", "## Slowest transactions", "", "| Identifier | Messages | Span | Types |", "|---|---|---|---|", ...tx.map(t => `| ${t.uuid} | ${t.count} | ${ms(t.span)} | ${t.names.join(", ")} |`));
    if (data.gaps.length) L.push("", "## Silences", "", "| System | Type | Gap | Normal interval |", "|---|---|---|---|", ...data.gaps.map(g => `| ${g.system} | ${g.name} | ${ms(g.gapMs)} | ${ms(g.medianMs)} |`));
    const markdown = L.join("\n") + "\n";
    return { data, markdown, html: lib.reportHtml(markdown, title) };
  };

  /* A tiny Markdown subset (headings, bullets, tables, paragraphs) to a standalone page. */
  lib.reportHtml = function (md, title) {
    const out = []; let table = null, list = false;
    const flush = () => { if (table) { out.push(`<table>${table.map((r, i) => `<tr>${r.map(c => `<${i ? "td" : "th"}>${esc(c)}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`); table = null; } if (list) { out.push("</ul>"); list = false; } };
    for (const line of md.split("\n")) {
      if (line.startsWith("|")) { const cells = line.slice(1, -1).split("|").map(c => c.trim()); if (cells.every(c => /^-+$/.test(c))) continue; (table = table || []).push(cells); continue; }
      flush();
      if (line.startsWith("# ")) out.push(`<h1>${esc(line.slice(2))}</h1>`);
      else if (line.startsWith("## ")) out.push(`<h2>${esc(line.slice(3))}</h2>`);
      else if (line.startsWith("- ")) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${esc(line.slice(2))}</li>`); }
      else if (line.trim()) out.push(`<p>${esc(line)}</p>`);
    }
    flush();
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 16px;color:#1f2328}table{border-collapse:collapse;margin:8px 0 20px;width:100%}th,td{border:1px solid #d0d7de;padding:5px 9px;text-align:left;font-size:13px}th{background:#f0f3f6}h1{font-size:28px}h2{margin-top:28px;border-bottom:1px solid #d0d7de;padding-bottom:4px}</style></head><body>${out.join("\n")}</body></html>`;
  };
})();
