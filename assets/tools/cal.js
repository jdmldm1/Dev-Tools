/* CAL Explorer: connect to an OMS Language-Agnostic CAL server over the OMS WebSocket Protocol, watch subscriptions live, graph
   traffic, publish, and decode OMS JSON messages against any schema version. Protocol and message mapping live in cal-owp.js. */
(function () {
  const lib = DT.lib, esc = DT.esc;
  const MAX_KEEP = 2000, MAX_ROWS = 300, MAX_SHOW = 65536;
  let current = null;                                   // the client of the page that is open, closed when the tool is rendered again
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const hhmmss = t => new Date(t).toISOString().slice(11, 23);
  const rootName = text => { const m = /^\s*\{\s*"([^"]+)"/.exec(text); return m ? m[1].replace(/^\{[^}]*\}/, "") : ""; };
  const SAVED = "dt.cal.subs", CONN = "dt.cal.conn";
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage blocked */ } },
  };

  DT.register({
    id: "cal", name: "CAL Explorer (OWP)", group: "UCI",
    desc: "Connect to an OMS Language-Agnostic CAL server over the OMS WebSocket Protocol: subscribe to topics, watch and graph messages live, publish, and decode OMS JSON against any schema version (documentation, enum meanings, validation). Nothing is sent anywhere except to the server you enter.",
    keywords: "cal oms owp lacal language agnostic websocket uci topic subscribe publish json critical abstraction layer open mission systems",
    destroy() {
      if (current) { try { current.close(); } catch (_) {} current = null; }
    },
    render(root) {
      if (current) current.close();
      const client = (current = new lib.OwpClient());
      const $ = s => root.querySelector(s);
      const status = (id, kind, msg) => DT.status($(id), kind, msg);
      const saved = store.get(CONN, {});
      let model = lib.sharedSchema.model, gen = 1, paused = false, selected = null, timer = 0, gTimer = 0, total = 0, tab = "live", typeFilter = "", typeSig = "";
      let msgs = [], schemaTouched = false, rowsLimit = MAX_ROWS;
      const secs = new Map(), topics = new Map(), types = new Map(), frames = [];
      let tot = { n: 0, b: 0 }, curSec = 0, cur = null;
      const subList = [];

      root.innerHTML = `
        <div class="panel">
          <div class="col"><label class="l" for="url">WebSocket URL</label><input type="text" id="url" class="mono" value="${esc(saved.url || "ws://127.0.0.1:9000")}" spellcheck="false" autocomplete="off"></div>
          <div class="three" id="creds" style="margin-top:10px">
            <div class="col"><label class="l" for="svc">Service identifier</label><input type="text" id="svc" class="mono" value="${esc(saved.service || "")}" placeholder="as configured on the server" spellcheck="false" autocomplete="off"></div>
            <div class="col"><label class="l" for="sver">Schema version</label><input type="text" id="sver" class="mono" value="${esc(saved.schema || "")}" placeholder="e.g. 002.6.0 (from the loaded schema)" spellcheck="false" autocomplete="off"></div>
            <div class="col"><label class="l" for="ver">OWP versions</label><input type="text" id="ver" class="mono" value="${esc(saved.versions || "1.0")}" spellcheck="false" autocomplete="off"></div>
          </div>
          <div class="btns" style="align-items:center"><button class="btn primary" id="conn" type="button">Connect</button><button class="btn" id="disc" type="button" hidden>Disconnect</button><label class="hint" title="Reconnects to the last server and resubscribes"><input type="checkbox" id="autoc" checked> connect automatically when I open this page</label></div>
          <div class="status" id="cst"></div>
          <div id="info"></div>
          ${lib.schemaPanelHtml("OMS JSON messages")}
          <details class="hint"><summary>What the server needs, and what you must tell this page</summary>
            <p>The explorer speaks OWP 1.0 (subprotocol <code>owp</code>). Three values must match the server's own configuration, because the protocol has no way to list them: the <b>service identifier</b>, the <b>schema version</b> (the <code>version</code> attribute of its UCI schema) and the <b>topics</b>. Each subscription is a <b>topic plus a message name</b> (a global element such as <code>SystemStatus</code>); there are no wildcards, so a topic you do not name is invisible to this page.</p>
            <p>Browsers cannot set headers, so servers that need authentication in a header will not work from here. A page served over https can only open <code>wss://</code> URLs. The server must allow this page's origin.</p>
          </details>
        </div>
        <div id="work" hidden>
          <div class="tabs nav" role="tablist"><button class="tab on" data-t="live" type="button">Live</button><button class="tab" data-t="an" type="button">Analyze</button><button class="tab" data-t="pub" type="button">Publish</button><button class="tab" data-t="srv" type="button">Server</button><button class="tab" data-t="alr" type="button">Alerts</button><button class="tab" data-t="resp" type="button">Responder</button><button class="tab" data-t="scn" type="button">Scenario</button></div>

          <section data-p="live">
            <div id="x-presets"></div>
            <div class="opts" style="margin:0 0 4px">
              <input type="text" id="stop" class="mono" list="topiclist" placeholder="topic, e.g. mission.action" spellcheck="false" style="width:220px"><datalist id="topiclist"></datalist>
              <input type="text" id="smsg" class="mono" list="msglist" placeholder="message name" spellcheck="false" style="width:200px"><datalist id="msglist"></datalist>
              <input type="text" id="sgrp" class="mono" placeholder="group" spellcheck="false" style="width:90px">
              <button class="btn primary" id="sadd" type="button">Subscribe</button><button class="btn" id="sall" type="button" hidden title="The server lists its topics in INFO (non-standard x_topics key)">Subscribe to all advertised</button><button class="btn" id="sdisc" type="button" title="Find topics by trying them">Discover…</button><button class="btn" id="simpb" type="button">Paste list…</button>
              <button class="btn" id="spause" type="button">Pause</button><button class="btn" id="sclear" type="button">Clear</button><button class="btn" id="ssave" type="button">Save .jsonl</button>
              <label title="Subscribe again to the list saved from last time when connecting"><input type="checkbox" id="sauto" ${saved.auto === false ? "" : "checked"}> resubscribe on connect</label>
              <label title="When the server advertises its topics (INFO x_topics), subscribe to all of them, including ones added later"><input type="checkbox" id="sadv" ${saved.adv === false ? "" : "checked"}> subscribe to all advertised topics</label>
            </div>
            <div id="dbox" class="panel" hidden style="margin:6px 0"><div class="hint" style="margin-bottom:6px">OWP has no wildcard and no topic listing. Give candidate topic names (one per line) and the page tries the schema's messages on each: a refused SUB is simply skipped, an accepted one stays subscribed. Needs the schema loaded. A server that accepts any message on any topic will match the first one tried.</div>
              <textarea id="dtop" class="sm mono" spellcheck="false" placeholder="mission.action&#10;sys.status"></textarea>
              <div class="opts"><label><input type="checkbox" id="dfirst" checked> stop at the first match per topic</label><button class="btn" id="dgo" type="button">Discover</button><button class="btn" id="dcancel" type="button" hidden>Cancel</button></div>
              <div class="status" id="dst"></div></div>
            <div id="simpbox" hidden><textarea id="simp" class="sm mono" spellcheck="false" placeholder="one per line:  topic MessageName [group]&#10;mission.action Action&#10;sys.status SystemStatus workers"></textarea><div class="btns"><button class="btn" id="simpgo" type="button">Subscribe to all</button></div></div>
            <div class="chip-row" id="subs"></div>
            <div class="status" id="swarn" style="margin:2px 0;min-height:0"></div>
            <div class="status" id="sst" style="margin:2px 0"></div>
            <div class="tiles" id="tiles"></div>
            <div class="three">
              <div class="chart" id="c-rate"><h3>Messages / second</h3><div class="plot"></div></div>
              <div class="chart" id="c-topic"><h3>Busiest topics</h3><div class="plot"></div></div>
              <div class="chart" id="c-type"><h3>Message types</h3><div class="plot"></div></div>
            </div>
            <div class="opts" style="margin:8px 0 4px"><input type="search" id="sf" class="mono" placeholder="filter by topic or message text" style="width:280px"><span class="chip-row" id="types"></span></div>
            <div class="tscroll" style="max-height:30vh"><table class="nl"><tbody id="feed"></tbody></table></div>
            <div id="sdet" style="margin-top:10px"></div>
          </section>

          <section data-p="an" hidden>
            <div class="opts" style="margin:0 0 6px"><label><input type="checkbox" id="rec" checked> record what arrives (the newest 20,000 messages)</label><label><input type="checkbox" id="recv" checked> validate</label><button class="btn" id="recsave" type="button">Save capture</button><button class="btn" id="reclab" type="button" title="Analyse or replay it in the UCI Traffic Lab">Open in Traffic Lab</button><button class="btn" id="recclr" type="button">Clear</button></div>
            <div id="labhost"></div>
          </section>

          <section data-p="pub" hidden>
            <div class="opts" style="margin:0 0 6px">
              <input type="text" id="ptop" class="mono" list="topiclist" placeholder="topic" spellcheck="false" style="width:240px">
              <input type="text" id="pmsg" class="mono" list="msglist" placeholder="message name" spellcheck="false" style="width:220px">
              <button class="btn" id="pgen" type="button">Generate sample</button><label><input type="checkbox" id="pall"> include optional fields</label>
              <button class="btn" id="pval" type="button">Validate</button>
            </div>
            <div class="status" id="pvs"></div><div id="pverr"></div>
            <div class="col"><label class="l" for="pdata">OMS JSON message</label><textarea id="pdata" class="md" spellcheck="false" placeholder='{ "SystemStatus": { … } }'></textarea></div>
            <div class="opts"><button class="btn primary" id="ppub" type="button">Publish</button></div>
            <div class="status" id="pst"></div>
          </section>

          <section data-p="alr" hidden><div id="x-alr"></div></section>
          <section data-p="resp" hidden><div id="x-resp"></div></section>
          <section data-p="scn" hidden><div id="x-scn"></div></section>

          <section data-p="srv" hidden>
            <div id="srvinfo"></div>
            <div class="chart"><h3>Protocol log (last 200 frames)</h3><pre class="out" id="plog" style="max-height:40vh;overflow:auto"></pre></div>
          </section>
        </div>`;
      DT.wire(root);

      /* ----- Analyze: record the traffic into a store and show the traffic views on it ----- */
      const traffic = new lib.TrafficStore(model, { max: 20000, validate: true });
      let lab = null, recording = true;
      const mountLab = () => { if (!lab) lab = lib.trafficLab($("#labhost"), { store: traffic, getModel: () => model, live: true, extraTabs: lib.labExtras(traffic, { getModel: () => model }) }); else lab.refresh(); };
      $("#rec").onchange = e => { recording = e.target.checked; };
      $("#recv").onchange = e => { traffic.reset(model, e.target.checked); if (lab) lab.refresh(); };
      $("#recclr").onclick = () => { traffic.clear(); if (lab) lab.refresh(); };
      $("#recsave").onclick = () => { if (!traffic.records.length) return; DT.download("capture.jsonl", lib.capStringify(traffic.records), "application/x-ndjson"); };
      $("#reclab").onclick = () => { lib.pendingCapture = traffic.records.map(r => ({ t: r.t, topic: r.topic, text: r.text, source: r.source })); location.hash = "#ucilab"; };

      /* ---------- schema ---------- */
      const sp = lib.schemaPanel(root, m => {
        model = m; gen++; traffic.reset(m); if (lab) lab.refresh();
        $("#msglist").innerHTML = m ? [...m.elements.keys()].sort().map(k => `<option value="${esc(k)}">`).join("") : "";
        if (m && !schemaTouched && !$("#sver").value) $("#sver").value = lib.schemaVersion(m);
        draw(); if (selected) $("#sdet").replaceChildren(detail(selected));
      });

      /* ---------- connection ---------- */
      $("#sver").addEventListener("input", () => { schemaTouched = true; });
      const showTab = t => {
        tab = t;
        root.querySelectorAll(".tabs.nav .tab").forEach(b => b.classList.toggle("on", b.dataset.t === t));
        root.querySelectorAll("section[data-p]").forEach(s => { s.hidden = s.dataset.p !== t; });
        if (t === "live") drawGraphs(true);
        if (t === "an") mountLab();
        if (t === "srv") drawServer();
      };
      root.querySelectorAll(".tabs.nav .tab").forEach(b => { b.onclick = () => showTab(b.dataset.t); });

      function disconnected(msg, kind) {
        clearInterval(gTimer); gTimer = 0;
        $("#work").hidden = true; $("#disc").hidden = true; $("#conn").hidden = false; $("#conn").disabled = false;
        $("#info").innerHTML = ""; $("#creds").style.display = ""; subList.length = 0; renderSubs();
        status("#cst", kind || "", msg);
      }
      async function connect() {
        const url = $("#url").value.trim(), service = $("#svc").value.trim(), schema = $("#sver").value.trim() || lib.schemaVersion(model);
        const versions = $("#ver").value.split(/[ ,]+/).filter(Boolean);
        if (!/^wss?:\/\/\S+$/i.test(url)) return status("#cst", "err", "The URL must start with ws:// or wss://, for example ws://127.0.0.1:9000.");
        if (!service) return status("#cst", "err", "Enter the service identifier the server expects (it is part of the server's configuration).");
        if (!schema) return status("#cst", "err", "Enter the schema version the server expects, or load its schema so it can be read from the version attribute.");
        if (!versions.length) return status("#cst", "err", "Enter at least one OWP version, for example 1.0.");
        $("#conn").disabled = true; status("#cst", "", "Connecting…");
        client.onclose = reason => disconnected("Connection lost: " + reason + ".", "err");
        client.onerror = msg => status("#swarn", "warn", "Server: " + msg);
        client.onmsg = onMsg;
        client.oninfo = () => { drawServer(); advertisedSync(); };
        client.onframe = (dir, text) => { frames.push((dir === "in" ? "← " : "→ ") + text.replace(/\s+/g, " ").slice(0, 400)); if (frames.length > 200) frames.shift(); };
        frames.length = 0;
        try {
          const info = await client.connect(url, { versions, schema, serviceId: service });
          store.set(CONN, { url, service, schema, versions: versions.join(" "), auto: $("#sauto").checked, adv: $("#sadv").checked, autoConnect: $("#autoc").checked });
          $("#info").innerHTML = `<div class="hint" style="margin:4px 0">${esc(info.server_id)} · OWP ${esc(info.version)} · ${esc(info.system_label)} · system ${esc(info.uuids && info.uuids.system || "?")}</div>`;
          $("#creds").style.display = "none"; $("#conn").hidden = true; $("#disc").hidden = false; $("#work").hidden = false;
          status("#cst", "ok", "Connected to " + url);
          gTimer = setInterval(tick, 1000); drawServer(); drawGraphs(true);
          if (pendingPub) { pendingPub = false; showTab("pub"); }
          if ($("#sauto").checked) await resubscribe();
          await advertisedSync();
        } catch (e) { $("#conn").disabled = false; status("#cst", "err", e.message); }
      }
      $("#conn").onclick = connect;
      $("#disc").onclick = () => { client.close(); disconnected("Disconnected."); };
      $("#url").addEventListener("keydown", e => { if (e.key === "Enter") connect(); });
      window.addEventListener("pagehide", () => client.close(), { once: true });

      /* ---------- subscriptions ---------- */
      function renderSubs() {
        $("#subs").innerHTML = subList.map((s, i) => `<span class="chip" data-i="${i}" title="Click to unsubscribe">${esc(s.topic)} · ${esc(s.messageName)}${s.group ? " [" + esc(s.group) + "]" : ""} ×</span>`).join("");
        $("#topiclist").innerHTML = [...new Set([...store.get(SAVED, []).map(x => x.topic), ...subList.map(s => s.topic)])].map(t => `<option value="${esc(t)}">`).join("");
      }
      const persist = () => store.set(SAVED, subList.map(s => ({ topic: s.topic, message: s.messageName, group: s.group })));
      async function addSub(topic, message, group) {
        const s = await client.subscribe(message, topic, group);
        subList.push(s); renderSubs(); persist(); return s;
      }
      async function resubscribe() {
        const list = store.get(SAVED, []), failed = [];
        for (const x of list) { try { await addSub(x.topic, x.message, x.group); } catch (e) { failed.push(`${x.topic} ${x.message}: ${e.code || e.message}`); } }
        if (failed.length) status("#swarn", "warn", `${failed.length} saved subscription${failed.length === 1 ? "" : "s"} refused by this server: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "…" : ""}`);
        else if (list.length) status("#swarn", "", "");
      }
      $("#sadd").onclick = async () => {
        const topic = $("#stop").value.trim(), message = $("#smsg").value.trim(), group = $("#sgrp").value.trim();
        if (!topic || !message) return status("#swarn", "warn", "A subscription needs a topic and a message name.");
        if (subList.some(s => s.topic === topic && s.messageName === message && s.group === group)) return status("#swarn", "warn", "Already subscribed to that topic and message.");
        try { await addSub(topic, message, group); status("#swarn", "", ""); $("#stop").value = ""; } catch (e) { status("#swarn", "err", `${e.code ? e.code + ": " : ""}${e.message === e.code ? "" : e.message + " "}${e.help || ""}`.trim()); }
      };
      /* topics advertised by the server (non-standard INFO key x_topics): subscribe to all of them, now and when more appear */
      const inFlight = new Set();
      async function subscribeMany(list) {
        const todo = list.filter(t => !subList.some(s => s.topic === t.name && s.messageName === t.message) && !inFlight.has(t.name + "|" + t.message));
        todo.forEach(t => inFlight.add(t.name + "|" + t.message));
        const failed = [];
        await Promise.all(todo.map(t => addSub(t.name, t.message).catch(e => failed.push(`${t.name}: ${e.code || e.message}`)).finally(() => inFlight.delete(t.name + "|" + t.message))));
        return { added: todo.length - failed.length, failed };
      }
      async function advertisedSync() {
        const adv = lib.owpAdvertisedTopics(client.info);
        $("#sall").hidden = !adv.length; $("#sall").textContent = `Subscribe to all advertised (${adv.length})`;
        if (!adv.length || !$("#sadv").checked || !client.connected) return;
        const r = await subscribeMany(adv);
        if (r.failed.length) status("#swarn", "warn", `${r.failed.length} advertised topic${r.failed.length === 1 ? "" : "s"} refused: ${r.failed.slice(0, 3).join("; ")}`);
        else if (r.added) status("#swarn", "ok", `Subscribed to ${r.added} advertised topic${r.added === 1 ? "" : "s"}.`);
      }
      $("#sall").onclick = async () => { const r = await subscribeMany(lib.owpAdvertisedTopics(client.info)); status("#swarn", r.failed.length ? "warn" : "ok", r.failed.length ? `${r.failed.length} refused: ${r.failed.slice(0, 3).join("; ")}` : `Subscribed to ${r.added} topic${r.added === 1 ? "" : "s"}.`); };
      $("#sadv").onchange = () => { const c = store.get(CONN, null); if (c) store.set(CONN, { ...c, adv: $("#sadv").checked }); if ($("#sadv").checked) advertisedSync(); };
      $("#autoc").onchange = () => { const c = store.get(CONN, null); if (c) store.set(CONN, { ...c, autoConnect: $("#autoc").checked }); };

      /* discovery by trying messages on candidate topics */
      let cancelDiscover = false;
      $("#sdisc").onclick = () => {
        $("#dbox").hidden = !$("#dbox").hidden;
        if (!$("#dbox").hidden && !$("#dtop").value) $("#dtop").value = [...new Set([...store.get(SAVED, []).map(x => x.topic), ...subList.map(s => s.topic)])].join("\n");
      };
      $("#dcancel").onclick = () => { cancelDiscover = true; };
      $("#dgo").onclick = async () => {
        if (!model) return status("#dst", "err", "Load the schema first: it supplies the message names to try.");
        const topics = [...new Set($("#dtop").value.split(/\s+/).filter(Boolean))].filter(t => lib.owpToken.test(t));
        if (!topics.length) return status("#dst", "err", "Enter at least one topic name.");
        cancelDiscover = false; $("#dgo").disabled = true; $("#dcancel").hidden = false;
        try {
          const r = await lib.owpDiscover(client, topics, [...model.elements.keys()], {
            stopAtFirst: $("#dfirst").checked, isCancelled: () => cancelDiscover,
            onProgress: p => status("#dst", "", `Trying ${p.topic}: ${p.tried.toLocaleString()} SUBs sent, ${p.found} accepted so far…`),
          });
          for (const s of r.found) subList.push(s);
          renderSubs(); persist();
          status("#dst", r.found.length ? "ok" : "warn", `${r.cancelled ? "Cancelled. " : ""}${r.found.length} subscription${r.found.length === 1 ? "" : "s"} accepted after ${r.tried.toLocaleString()} attempts${r.found.length ? ": " + r.found.slice(0, 6).map(s => s.topic + " · " + s.messageName).join(", ") + (r.found.length > 6 ? "…" : "") : ". Check the topic names against the server's configuration."}`);
        } catch (e) { status("#dst", "err", e.message); }
        $("#dgo").disabled = false; $("#dcancel").hidden = true;
      };

      $("#simpb").onclick = () => { $("#simpbox").hidden = !$("#simpbox").hidden; };
      $("#simpgo").onclick = async () => {
        const lines = $("#simp").value.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")), failed = [];
        for (const l of lines) {
          const [topic, message, group] = l.split(/[ \t]+/);
          if (!topic || !message) { failed.push(`"${l}": needs topic and message`); continue; }
          if (subList.some(s => s.topic === topic && s.messageName === message && s.group === (group || ""))) continue;
          try { await addSub(topic, message, group); } catch (e) { failed.push(`${topic} ${message}: ${e.code || e.message}`); }
        }
        status("#swarn", failed.length ? "warn" : "ok", failed.length ? `${failed.length} refused: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "…" : ""}` : `Subscribed to ${lines.length}.`);
      };
      $("#subs").onclick = async e => {
        const c = e.target.closest(".chip"); if (!c) return;
        const s = subList[+c.dataset.i]; if (!s) return;
        try { await client.unsubscribe(s.id); } catch (err) { status("#swarn", "warn", err.message); }
        const i = subList.indexOf(s); if (i >= 0) subList.splice(i, 1); renderSubs(); persist();
      };

      /* ---------- presets, alerts, scenario, responder (cal-panels.js) ---------- */
      const cx = lib.calPanels({
        root, $, client, getModel: () => model, msgs: () => msgs, subs: () => subList,
        applySubs: async list => {
          let added = 0; const failed = [];
          for (const x of list) {
            if (subList.some(s => s.topic === x.topic && s.messageName === x.message && (s.group || "") === (x.group || ""))) continue;
            try { await addSub(x.topic, x.message, x.group); added++; } catch (e) { failed.push(`${x.topic}: ${e.code || e.message}`); }
          }
          return { added, failed };
        },
        getConn: () => ({ url: $("#url").value.trim(), service: $("#svc").value.trim(), schema: $("#sver").value.trim(), versions: $("#ver").value.trim() }),
        setConn: c => { if (c.url) $("#url").value = c.url; if (c.service) $("#svc").value = c.service; if (c.schema) { $("#sver").value = c.schema; schemaTouched = true; } if (c.versions) $("#ver").value = c.versions; },
        getFilter: () => $("#sf").value, setFilter: v => { $("#sf").value = v; draw(); },
      });

      /* ---------- messages ---------- */
      function tally(m, now) {
        const sec = Math.floor(now / 1000);
        if (sec !== curSec) { curSec = sec; cur = secs.get(sec) || secs.set(sec, { n: 0 }).get(sec); }
        cur.n++; tot.n++; tot.b += m.size;
        topics.set(m.topic, (topics.get(m.topic) || 0) + 1);
        if (m.message) types.set(m.message, (types.get(m.message) || 0) + 1);
      }
      function onMsg({ sub, text }) {
        if (!root.isConnected) { client.close(); return; }
        total++;
        const now = Date.now(), m = { n: total, t: now, topic: sub.topic, sid: sub.id, group: sub.group, message: rootName(text) || sub.messageName, text, size: text.length };
        tally(m, now); cx.onMsg(m);
        if (paused) return;
        msgs.push(m);
        if (recording) traffic.add({ t: now, topic: sub.topic, text, source: "cal" });
        if (msgs.length > MAX_KEEP * 1.25) msgs.splice(0, msgs.length - MAX_KEEP);
        if (!timer) timer = setTimeout(draw, 120);
      }
      function draw() {
        timer = 0;
        const f = $("#sf").value.trim().toLowerCase(), rows = [], wq = /^where\s+/i.test($("#sf").value.trim()) ? lib.fieldQuery($("#sf").value.trim().replace(/^where\s+/i, "")) : null;
        if (wq && !wq.ok) status("#swarn", "warn", wq.error); else if (wq) status("#swarn", "", "");
        for (let i = msgs.length - 1; i >= 0 && rows.length < rowsLimit; i--) {
          const m = msgs[i];
          if (typeFilter && m.message !== typeFilter) continue;
          if (wq) { if (wq.ok) { m.fields = m.fields || lib.payloadFields(m.text).fields; if (!wq.test(m.fields, { topic: m.topic, raw: m.text })) continue; } }
          else if (f && !(m.lc || (m.lc = (m.topic + " " + m.text.slice(0, 4000)).toLowerCase())).includes(f)) continue;
          const unk = model && m.message && !model.elements.has(m.message);
          rows.push(`<tr data-n="${m.n}"${m === selected ? ' class="on"' : ""}><td class="t">${hhmmss(m.t)}</td><td class="s">${esc(m.topic)}</td><td class="ty"><span${unk ? ' class="unk" title="Not in the loaded schema"' : ""}>${esc(m.message)}</span></td><td class="t">${m.size} B</td><td class="p">${esc(m.pv || (m.pv = m.text.replace(/\s+/g, " ").slice(0, 100)))}</td></tr>`);
        }
        $("#feed").innerHTML = rows.join("") || `<tr><td class="t">${total ? "No message matches the filter." : subList.length ? "Waiting for messages…" : "Subscribe to a topic and message name to see messages."}</td></tr>`;
        status("#sst", paused ? "warn" : "", `${total.toLocaleString()} received · ${Math.min(msgs.length, MAX_KEEP).toLocaleString()} kept (last ${MAX_KEEP.toLocaleString()}) · ${paused ? "paused" : "live"}`);
        const top = [...types].sort((a, b) => b[1] - a[1]).slice(0, 12), s2 = typeFilter + "|" + top.map(x => x[0] + x[1]).join();
        if (s2 !== typeSig) {
          typeSig = s2;
          $("#types").innerHTML = top.length ? `<span class="chip" data-ty="" style="${!typeFilter ? "color:var(--accent);border-color:var(--accent)" : ""}">all types</span>` + top.map(([t, n]) => `<span class="chip" data-ty="${esc(t)}" style="${typeFilter === t ? "color:var(--accent);border-color:var(--accent)" : ""}">${esc(t)} ${n}</span>`).join("") : "";
        }
      }
      $("#types").onclick = e => { const c = e.target.closest(".chip"); if (c) { typeFilter = c.dataset.ty; typeSig = ""; draw(); } };
      $("#spause").onclick = e => { paused = !paused; e.target.textContent = paused ? "Resume" : "Pause"; draw(); };
      $("#sclear").onclick = () => { msgs = []; total = 0; selected = null; typeFilter = ""; typeSig = ""; secs.clear(); topics.clear(); types.clear(); tot = { n: 0, b: 0 }; curSec = 0; cur = null; $("#sdet").innerHTML = ""; draw(); drawGraphs(true); };
      $("#sf").addEventListener("input", DT.debounce(() => { rowsLimit = MAX_ROWS; draw(); }, 150));
      /* the feed shows the newest rows first and adds more as you scroll down, up to everything that is kept */
      $("#feed").closest(".tscroll").addEventListener("scroll", e => { const t = e.currentTarget; if (rowsLimit < MAX_KEEP * 1.25 && t.scrollTop + t.clientHeight > t.scrollHeight - 160) { rowsLimit += MAX_ROWS; draw(); } });
      $("#feed").onclick = e => {
        const tr = e.target.closest("tr[data-n]"); if (!tr) return;
        selected = msgs.find(m => m.n === +tr.dataset.n); if (!selected) return;
        $("#feed").querySelectorAll("tr.on").forEach(r => r.classList.remove("on")); tr.classList.add("on");
        $("#sdet").replaceChildren(detail(selected));
      };
      $("#ssave").onclick = () => {
        const lines = msgs.map(m => JSON.stringify({ time: new Date(m.t).toISOString(), topic: m.topic, subscription: m.sid, group: m.group || undefined, message: m.text }));
        if (!lines.length) return status("#swarn", "warn", "Nothing to save yet.");
        DT.download("cal-messages.jsonl", lines.join("\n") + "\n", "application/x-ndjson");
      };

      /* ---------- one message: decoded tree, JSON, XML, raw ---------- */
      function pretty(text) { try { return lib.owpStringify(lib.owpParseJson(text), 2); } catch (_) { return null; } }
      function detail(m) {
        const box = el("div", "panel");
        const p = pretty(m.text.length > MAX_SHOW ? "" : m.text);
        box.innerHTML = DT.kv([["topic", m.topic], ["subscription", m.sid + (m.group ? " (group " + m.group + ")" : "")], ["message", m.message], ["size", `${m.size} characters`]])
          + `<div class="btns"><button class="btn" data-a="copy" type="button">Copy JSON</button><button class="btn" data-a="pub" type="button">Edit as new message</button></div><div class="pl"></div>`;
        const pl = box.querySelector(".pl"), tabs = el("div", "tabs"), panes = {};
        const mk = (key, label, build) => { const b = el("button", "tab", label); b.type = "button"; b.dataset.k = key; tabs.append(b); panes[key] = { b, build, node: null }; };
        let conv = null, decoded = null;
        if (model) {
          try { conv = lib.owpJsonToXml(model, m.text); decoded = lib.uciDecode(model, conv.xml, { validate: true }); } catch (e) { conv = { error: e.message, suggest: e.suggest }; }
          mk("dec", "Decoded", () => {
            if (decoded) return lib.uciView(decoded, model, { locs: false });
            const d = el("div", "uci"); d.append(el("div", "status err", conv.error));
            if (conv.suggest && conv.suggest.length) d.append(el("div", "hint", "Closest message names in the schema: " + conv.suggest.join(", ") + ". A different schema version may have renamed it."));
            return d;
          });
        }
        mk("json", "JSON", () => el("pre", "out", p === null ? "Not valid JSON:\n" + m.text.slice(0, MAX_SHOW) : p));
        if (conv && conv.xml) mk("xml", "XML", () => el("pre", "out", conv.xml));
        mk("raw", "Raw", () => el("pre", "out", m.text.slice(0, MAX_SHOW)));
        const show = k => { for (const [kk, q] of Object.entries(panes)) { q.b.classList.toggle("on", kk === k); if (kk === k && !q.node) { q.node = q.build(); pl.append(q.node); } if (q.node) q.node.hidden = kk !== k; } };
        pl.append(tabs); show(Object.keys(panes)[0]);
        tabs.onclick = e => { const b = e.target.closest(".tab"); if (b) show(b.dataset.k); };
        if (!model) box.insertBefore(el("div", "hint", "Load the schema above to decode this message: documentation, enumeration meanings, validation."), pl);
        box.querySelector('[data-a="copy"]').onclick = e => DT.copy(p === null ? m.text : p, e.target);
        box.querySelector('[data-a="pub"]').onclick = () => { $("#ptop").value = m.topic; $("#pmsg").value = m.message; $("#pdata").value = p === null ? m.text : p; showTab("pub"); };
        return box;
      }

      /* ---------- graphs ---------- */
      const hovered = e => e.matches(":hover");
      const plotInto = (host, html) => { host.querySelector(".plot").innerHTML = html; };
      function tick() {
        if (!root.isConnected) { client.close(); clearInterval(gTimer); return; }
        cx.tick();
        const cut = Math.floor(Date.now() / 1000) - 620; for (const k of secs.keys()) if (k < cut) secs.delete(k);
        if (tab === "live") drawGraphs(false);
      }
      function drawGraphs(force) {
        if (!force && tab !== "live") return;
        const now = Math.floor(Date.now() / 1000), pts = [];
        for (let i = now - 300; i < now; i++) pts.push([i - now, (secs.get(i) || { n: 0 }).n]);
        let r5 = 0; for (let i = now - 5; i < now; i++) r5 += (secs.get(i) || { n: 0 }).n; r5 /= 5;
        $("#tiles").innerHTML = [["Messages / s", r5 >= 100 ? Math.round(r5).toLocaleString() : r5.toFixed(1), lib.chartSpark(pts.slice(-60).map(p => p[1]))], ["Total messages", tot.n.toLocaleString(), ""], ["Total size", lib.bytesLabel(tot.b), ""], ["Topics seen", topics.size.toLocaleString(), ""], ["Message types", types.size.toLocaleString(), ""]]
          .map(([l, v, s]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${esc(v)}</div>${s}</div>`).join("");
        const cr = $("#c-rate");
        if (!hovered(cr)) { const c = lib.chartLine([{ name: "msgs/s", points: pts }], { zero: true, xFmt: x => (x === 0 ? "now" : x + " s"), w: 420, h: 150 }); plotInto(cr, c.svg); lib.chartAttachLine(cr, c.plot); }
        const bars = (host, map, key, empty) => {
          if (hovered(host)) return;
          const top = [...map].sort((a, b) => b[1] - a[1]).slice(0, 12);
          plotInto(host, lib.chartBars(top.map(([k, n]) => ({ label: k, value: n, tip: `${k}: ${n.toLocaleString()} messages`, color: key === "type" && model && !model.elements.has(k) ? lib.chartColors[1] : lib.chartColors[0] })), { click: true, labelW: 150, w: 420, fmt: v => v.toLocaleString(), empty }));
          host._top = top.map(x => x[0]); lib.chartAttachTips(host);
        };
        bars($("#c-topic"), topics, "topic", "Subscribe to a topic to see traffic.");
        bars($("#c-type"), types, "type", "No messages yet.");
      }
      $("#c-topic").addEventListener("click", e => { const g = e.target.closest(".brow"); if (g) { $("#sf").value = $("#c-topic")._top[+g.dataset.i]; typeFilter = ""; typeSig = ""; draw(); } });
      $("#c-type").addEventListener("click", e => { const g = e.target.closest(".brow"); if (g) { typeFilter = $("#c-type")._top[+g.dataset.i]; typeSig = ""; $("#sf").value = ""; draw(); } });

      /* ---------- publish ---------- */
      function fillHeader(tree) {
        const info = client.info || {}, u = info.uuids || {};
        const find = (e, n) => e.kids.find(k => k.t === "el" && k.name.replace(/^[^:]+:/, "") === n);
        const hdr = find(tree.root, "MessageHeader"); if (!hdr) return;
        const setText = (e, v) => { const t = e.kids.find(k => k.t === "text"); if (t) t.v = v; else e.kids.push({ t: "text", v }); };
        const idOf = e => find(e, "UUID") || (e.kids.some(k => k.t === "el") ? null : e);          // UCI wraps the UUID; other schemas may use a plain string
        const sys = find(hdr, "SystemID"); if (sys && u.system) { const id = idOf(sys); if (id) setText(id, u.system); }
        const svc = find(hdr, "ServiceID"); if (svc && u.service) { const id = idOf(svc); if (id) setText(id, u.service); }
        const ts = find(hdr, "Timestamp"); if (ts) setText(ts, new Date().toISOString().replace(/\.\d+Z$/, "Z"));
        const mode = find(hdr, "Mode"); if (mode) setText(mode, "LIVE");
      }
      $("#pgen").onclick = () => {
        try {
          if (!model) throw new Error("Load the schema first: samples are generated from it.");
          const name = $("#pmsg").value.trim(); if (!name) throw new Error("Choose a message name from the schema first.");
          const tree = lib.xmlParse(lib.uciSample(model, name, { all: $("#pall").checked }));
          fillHeader(tree);
          $("#pdata").value = lib.owpXmlToJson(model, lib.xmlSerialize(tree), 2);
          check($("#pdata").value);
        } catch (e) { status("#pvs", "err", e.message); }
      };
      function check(text) {
        const box = $("#pverr"); box.innerHTML = "";
        if (!model) { status("#pvs", "warn", "Load a schema (top of the page) to validate."); return null; }
        const v = lib.owpValidate(model, text);
        if (v.ok) status("#pvs", "ok", `${v.name}: valid against the loaded schema.`);
        else {
          status("#pvs", "err", `${v.errors.length}${v.truncated ? "+" : ""} problem${v.errors.length === 1 ? "" : "s"}${v.suggest && v.suggest.length ? ". Closest message names: " + v.suggest.join(", ") : ""}.`);
          const list = el("div", "errlist");
          for (const e of v.errors.slice(0, 25)) { const r = el("div", "er"); r.append(el("span", "ln", ""), el("span", "ms", e.message), el("span", "pa", e.path || "")); list.append(r); }
          box.append(list);
        }
        return v;
      }
      $("#pval").onclick = () => check($("#pdata").value);
      $("#ppub").onclick = async () => {
        const topic = $("#ptop").value.trim(), text = $("#pdata").value;
        try {
          const v = model ? lib.owpValidate(model, text) : null;
          status("#pst", "", "Publishing…");
          await client.publish(topic, text);
          status("#pst", v && !v.ok ? "warn" : "ok", `Published to ${topic}; the server acknowledged it (+OK).${v && !v.ok ? ` Note: ${v.errors.length} schema problem${v.errors.length === 1 ? "" : "s"} (use Validate), and the server accepted it anyway.` : ""}`);
        } catch (e) { status("#pst", "err", `${e.code ? e.code + ": " : ""}${e.code ? "" : e.message} ${e.help || ""}`.trim()); }
      };

      /* ---------- server ---------- */
      function drawServer() {
        const i = client.info; if (!i) return;
        const u = i.uuids || {}, rows = [["server_id", i.server_id], ["OWP version", i.version], ["system label", i.system_label], ["system", u.system], ["service", u.service], ["subsystem", u.subsystem], ["connect_urls", (i.connect_urls || []).join(", ")]]
          .concat(Object.entries(u.capabilities || {}).map(([k, v]) => ["capability " + k, v]), Object.entries(u.components || {}).map(([k, v]) => ["component " + k, v]));
        $("#srvinfo").innerHTML = DT.kv(rows.filter(r => r[1]));
        const pre = $("#plog"); pre.textContent = frames.join("\n");
      }
      const srvTimer = setInterval(() => { if (!root.isConnected) return clearInterval(srvTimer); if (tab === "srv") drawServer(); }, 1500);

      sp.start(); renderSubs(); draw();

      /* a message sent here by the Message Builder waits in the publisher */
      let pendingPub = false;
      if (lib.handoff && lib.handoff.kind === "json") {
        const h = lib.handoff; lib.handoff = null; pendingPub = true;
        $("#pmsg").value = h.name; $("#pdata").value = h.text;
        status("#cst", "", "A message from the Message Builder is ready in the Publish tab. Connect, enter the topic, and publish.");
      }
      /* reconnect to the last server when the page opens */
      $("#autoc").checked = saved.autoConnect !== false;
      if (saved.url && saved.service && saved.schema && saved.autoConnect !== false) { status("#cst", "", "Reconnecting to the last server…"); connect(); }
      return () => {
        cx.close(); clearInterval(srvTimer);
        if (current) { try { current.close(); } catch (_) {} current = null; }
      };
    },
  });
})();
