/* Bridge Compare: watch the same UCI messages arrive over NATS (XML) and over an LA-CAL (OMS JSON), pair them up, and report
   how long each took to cross, what is missing on either side, and which fields differ after conversion.
   The matching logic (lib.bridgeEvent, lib.BridgeMatcher) is separate from the page so it can be tested without a browser. */
(function () {
  const lib = DT.lib, esc = DT.esc;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const local = n => String(n).replace(/^[^:]+:/, "");

  /* One observed message -> { src, t, name, key, fields (comparison form), native (path -> value), text }.
     src is "nats" (XML) or "cal" (OMS JSON). With a model, NATS XML is converted to OMS JSON so both sides compare as JSON. */
  lib.bridgeEvent = function (src, text, t, model) {
    const native = lib.payloadFields(text);
    let name = "", fields = native.fields, converted = false;
    if (native.kind === "xml") { try { name = local(lib.xmlParse(text).root.name); } catch (_) { /* not XML after all */ } }
    else if (native.kind === "json") { const m = /^\s*\{\s*"([^"]+)"/.exec(text); if (m) name = local(m[1]); }
    if (src === "nats" && native.kind === "xml" && model && name && model.elements.has(name)) {
      try { fields = lib.payloadFields(lib.owpXmlToJson(model, text, 0)).fields; converted = true; } catch (_) { /* keep the XML fields */ }
    }
    const header = (suffix) => { for (const [p, v] of native.fields) if (p.toLowerCase().endsWith(suffix)) return String(v); return ""; };
    const ids = [...native.fields].filter(([p, v]) => typeof v === "string" && UUID.test(v) && !/messageheader\.(systemid|serviceid)/i.test(p)).map(([, v]) => v.toLowerCase()).sort();
    const sys = header("messageheader.systemid.uuid") || header("messageheader.systemid"), ts = header("messageheader.timestamp");
    let key = [name, sys.toLowerCase(), ts, ids.join(",")].join("|");
    if (!sys && !ts && !ids.length) key = name + "|#" + [...fields].map(([p, v]) => p + "=" + v).join(";").slice(0, 400);       // nothing identifying: fall back to the content itself
    return { src, t, name, key, fields, converted, text };
  };

  /* Pairs events with the same key from the two sides. add() returns the pair when this event completes one. */
  lib.BridgeMatcher = class {
    constructor({ windowMs = 5000, keep = 500 } = {}) { this.windowMs = windowMs; this.keep = keep; this.clear(); }
    clear() { this.pending = new Map(); this.pairs = []; this.unmatched = []; this.counts = { nats: 0, cal: 0, matched: 0, mismatched: 0, onlyNats: 0, onlyCal: 0 }; this.lat = []; }
    add(ev) {
      this.counts[ev.src]++;
      const other = ev.src === "nats" ? "cal" : "nats", q = this.pending.get(ev.key);
      const i = q ? q.findIndex(e => e.src === other) : -1;
      if (i >= 0) {
        const o = q.splice(i, 1)[0]; if (!q.length) this.pending.delete(ev.key);
        const n = ev.src === "nats" ? ev : o, c = ev.src === "cal" ? ev : o;
        const cmp = n.converted ? lib.bridgeFieldDiff(n.fields, c.fields) : null;          // only comparable when the XML was converted to OMS JSON
        const pair = { key: ev.key, name: ev.name, nats: n, cal: c, latencyMs: c.t - n.t, diff: cmp };
        this.counts.matched++; if (cmp && !cmp.same) this.counts.mismatched++;
        this.lat.push(pair.latencyMs); if (this.lat.length > 5000) this.lat.splice(0, this.lat.length - 5000);
        this.pairs.push(pair); if (this.pairs.length > this.keep) this.pairs.splice(0, this.pairs.length - this.keep);
        return pair;
      }
      if (!this.pending.has(ev.key)) this.pending.set(ev.key, []);
      this.pending.get(ev.key).push(ev);
      return null;
    }
    /* Events still waiting after the window have no partner. */
    sweep(now = Date.now()) {
      for (const [key, q] of this.pending) {
        const keep = [];
        for (const e of q) {
          if (now - e.t < this.windowMs) { keep.push(e); continue; }
          this.counts[e.src === "nats" ? "onlyNats" : "onlyCal"]++;
          this.unmatched.push({ side: e.src, ev: e }); if (this.unmatched.length > this.keep) this.unmatched.splice(0, this.unmatched.length - this.keep);
        }
        if (keep.length) this.pending.set(key, keep); else this.pending.delete(key);
      }
    }
    stats(now = Date.now()) {
      this.sweep(now);
      const sorted = this.lat.slice().sort((a, b) => a - b);
      return { ...this.counts, waiting: [...this.pending.values()].reduce((s, q) => s + q.length, 0),
        latency: sorted.length ? { min: sorted[0], p50: lib.percentile ? lib.percentile(sorted, 50) : sorted[Math.floor(sorted.length / 2)], p95: lib.percentile ? lib.percentile(sorted, 95) : sorted[Math.floor(sorted.length * .95)], max: sorted[sorted.length - 1] } : null };
    }
  };
  /* Field-level comparison of two flattened payloads (Map path -> value), loosely. */
  lib.bridgeFieldDiff = function (a, b) {
    const changes = [];
    for (const p of new Set([...a.keys(), ...b.keys()])) {
      const ha = a.has(p), hb = b.has(p);
      if (ha && !hb) changes.push({ path: p, type: "removed", a: a.get(p), b: undefined });
      else if (!ha && hb) changes.push({ path: p, type: "added", a: undefined, b: b.get(p) });
      else if (!lib.looseEq(a.get(p), b.get(p))) changes.push({ path: p, type: "changed", a: a.get(p), b: b.get(p) });
    }
    return { structured: true, same: !changes.length, changes };
  };

  const hhmmss = t => new Date(t).toISOString().slice(11, 23);
  const ms = v => (v === null || v === undefined ? "-" : (Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms"));
  let current = null;

  DT.register({
    id: "bridge", name: "Bridge Compare (NATS vs CAL)", group: "UCI",
    desc: "Connect to a NATS server and an LA-CAL at the same time and pair up the same UCI message arriving on both: how long each took to cross, which messages are missing on either side, and which fields differ after conversion between XML and OMS JSON.",
    keywords: "bridge compare nats cal owp latency translation conversion mismatch missing uci xml json gateway",
    destroy() { if (current) { try { current(); } catch (_) {} current = null; } },
    render(root) {
      if (current) { try { current(); } catch (_) {} current = null; }
      const $ = s => root.querySelector(s);
      let model = lib.sharedSchema.model, nats = null, cal = null, timer = 0, sel = null;
      const matcher = new lib.BridgeMatcher({ windowMs: 5000 });
      root.innerHTML = `
        <div class="two">
          <div class="panel"><h3 style="margin:0 0 6px">NATS</h3>
            <div class="col"><label class="l" for="nurl">WebSocket URL</label><input type="text" id="nurl" class="mono" value="ws://127.0.0.1:18080" spellcheck="false"></div>
            <div class="col"><label class="l" for="nsub">Subjects (space separated)</label><input type="text" id="nsub" class="mono" value="uci.>" spellcheck="false"></div></div>
          <div class="panel"><h3 style="margin:0 0 6px">LA-CAL (OWP)</h3>
            <div class="col"><label class="l" for="curl">WebSocket URL</label><input type="text" id="curl" class="mono" value="ws://127.0.0.1:9100" spellcheck="false"></div>
            <div class="three"><div class="col"><label class="l" for="csvc">Service id</label><input type="text" id="csvc" class="mono" value="DemoService"></div>
              <div class="col"><label class="l" for="csch">Schema version</label><input type="text" id="csch" class="mono" placeholder="from the loaded schema"></div>
              <div class="col"><label class="l" for="cver">OWP versions</label><input type="text" id="cver" class="mono" value="1.0"></div></div>
            <div class="col"><label class="l" for="csubs">Subscriptions (one per line: topic MessageName)</label><textarea id="csubs" class="sm mono" spellcheck="false" placeholder="uci.alpha.PositionReport PositionReport"></textarea></div></div>
        </div>
        ${lib.schemaPanelHtml("conversion between XML and OMS JSON")}
        <div class="btns"><button class="btn primary" id="go" type="button">Start comparing</button><button class="btn" id="stop" type="button" hidden>Stop</button><button class="btn" id="clr" type="button">Clear</button>
          <label>Pairing window <input type="number" id="win" value="5" min="1" max="60" class="mono" style="width:70px"> s</label></div>
        <div class="status" id="st"></div>
        <div class="tiles" id="tiles"></div>
        <div class="two"><div class="col"><label class="l">Pairs (newest first)</label><div class="tscroll" style="max-height:34vh"><table class="nl"><tbody id="pairs"></tbody></table></div></div>
          <div class="col"><label class="l">Seen on one side only</label><div class="tscroll" style="max-height:34vh"><table class="nl"><tbody id="lone"></tbody></table></div></div></div>
        <div id="det" style="margin-top:10px"></div>`;
      const sp = lib.schemaPanel(root, m => { model = m; if (m && !$("#csch").value) $("#csch").value = lib.schemaVersion(m); });
      const st = (k, m) => DT.status($("#st"), k, m);

      const onNats = m => { const text = new TextDecoder().decode(m.payload); if (text.trimStart()[0] !== "<") return; matcher.add(lib.bridgeEvent("nats", text, Date.now(), model)); };
      const onCal = ({ text }) => matcher.add(lib.bridgeEvent("cal", text, Date.now(), model));
      function draw() {
        const s = matcher.stats();
        $("#tiles").innerHTML = [["Paired", s.matched.toLocaleString()], ["Field mismatches", s.mismatched.toLocaleString()], ["Only on NATS", s.onlyNats.toLocaleString()], ["Only on CAL", s.onlyCal.toLocaleString()],
          ["CAL minus NATS, median", s.latency ? ms(s.latency.p50) : "-"], ["p95", s.latency ? ms(s.latency.p95) : "-"], ["Waiting", s.waiting.toLocaleString()]].map(([l, v]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${esc(v)}</div></div>`).join("");
        $("#pairs").innerHTML = matcher.pairs.slice(-200).reverse().map((p, i) => `<tr data-i="${matcher.pairs.length - 1 - i}"><td class="t">${hhmmss(p.nats.t)}</td><td class="ty">${esc(p.name)}</td><td class="t">${ms(p.latencyMs)}</td><td class="p">${p.diff ? (p.diff.same ? "identical" : p.diff.changes.length + " field" + (p.diff.changes.length === 1 ? "" : "s") + " differ") : "not compared (load the schema)"}</td></tr>`).join("") || `<tr><td class="t">No pairs yet.</td></tr>`;
        $("#lone").innerHTML = matcher.unmatched.slice(-200).reverse().map((u, i) => `<tr data-u="${matcher.unmatched.length - 1 - i}"><td class="t">${hhmmss(u.ev.t)}</td><td class="s">${u.side === "nats" ? "NATS only" : "CAL only"}</td><td class="ty">${esc(u.ev.name)}</td></tr>`).join("") || `<tr><td class="t">Nothing is missing so far.</td></tr>`;
      }
      function showPair(p) {
        const rows = p.diff ? p.diff.changes.map(c => `<tr><td class="s">${esc(c.path)}</td><td class="v">${esc(c.a === undefined ? "(absent)" : String(c.a))}</td><td class="v">${esc(c.b === undefined ? "(absent)" : String(c.b))}</td><td class="t">${c.type}</td></tr>`).join("") : "";
        $("#det").innerHTML = `<div class="panel">${DT.kv([["message", p.name], ["NATS received", hhmmss(p.nats.t)], ["CAL received", hhmmss(p.cal.t)], ["CAL minus NATS", ms(p.latencyMs)]])}
          ${p.diff ? (p.diff.same ? `<div class="status ok">All ${p.nats.fields.size} fields match after conversion.</div>` : `<table class="kv"><thead><tr><th>Field</th><th>NATS (as OMS JSON)</th><th>CAL</th><th></th></tr></thead><tbody>${rows}</tbody></table>`) : `<div class="hint">Load the schema above to compare fields.</div>`}</div>`;
      }
      $("#pairs").onclick = e => { const tr = e.target.closest("tr[data-i]"); if (tr) showPair(matcher.pairs[+tr.dataset.i]); };
      $("#lone").onclick = e => { const tr = e.target.closest("tr[data-u]"); const u = tr && matcher.unmatched[+tr.dataset.u]; if (u) $("#det").innerHTML = `<div class="panel"><div class="hint">${u.side === "nats" ? "Seen on NATS but not on the CAL within the window" : "Seen on the CAL but not on NATS within the window"}.</div><pre class="out">${esc(u.ev.text.slice(0, 4000))}</pre></div>`; };

      async function start() {
        matcher.windowMs = Math.max(1, +$("#win").value || 5) * 1000;
        const subs = $("#csubs").value.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => l.split(/\s+/));
        if (!subs.length) return st("err", "Add at least one CAL subscription (topic and message name).");
        const schema = $("#csch").value.trim() || lib.schemaVersion(model);
        if (!schema) return st("err", "Enter the CAL schema version, or load the schema.");
        $("#go").disabled = true; st("", "Connecting to both…");
        try {
          nats = new lib.NatsClient(); await nats.connect($("#nurl").value.trim());
          for (const s of $("#nsub").value.split(/\s+/).filter(Boolean)) nats.subscribe(s, onNats);
          cal = new lib.OwpClient(); cal.onmsg = onCal;
          await cal.connect($("#curl").value.trim(), { versions: $("#cver").value.split(/[ ,]+/).filter(Boolean), schema, serviceId: $("#csvc").value.trim() });
          const failed = [];
          for (const [topic, message] of subs) { try { await cal.subscribe(message, topic); } catch (e) { failed.push(`${topic}: ${e.code || e.message}`); } }
          st(failed.length ? "warn" : "ok", `Comparing. ${failed.length ? failed.length + " CAL subscription(s) refused: " + failed.slice(0, 3).join("; ") : ""}`);
          $("#go").hidden = true; $("#stop").hidden = false; timer = setInterval(() => { if (!root.isConnected) return stop(); draw(); }, 1000);
        } catch (e) { st("err", e.message); stop(true); }
        $("#go").disabled = false;
      }
      function stop(keepMsg) {
        clearInterval(timer); timer = 0;
        try { if (nats) nats.close(); } catch (_) {} try { if (cal) cal.close(); } catch (_) {}
        nats = cal = null; $("#go") && ($("#go").hidden = false); $("#stop") && ($("#stop").hidden = true);
        if (!keepMsg && $("#st")) st("", "Stopped.");
      }
      $("#go").onclick = start; $("#stop").onclick = () => stop();
      $("#clr").onclick = () => { matcher.clear(); $("#det").innerHTML = ""; draw(); };
      sp.start(); draw();
      current = () => stop(true);
      return () => stop(true);
    },
  });
})();
