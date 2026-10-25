/* UCI Traffic Lab: load saved captures (.jsonl from the NATS and CAL explorers) and look at them with the traffic views, or play them back
   into a NATS server or an LA-CAL. The views are in traffic-lab.js, the analysis in uci-analysis.js. */
(function () {
  const lib = DT.lib, esc = DT.esc;
  const TE = new TextEncoder();
  let kept = null;                                      // the loaded capture survives moving to another tool and back

  DT.register({
    id: "ucilab", name: "UCI Traffic Lab", group: "UCI",
    desc: "Load a capture saved from the NATS or CAL explorer (or any .jsonl of messages) and see who was on the bus, follow commands through their statuses, check validity, latency and gaps, replay positions on a map, and play the capture back into a NATS server or an LA-CAL at original or faster timing.",
    keywords: "uci capture replay playback analyze analysis bus transactions map tracks validation latency gaps jsonl record nats cal owp",
    render(root) {
      const $ = s => root.querySelector(s);
      const store = kept ? kept.store : new lib.TrafficStore(lib.sharedSchema.model, { max: 200000, validate: true });
      kept = { store };
      if (lib.pendingCapture) { store.addMany(lib.pendingCapture); lib.pendingCapture = null; }       // sent here by an explorer's "Open in Traffic Lab"
      let lab = null, playing = false, stopFlag = false;

      root.innerHTML = `
        <div class="panel">
          <div class="drop" id="drop"><div class="opts" style="margin:0"><button class="btn primary" id="pick" type="button">Load capture files…</button><button class="btn" id="clr" type="button">Clear</button>
            <label title="Check every message against the schema (slower, needs the schema loaded)"><input type="checkbox" id="val" checked> validate against the schema</label><span class="hint" id="sum"></span></div>
            <div class="hint" style="margin-top:6px">Drop <code>.jsonl</code> files here. Captures saved by the NATS Explorer, the CAL Explorer, or this page are all understood: one JSON object per line with a time, a subject or topic, and the message text. XML and OMS JSON messages are both fine. Several files are merged by time.</div>
            <input type="file" id="files" multiple accept=".jsonl,.json,.ndjson,.txt" hidden></div>
          ${lib.schemaPanelHtml("the messages")}
        </div>
        <div id="lab"></div>`;
      DT.wire(root);

      const sp = lib.schemaPanel(root, m => { store.reset(m, $("#val").checked); summary(); if (lab) lab.refresh(); });
      const summary = () => { const n = store.records.length; $("#sum").textContent = n ? `${n.toLocaleString()} messages · ${store.model ? "schema loaded" : "no schema loaded"}${store.dropped ? " · " + store.dropped.toLocaleString() + " oldest dropped" : ""}` : "Nothing loaded yet."; };

      async function load(files) {
        let total = 0, skipped = 0;
        for (const f of files) {
          $("#sum").textContent = `Reading ${f.name}…`;
          const r = lib.capParse(await f.text());
          store.addMany(r.records); total += r.records.length; skipped += r.skipped;
        }
        $("#sum").textContent = `${total.toLocaleString()} messages read${skipped ? `, ${skipped} lines skipped` : ""}. Decoding…`;
        if (lab) lab.refresh();
      }
      $("#pick").onclick = () => $("#files").click();
      $("#files").onchange = e => load([...e.target.files]);
      const drop = $("#drop");
      ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
      ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
      drop.addEventListener("drop", e => load([...e.dataTransfer.files]));
      $("#clr").onclick = () => { store.clear(); summary(); if (lab) lab.refresh(); };
      $("#val").onchange = () => { store.reset(store.model, $("#val").checked); if (lab) lab.refresh(); };

      /* ----- the Replay tab ----- */
      function renderReplay(el) {
        el.innerHTML = `<div class="hint" style="margin:6px 0">Plays the loaded messages into a server in their recorded order and timing. Messages are converted to what the target speaks (XML for NATS, OMS JSON for an LA-CAL) when a schema is loaded.</div>
          <div class="two">
            <div class="col"><label class="l">Target</label><select id="rt" class="mono"><option value="nats">NATS (WebSocket)</option><option value="cal">LA-CAL (OWP)</option></select>
              <label class="l" for="ru">WebSocket URL</label><input type="text" id="ru" class="mono" spellcheck="false" value="ws://127.0.0.1:18080">
              <div id="calf" hidden class="three"><div class="col"><label class="l" for="rsv">Service id</label><input type="text" id="rsv" class="mono" value="DemoService"></div><div class="col"><label class="l" for="rsc">Schema version</label><input type="text" id="rsc" class="mono"></div><div class="col"><label class="l" for="rov">OWP versions</label><input type="text" id="rov" class="mono" value="1.0"></div></div></div>
            <div class="col"><label class="l" for="rsp">Speed</label><select id="rsp" class="mono"><option value="1">original timing</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option><option value="0">as fast as possible</option></select>
              <label class="l" for="rf">Only messages containing</label><input type="text" id="rf" class="mono" placeholder="topic or message name, e.g. SystemStatus" spellcheck="false">
              <div class="opts"><label><input type="checkbox" id="rl"> loop</label><label><input type="checkbox" id="rc" checked> convert to the target's format</label><label title="Set each message's MessageHeader Timestamp to the time it is sent"><input type="checkbox" id="rs"> stamp with the current time</label></div></div>
          </div>
          <div class="btns"><button class="btn primary" id="rgo" type="button">Start</button><button class="btn" id="rstop" type="button" hidden>Stop</button></div>
          <div class="status" id="rst"></div><div class="meter" style="height:8px;background:var(--surface2);border-radius:4px;overflow:hidden"><div id="rbar" style="height:100%;width:0;background:var(--accent)"></div></div>`;
        const q = s => el.querySelector(s), st = (k, m) => DT.status(q("#rst"), k, m);
        q("#rt").onchange = e => { q("#calf").hidden = e.target.value !== "cal"; q("#ru").value = e.target.value === "cal" ? "ws://127.0.0.1:9100" : "ws://127.0.0.1:18080"; if (e.target.value === "cal" && !q("#rsc").value) q("#rsc").value = lib.schemaVersion(store.model); };
        q("#rstop").onclick = () => { stopFlag = true; };
        q("#rgo").onclick = async () => {
          if (playing) return;
          const recs = store.records; if (!recs.length) return st("err", "Load a capture first.");
          const kind = q("#rt").value, model = store.model, convert = q("#rc").checked, restamp = q("#rs").checked, needle = q("#rf").value.trim().toLowerCase();
          let client, send;
          try {
            st("", "Connecting…");
            if (kind === "nats") {
              client = new lib.NatsClient(); await client.connect(q("#ru").value.trim());
              send = async rec => {
                let text = restamp ? lib.capRestamp(rec.text) : rec.text;
                if (convert && model) text = lib.capConvert(model, { text }, "xml");
                let subj = rec.topic || "capture"; if (lib.natsSubjectProblem(subj, false)) subj = lib.capTopic(subj);
                client.publish(subj, TE.encode(text));
              };
            } else {
              const schema = q("#rsc").value.trim() || lib.schemaVersion(model);
              if (!schema) throw new Error("Enter the schema version the LA-CAL expects (or load its schema).");
              client = new lib.OwpClient(); await client.connect(q("#ru").value.trim(), { versions: q("#rov").value.split(/[ ,]+/).filter(Boolean), schema, serviceId: q("#rsv").value.trim() });
              send = async rec => {
                const text = restamp ? lib.capRestamp(rec.text) : rec.text;
                if (!model && text.trimStart().startsWith("<")) throw new Error("Load the schema to convert XML into OMS JSON.");
                await client.publish(lib.capTopic(rec.topic), convert && model ? lib.capConvert(model, { text }, "oms-json") : text);
              };
            }
          } catch (e) { return st("err", e.message); }
          playing = true; stopFlag = false; q("#rgo").hidden = true; q("#rstop").hidden = false;
          const filter = needle ? r => r.topic.toLowerCase().includes(needle) || (r.meta && r.meta.name || "").toLowerCase().includes(needle) || r.text.slice(0, 400).toLowerCase().includes(needle) : null;
          try {
            const res = await lib.capPlay(recs, send, {
              speed: +q("#rsp").value, loop: q("#rl").checked, filter, isStopped: () => stopFlag || !root.isConnected,
              onProgress: p => { q("#rbar").style.width = (100 * p.i / p.of).toFixed(1) + "%"; if (p.i % 20 === 0 || p.i === p.of) st(p.failed ? "warn" : "", `Sent ${p.sent.toLocaleString()} of ${p.of.toLocaleString()}${p.rounds ? " (round " + (p.rounds + 1) + ")" : ""}${p.failed ? `, ${p.failed} refused. Last: ${p.lastError}` : ""}`); },
            });
            st(res.failed ? "warn" : "ok", `${res.stopped ? "Stopped. " : "Done. "}Sent ${res.sent.toLocaleString()}${res.failed ? `, ${res.failed} refused (last: ${res.lastError})` : ""}.`);
          } catch (e) { st("err", e.message); }
          try { client.close(); } catch (_) { /* already closed */ }
          playing = false; q("#rgo").hidden = false; q("#rstop").hidden = true;
        };
      }

      lab = lib.trafficLab($("#lab"), { store, getModel: () => store.model, live: false, extraTabs: [{ key: "replay", label: "Replay", render: renderReplay }] });
      sp.start(); summary();
      return () => { if (lab && typeof lab.destroy === "function") lab.destroy(); };
    },
  });
})();
