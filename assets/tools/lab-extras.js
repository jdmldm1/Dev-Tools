/* Extra tabs for the traffic views (lib.trafficLab extraTabs), shared by the UCI Traffic Lab and the Analyze tab of the NATS and CAL explorers:
     Search        find messages by field values across the recording ("Latitude > 34 and SystemID = alpha")
     Conformance   pass / fail per service, with a downloadable report
   and, in the Traffic Lab only:
     Compare       compare the loaded capture with a second one
     Live          stream a running NATS server or LA-CAL straight into the lab
   lib.labExtras(store, { getModel, compare, live }) -> [{ key, label, render(el) }] */
(function () {
  const lib = DT.lib, esc = DT.esc, TD = new TextDecoder();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const clock = t => new Date(t).toISOString().slice(11, 23);
  const pc = v => (v === null || v === undefined ? "n/a" : (v * 100).toFixed(1) + "%");
  const tick = () => new Promise(r => setTimeout(r, 0));
  const save = (name, text, type) => DT.download(name, text, type);

  /* ---------- Search ---------- */
  function searchTab(store, getModel) {
    return { key: "search", label: "Search", render(host) {
      host.innerHTML = `<div class="hint" style="margin:6px 0">Find messages by what is inside them. Conditions are <code>path op value</code> joined by <code>and</code> / <code>or</code>; ops are <code>= != &gt; &gt;= &lt; &lt;= ~</code> (<code>~</code> contains, or <code>/regex/</code>) and <code>exists</code>. A path may be just the end of the full one: <code>Latitude</code> finds <code>Pos.Point.Latitude</code>. A bare word searches the whole message. Examples: <code>Latitude &gt; 0.6 and SystemID.UUID ~ 1111</code>, <code>topic ~ alpha</code>, <code>Status = FAILED or Status = ERROR</code>.</div>
        <div class="opts"><input type="text" id="qs" class="mono" style="width:min(520px,100%)" placeholder="Latitude > 0.5 and SystemID = alpha" spellcheck="false"><button class="btn primary" id="qgo" type="button">Search</button><button class="btn" id="qstop" type="button" hidden>Stop</button><button class="btn" id="qexp" type="button" hidden>Export matches</button></div>
        <div class="status" id="qst"></div><div class="meter" style="height:6px;background:var(--surface2);border-radius:3px;overflow:hidden"><div id="qbar" style="height:100%;width:0;background:var(--accent)"></div></div>
        <div class="two"><div class="tscroll" style="max-height:40vh"><table class="nl"><tbody id="qrows"></tbody></table></div><div id="qdet"></div></div>`;
      const $ = s => host.querySelector(s), st = (k, m) => DT.status($("#qst"), k, m);
      let hits = [], stop = false, running = false;
      const show = rec => {
        const text = rec.text, f = lib.payloadFields(text);
        let pretty = text; try { pretty = f.kind === "xml" ? lib.xmlFormat(text) : f.kind === "json" ? JSON.stringify(JSON.parse(text), null, 2) : text; } catch (_) { /* keep raw */ }
        $("#qdet").innerHTML = `<div class="panel">${DT.kv([["time", clock(rec.t)], ["topic", rec.topic], ["format", f.kind]])}<pre class="out" id="qpre" style="max-height:30vh;overflow:auto"></pre></div>`;
        $("#qpre").textContent = pretty.slice(0, 20000);
      };
      $("#qrows").onclick = e => { const tr = e.target.closest("tr[data-i]"); if (tr) show(hits[+tr.dataset.i]); };
      $("#qstop").onclick = () => { stop = true; };
      $("#qexp").onclick = () => { if (hits.length) save("matches.jsonl", lib.capStringify(hits), "application/x-ndjson"); };
      $("#qs").addEventListener("keydown", e => { if (e.key === "Enter") $("#qgo").click(); });
      $("#qgo").onclick = async () => {
        if (running) return;
        const q = lib.fieldQuery($("#qs").value); if (!q.ok) return st("err", q.error);
        const recs = store.records, total = recs.length; if (!total) return st("warn", "There are no messages to search.");
        running = true; stop = false; hits = []; $("#qgo").hidden = true; $("#qstop").hidden = false; $("#qrows").innerHTML = ""; $("#qdet").innerHTML = "";
        let i = 0, shown = 0;
        while (i < total && !stop && host.isConnected) {
          const end = performance.now() + 14;
          while (i < total && performance.now() < end) {
            const r = recs[i++], pf = lib.payloadFields(r.text);
            if (q.test(pf.fields, { raw: r.text, topic: r.topic })) hits.push(r);
          }
          $("#qbar").style.width = (100 * i / total).toFixed(1) + "%"; st("", `Searched ${i.toLocaleString()} of ${total.toLocaleString()}: ${hits.length.toLocaleString()} match${hits.length === 1 ? "" : "es"}…`);
          await tick();
        }
        running = false; $("#qgo").hidden = false; $("#qstop").hidden = true;
        $("#qrows").innerHTML = hits.slice(0, 300).map((r, n) => `<tr data-i="${n}"><td class="t">${clock(r.t)}</td><td class="s">${esc(r.topic)}</td><td class="p">${esc(r.text.replace(/\s+/g, " ").slice(0, 110))}</td></tr>`).join("") || `<tr><td class="t">No message matches.</td></tr>`;
        $("#qexp").hidden = !hits.length; shown = Math.min(300, hits.length);
        st(hits.length ? "ok" : "warn", `${stop ? "Stopped. " : ""}${hits.length.toLocaleString()} match${hits.length === 1 ? "" : "es"} in ${i.toLocaleString()} message${i === 1 ? "" : "s"}${hits.length > shown ? `, showing the first ${shown}` : ""}.`);
      };
    } };
  }

  /* ---------- Conformance and report ---------- */
  function conformanceTab(store, getModel) {
    return { key: "conf", label: "Conformance", render(host) {
      const model = getModel && getModel();
      host.innerHTML = `<div class="opts" style="margin:6px 0"><button class="btn" id="cmd" type="button">Download report (Markdown)</button><button class="btn" id="chtml" type="button">Download report (HTML)</button><button class="btn" id="cref" type="button">Refresh</button></div>
        <div class="hint">Every service's messages checked against the loaded schema. The report also covers who was on the bus, message types, slowest transactions and silences.</div><div id="cbody"></div>`;
      const $ = s => host.querySelector(s);
      const draw = () => {
        if (!store.model) { $("#cbody").innerHTML = `<div class="status warn">Load a schema (above) so messages can be validated.</div>`; return; }
        const rows = lib.conformance(store), tot = rows.reduce((a, r) => ({ v: a.v + r.valid, i: a.i + r.invalid }), { v: 0, i: 0 });
        $("#cbody").innerHTML = `<div class="tiles"><div class="tile"><div class="tl">Overall pass rate</div><div class="tv">${pc(tot.v + tot.i ? tot.v / (tot.v + tot.i) : null)}</div></div><div class="tile"><div class="tl">Invalid messages</div><div class="tv">${tot.i.toLocaleString()}</div></div><div class="tile"><div class="tl">Services</div><div class="tv">${rows.length}</div></div></div>
          <div class="tscroll" style="max-height:44vh"><table class="kv"><thead><tr><th>Service</th><th>Messages</th><th>Valid</th><th>Invalid</th><th>Not in schema</th><th>Pass rate</th><th>Most common problems</th></tr></thead><tbody>${rows.map(r => `<tr><td class="v">${esc(r.service)}</td><td>${r.total.toLocaleString()}</td><td>${r.valid.toLocaleString()}</td><td>${r.invalid ? `<b style="color:var(--bad)">${r.invalid.toLocaleString()}</b>` : "0"}</td><td>${r.unknown}</td><td>${pc(r.passRate)}</td><td class="v">${esc(r.topProblems.map(p => p[0] + " (" + p[1] + ")").join(" · "))}</td></tr>`).join("") || `<tr><td colspan="7" class="hint">Nothing decoded yet.</td></tr>`}</tbody></table></div>`;
      };
      $("#cref").onclick = () => { if (store.pending) store.process(200); draw(); };
      const report = () => { while (store.pending) store.process(200); return lib.captureReport(store, { title: "Traffic report" }); };
      $("#cmd").onclick = () => save("traffic-report.md", report().markdown, "text/markdown");
      $("#chtml").onclick = () => save("traffic-report.html", report().html, "text/html");
      draw();
    } };
  }

  /* ---------- Compare (Traffic Lab) ---------- */
  function compareTab(store, getModel) {
    return { key: "compare", label: "Compare", render(host) {
      host.innerHTML = `<div class="hint" style="margin:6px 0">Compare the capture loaded in the lab (A) with a second one (B): message types, systems and topics that appeared or vanished, rates, validity and latency. Handy for checking a new software version against a known-good recording.</div>
        <div class="opts"><button class="btn primary" id="cpick" type="button">Load capture B…</button><input type="file" id="cfile" accept=".jsonl,.json,.ndjson,.txt" hidden><button class="btn" id="cmd2" type="button" hidden>Download as Markdown</button></div>
        <div class="status" id="cst"></div><div class="meter" style="height:6px;background:var(--surface2);border-radius:3px;overflow:hidden"><div id="cbar" style="height:100%;width:0;background:var(--accent)"></div></div><div id="cres"></div>`;
      const $ = s => host.querySelector(s), st = (k, m) => DT.status($("#cst"), k, m);
      let last = null, label = "B";
      const finish = async s => { while (s.pending && host.isConnected) { s.process(14); $("#cbar").style.width = (100 * (1 - s.pending / Math.max(1, s.records.length))).toFixed(0) + "%"; await tick(); } };
      $("#cpick").onclick = () => $("#cfile").click();
      $("#cfile").onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        if (!store.records.length) return st("err", "Load capture A into the lab first (Load capture files…).");
        try {
          label = f.name; st("", "Reading " + f.name + "…");
          const B = new lib.TrafficStore(getModel ? getModel() : store.model, { max: 200000, validate: true }), r = lib.capParse(await f.text()); B.addMany(r.records);
          if (!r.records.length) return st("err", "No messages could be read from that file.");
          st("", "Decoding capture B…"); await finish(B);
          st("", "Decoding capture A…"); await finish(store);
          last = lib.captureDiff(store, B); draw(last, f.name);
          st("ok", `Compared ${last.totals.a.toLocaleString()} messages (A) with ${last.totals.b.toLocaleString()} (${f.name}).`);
        } catch (err) { st("err", err.message); }
      };
      $("#cmd2").onclick = () => { if (last) save("capture-comparison.md", lib.captureDiffMarkdown(last, { labelA: "A", labelB: label }), "text/markdown"); };
      function draw(d, name) {
        $("#cmd2").hidden = false;
        const ms = v => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms") : "-");
        const list = (title, xs, kind) => xs.length ? `<div class="panel"><b>${title}</b> (${xs.length}): ${xs.slice(0, 40).map(x => `<span class="chip" style="cursor:default${kind === "new" ? ";color:var(--green)" : ";color:var(--warn)"}">${esc(x)}</span>`).join(" ")}${xs.length > 40 ? " …" : ""}</div>` : "";
        $("#cres").innerHTML = `<div class="tiles">${[["Messages A", d.totals.a], ["Messages B", d.totals.b], ["Invalid A", d.totals.invalidA], ["Invalid B", d.totals.invalidB]].map(([l, v]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${v.toLocaleString()}</div></div>`).join("")}${d.latency ? `<div class="tile"><div class="tl">Latency p50 A → B</div><div class="tv">${ms(d.latency.p50[0])} → ${ms(d.latency.p50[1])}</div></div><div class="tile"><div class="tl">Latency p95 A → B</div><div class="tv">${ms(d.latency.p95[0])} → ${ms(d.latency.p95[1])}</div></div>` : ""}</div>
          ${list("Message types only in " + esc(name), d.newTypes, "new")}${list("Message types only in A", d.goneTypes, "gone")}${list("Systems only in " + esc(name), d.newSystems, "new")}${list("Systems only in A", d.goneSystems, "gone")}${list("Topics only in " + esc(name), d.topicsOnlyB, "new")}${list("Topics only in A", d.topicsOnlyA, "gone")}
          <div class="tscroll" style="max-height:40vh"><table class="kv"><thead><tr><th>Message type</th><th></th><th>A</th><th>B</th><th>per min A</th><th>per min B</th><th>invalid A</th><th>invalid B</th></tr></thead><tbody>${d.names.map(n => `<tr><td class="v">${esc(n.name)}</td><td>${n.status === "new" ? "new" : n.status === "gone" ? "gone" : ""}</td><td>${n.a}</td><td>${n.b}</td><td>${n.rateA.toFixed(1)}</td><td>${n.rateB.toFixed(1)}</td><td>${n.invalidA}</td><td>${n.invalidB}</td></tr>`).join("")}</tbody></table></div>`;
      }
    } };
  }

  /* ---------- Live source (Traffic Lab) ---------- */
  function liveTab(store, getModel) {
    /* The stream belongs to the tab, not to what is on screen: leaving the tab and coming back shows the same running stream. */
    let client = null, count = 0, timer = 0, stopper = null, cur = null;
    const $ = s => (cur ? cur.querySelector(s) : null), st = (k, m) => { const e = $("#lst"); if (e) DT.status(e, k, m); };
    const stop = msg => { clearInterval(timer); timer = 0; try { if (client) client.close(); } catch (_) { /* closed */ } client = null; stopper = null; if ($("#lgo")) { $("#lgo").hidden = false; $("#lstop").hidden = true; } if (msg !== undefined) st("", msg); };
    return { key: "live", label: "Live source", destroy() { if (stopper) stopper(); }, render(host) {
      cur = host;
      host.innerHTML = `<div class="hint" style="margin:6px 0">Stream a running NATS server or LA-CAL straight into this lab: the Bus, Transactions, Analysis, Map, Search and Conformance views keep updating while messages arrive. Messages are added to the loaded capture (newest ${store.max.toLocaleString()} kept).</div>
        <div class="two"><div class="col"><label class="l">Source</label><select id="lt" class="mono"><option value="nats">NATS (WebSocket)</option><option value="cal">LA-CAL (OWP)</option></select>
            <label class="l" for="lu">WebSocket URL</label><input type="text" id="lu" class="mono" value="ws://127.0.0.1:18080" spellcheck="false">
            <label class="l" for="ls" id="lsl">Subjects (space separated)</label><textarea id="ls" class="sm mono" spellcheck="false">uci.&gt;</textarea></div>
          <div class="col"><div id="lcal" hidden class="three"><div class="col"><label class="l" for="lsv">Service id</label><input type="text" id="lsv" class="mono" value="DemoService"></div><div class="col"><label class="l" for="lsc">Schema version</label><input type="text" id="lsc" class="mono"></div><div class="col"><label class="l" for="lov">OWP versions</label><input type="text" id="lov" class="mono" value="1.0"></div></div>
            <div class="hint" id="lhint">One subject pattern per word. <code>&gt;</code> takes everything.</div></div></div>
        <div class="btns"><button class="btn primary" id="lgo" type="button">Start streaming</button><button class="btn" id="lstop" type="button" hidden>Stop</button><button class="btn" id="lsave" type="button">Save capture</button></div>
        <div class="status" id="lst"></div>`;
      if (client) { $("#lgo").hidden = true; $("#lstop").hidden = false; st("ok", `Streaming: ${count.toLocaleString()} messages so far.`); }
      $("#lt").onchange = () => { const cal = $("#lt").value === "cal"; $("#lcal").hidden = !cal; $("#lu").value = cal ? "ws://127.0.0.1:9100" : "ws://127.0.0.1:18080"; $("#lsl").textContent = cal ? "Subscriptions (one per line: topic MessageName)" : "Subjects (space separated)"; $("#ls").value = cal ? "" : "uci.>"; $("#lhint").textContent = cal ? "OWP has no wildcards: name each topic and the message to expect." : "One subject pattern per word. > takes everything."; };
      $("#lsave").onclick = () => { if (store.records.length) save("capture.jsonl", lib.capStringify(store.records), "application/x-ndjson"); };
      $("#lstop").onclick = () => stop(`Stopped after ${count.toLocaleString()} messages.`);
      $("#lgo").onclick = async () => {
        $("#lgo").disabled = true; count = 0; st("", "Connecting…");
        try {
          if ($("#lt").value === "nats") {
            client = new lib.NatsClient(); await client.connect($("#lu").value.trim());
            const subs = $("#ls").value.split(/\s+/).filter(Boolean); if (!subs.length) throw new Error("Enter at least one subject.");
            for (const s of subs) client.subscribe(s, m => {
              if (!m.payload.length || m.payload.length > 3e6) return; const c = m.payload[0];
              if (c !== 60 && c !== 123 && c !== 32 && c !== 10 && c !== 13) return;
              let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(m.payload); } catch (_) { return; }
              store.add({ t: Date.now(), topic: m.subject, text, source: "nats" }); count++;
            });
            client.onclose = r => stop("Connection lost: " + r + ".");
          } else {
            const model = getModel && getModel(), schema = $("#lsc").value.trim() || (model && lib.schemaVersion(model));
            if (!schema) throw new Error("Enter the schema version (or load the schema).");
            const subs = $("#ls").value.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => l.split(/\s+/)); if (!subs.length) throw new Error("Add at least one topic and message name.");
            client = new lib.OwpClient(); client.onmsg = ({ sub, text }) => { store.add({ t: Date.now(), topic: sub.topic, text, source: "cal" }); count++; };
            client.onclose = r => stop("Connection lost: " + r + ".");
            await client.connect($("#lu").value.trim(), { versions: $("#lov").value.split(/[ ,]+/).filter(Boolean), schema, serviceId: $("#lsv").value.trim() });
            const failed = []; for (const [topic, message] of subs) { try { await client.subscribe(message, topic); } catch (e) { failed.push(`${topic}: ${e.code || e.message}`); } }
            if (failed.length) st("warn", `${failed.length} subscription${failed.length === 1 ? "" : "s"} refused: ${failed.slice(0, 3).join("; ")}`);
          }
          $("#lgo").hidden = true; $("#lstop").hidden = false; stopper = () => stop();
          timer = setInterval(() => { if (!cur || !cur.isConnected) return stop(); st("ok", `Streaming: ${count.toLocaleString()} messages so far (${store.records.length.toLocaleString()} in the lab).`); }, 1000);
        } catch (e) { st("err", e.message); stop(); }
        $("#lgo").disabled = false;
      };
    } };
  }

  lib.labExtras = function (store, { getModel, compare = false, live = false } = {}) {
    const tabs = [searchTab(store, getModel), conformanceTab(store, getModel)];
    if (compare) tabs.push(compareTab(store, getModel));
    if (live) tabs.push(liveTab(store, getModel));
    return tabs;
  };
})();
