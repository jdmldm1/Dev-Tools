/* The extra tabs and panels of the NATS Explorer: request/reply latency, server monitoring and subject usage ($SYS), KV and object store,
   JetStream administration, consumer lag, message diff, scenarios and responders. nats.js creates the containers and calls
   lib.natsPanels(ctx); the logic is in nats-latency.js, nats-js.js, scenario.js, payload-tools.js and alerts.js. */
(function () {
  const lib = DT.lib, esc = DT.esc, TD = new TextDecoder(), TE = new TextEncoder(), EMPTY = new Uint8Array(0);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const ms = v => (v >= 1000 ? (v / 1000).toFixed(2) + " s" : v >= 10 ? Math.round(v) + " ms" : v.toFixed(1) + " ms");
  const pct = v => (v * 100).toFixed(v && v < 0.1 ? 1 : 0) + "%";
  const hhmmss = t => new Date(t).toISOString().slice(11, 23);

  /* ctx: { root, $, client, status(sel, kind, msg), api(subject, body), paged(subject, key), getModel(), msgs() -> feed array, subjects() -> Map subject -> {n},
            rootOf(m) -> xml root name, refreshJs(), openStream(name), isInternal(subject) } */
  lib.natsPanels = function (ctx) {
    const { root, $, client } = ctx;
    const tracker = new lib.LatencyTracker(), observed = new Map(), lag = new lib.LagSeries();
    let writeOn = false, activeTab = "", kvWatchSub = null, lagTimer = 0, adminNote = null;
    const onWrite = [];

    /* ---------- Latency ---------- */
    const latHost = $("#x-lat");
    latHost.innerHTML = `<div class="hint" style="margin:0 0 6px">A message with a reply-to subject is a request; the next message on that subject is its reply. Times are when this page received each one, so they show what a subscriber on the bus sees. Requests with no reply after the timeout count as unanswered. Needs a subscription that sees both sides (the default <code>&gt;</code> does).</div>
      <div class="opts"><label>Timeout <input type="number" id="lto" value="5" min="1" max="120" class="mono" style="width:70px"> s</label><button class="btn" id="lclr" type="button">Clear</button></div>
      <div class="tiles" id="ltiles"></div><div class="chart" id="lchart"><h3>Slowest subjects (95th percentile)</h3><div class="plot"></div></div>
      <div class="tscroll" style="max-height:40vh"><table class="kv" id="ltbl"><thead><tr><th>Request subject</th><th>Requests</th><th>Replied</th><th>Unanswered</th><th>No responders</th><th>Failure</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr></thead><tbody></tbody></table></div>`;
    const lat$ = s => latHost.querySelector(s);
    lat$("#lto").onchange = () => { tracker.timeoutMs = Math.max(1, +lat$("#lto").value || 5) * 1000; };
    lat$("#lclr").onclick = () => { tracker.clear(); drawLatency(); };
    function drawLatency() {
      const rows = tracker.snapshot(), sum = k => rows.reduce((s, r) => s + r[k], 0);
      lat$("#ltiles").innerHTML = [["Requests seen", tracker.requests.toLocaleString()], ["Replied", sum("replies").toLocaleString()], ["Unanswered", sum("timeouts").toLocaleString()], ["No responders", sum("noResponders").toLocaleString()], ["Waiting now", tracker.pending.size.toLocaleString()]]
        .map(([l, v]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${esc(v)}</div></div>`).join("");
      const slow = rows.filter(r => r.replies).sort((a, b) => b.p95 - a.p95).slice(0, 10);
      lat$("#lchart .plot").innerHTML = slow.length ? lib.chartBars(slow.map(r => ({ label: r.subject, value: r.p95, tip: `${r.subject}: p95 ${ms(r.p95)}, max ${ms(r.max)}` })), { labelW: 190, w: 520, fmt: ms }) : `<div class="hint" style="padding:10px 4px">No replies seen yet.</div>`;
      lat$("#ltbl tbody").innerHTML = rows.map(r => `<tr><td class="v">${esc(r.subject)}</td><td>${r.requests}</td><td>${r.replies}</td><td>${r.timeouts}</td><td>${r.noResponders}</td><td>${r.requests ? pct(r.failRate) : "-"}</td><td>${r.replies ? ms(r.p50) : "-"}</td><td>${r.replies ? ms(r.p95) : "-"}</td><td>${r.replies ? ms(r.p99) : "-"}</td><td>${r.replies ? ms(r.max) : "-"}</td></tr>`).join("") || `<tr><td colspan="10" class="hint">No requests seen yet. Anything published with a reply-to subject shows up here.</td></tr>`;
    }

    /* ---------- Server: $SYS monitoring and subject usage ---------- */
    const srvHost = $("#x-srv");
    srvHost.innerHTML = `<div class="hint" style="margin:0 0 6px">Reads server and connection data over the <code>$SYS</code> request subjects. That needs a user in the server's <b>system account</b> (<code>system_account</code> in the server config): connect with those credentials. The subject usage map joins every client's subscriptions with the traffic this page has seen.</div>
      <div class="opts"><button class="btn primary" id="srefresh" type="button">Refresh</button><label><input type="checkbox" id="sauto2"> every 5 s</label></div><div class="status" id="sstat"></div>
      <div id="sservers"></div><div id="sconns"></div><div id="susage"></div>`;
    const srv$ = s => srvHost.querySelector(s);
    let srvTimer = 0;
    const sysReq = async (subject, body) => (await lib.natsRequestMany(client, subject, body ? TE.encode(JSON.stringify(body)) : EMPTY, { timeout: 1500 })).map(lib.sysDecode).filter(Boolean);
    const upt = s => { if (!s) return "-"; const m = /(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(\d+)s/.exec(s); return m ? s.replace(/\.\d+/, "") : s; };
    async function refreshServer() {
      DT.status(srv$("#sstat"), "", "Asking the servers…");
      try {
        const [stat, health, connz] = await Promise.all([sysReq("$SYS.REQ.SERVER.PING"), sysReq("$SYS.REQ.SERVER.PING.HEALTHZ"), sysReq("$SYS.REQ.SERVER.PING.CONNZ", { subscriptions_detail: true, limit: 1024 })]);
        if (!stat.length && !connz.length) { srv$("#sservers").innerHTML = ""; srv$("#sconns").innerHTML = ""; srv$("#susage").innerHTML = ""; return DT.status(srv$("#sstat"), "warn", "No server answered the $SYS requests. Connect with a user from the system account, or check that system_account is configured."); }
        const hmap = new Map(health.map(h => [h.server && h.server.id, h.data]));
        srv$("#sservers").innerHTML = `<h3 style="margin:10px 0 4px">Servers (${stat.length})</h3><div class="tscroll"><table class="kv"><thead><tr><th>Name</th><th>Version</th><th>Health</th><th>Connections</th><th>Subscriptions</th><th>In msgs</th><th>Out msgs</th><th>Slow consumers</th><th>CPU</th><th>Memory</th><th>Uptime</th></tr></thead><tbody>${stat.map(s => {
          const sv = s.server || {}, z = s.statsz || {}, h = hmap.get(sv.id);
          return `<tr><td class="v">${esc(sv.name || sv.id || "?")}${sv.jetstream ? ' <span class="kb">JS</span>' : ""}${sv.cluster ? " <span class=\"hint\">" + esc(sv.cluster) + "</span>" : ""}</td><td>${esc(sv.ver || "")}</td><td>${h ? (h.status === "ok" ? "ok" : esc(h.status || "?") + (h.error ? ": " + esc(h.error) : "")) : "-"}</td><td>${z.connections ?? "-"}</td><td>${z.subscriptions ?? "-"}</td><td>${(z.received && z.received.msgs || 0).toLocaleString()}</td><td>${(z.sent && z.sent.msgs || 0).toLocaleString()}</td><td>${z.slow_consumers ?? 0}</td><td>${z.cpu !== undefined ? z.cpu.toFixed(1) + "%" : "-"}</td><td>${lib.bytesLabel(z.mem || 0)}</td><td>${upt(z.start ? ((Date.now() - Date.parse(z.start)) / 1000 | 0) + "s" : "")}</td></tr>`;
        }).join("")}</tbody></table></div>`;
        const conns = connz.flatMap(c => (c.data && c.data.connections || []).map(x => ({ ...x, _server: c.server && c.server.name })));
        srv$("#sconns").innerHTML = `<h3 style="margin:10px 0 4px">Connections (${conns.length})</h3><div class="tscroll" style="max-height:30vh"><table class="kv"><thead><tr><th>CID</th><th>Name</th><th>Client</th><th>Subs</th><th>In msgs</th><th>Out msgs</th><th>Pending</th><th>Idle</th><th>Server</th></tr></thead><tbody>${conns.sort((a, b) => (b.pending_bytes || 0) - (a.pending_bytes || 0)).map(c => `<tr><td>${c.cid}</td><td class="v">${esc(c.name || "")}</td><td class="v">${esc(`${c.lang || ""} ${c.version || ""} ${c.ip || ""}:${c.port || ""}`.trim())}</td><td>${c.subscriptions ?? (c.subscriptions_list_detail || []).length}</td><td>${(c.in_msgs || 0).toLocaleString()}</td><td>${(c.out_msgs || 0).toLocaleString()}</td><td>${(c.pending_bytes || 0) ? lib.bytesLabel(c.pending_bytes) : "0"}</td><td>${esc(c.idle || "")}</td><td>${esc(c._server || "")}</td></tr>`).join("")}</tbody></table></div>`;
        const seen = new Map(); for (const [k, v] of ctx.subjects()) seen.set(k, v.n);
        const self = client.info && client.info.client_id, usage = lib.subjectUsage({ connections: conns }, seen, self);
        srv$("#susage").innerHTML = `<h3 style="margin:10px 0 4px">Subject usage</h3><div class="hint">Subscriptions held by other clients, with how many messages this page saw matching each. <b>Seen but nobody else is subscribed:</b> ${usage.orphans.length ? usage.orphans.slice(0, 20).map(s => `<code>${esc(s)}</code>`).join(" ") + (usage.orphans.length > 20 ? ` … ${usage.orphans.length - 20} more` : "") : "none"}.</div>
          <div class="tscroll" style="max-height:30vh"><table class="kv"><thead><tr><th>Subscription</th><th>Subscribers</th><th>Queue groups</th><th>Clients</th><th>Messages seen</th></tr></thead><tbody>${usage.rows.slice(0, 300).map(r => `<tr><td class="v">${esc(r.subject)}</td><td>${r.subscribers}</td><td>${esc(r.queues.join(", "))}</td><td class="v">${esc(r.clients.slice(0, 4).join(", "))}${r.clients.length > 4 ? " …" : ""}</td><td>${r.observed ? r.observed.toLocaleString() : '<span class="hint">idle</span>'}</td></tr>`).join("") || `<tr><td colspan="5" class="hint">No subscriptions reported.</td></tr>`}</tbody></table></div>`;
        const limited = !stat.length || (!connz.length && !health.length);
        DT.status(srv$("#sstat"), limited ? "warn" : "ok", limited ? "This account only sees part of the picture. Server statistics, health and every client's subscriptions need a user from the system account." : `${stat.length} server${stat.length === 1 ? "" : "s"}, ${conns.length} connection${conns.length === 1 ? "" : "s"}.`);
      } catch (e) { DT.status(srv$("#sstat"), "err", e.message); }
    }
    srv$("#srefresh").onclick = refreshServer;
    srv$("#sauto2").onchange = e => { clearInterval(srvTimer); srvTimer = e.target.checked ? setInterval(() => { if (!root.isConnected) return clearInterval(srvTimer); if (activeTab === "srv") refreshServer(); }, 5000) : 0; };

    /* ---------- KV and objects ---------- */
    const kvHost = $("#x-kv");
    kvHost.innerHTML = `<div class="opts"><button class="btn primary" id="kvref" type="button">Load buckets</button><label>Bucket <select id="kvb" class="mono"></select></label><label title="Allows put, delete and purge"><input type="checkbox" id="kvw"> allow changes</label></div>
      <div class="status" id="kvst"></div><div id="kvbody"></div>`;
    const kv$ = s => kvHost.querySelector(s);
    let buckets = [], kvKeys = [], kvCurrent = null;
    const stopWatch = () => { if (kvWatchSub) { try { kvWatchSub.unsubscribe(); } catch (_) {} kvWatchSub = null; } };
    async function loadBuckets() {
      DT.status(kv$("#kvst"), "", "Loading…");
      try {
        const streams = await ctx.paged("STREAM.LIST", "streams");
        buckets = streams.map(s => s.config.name).filter(n => /^(KV|OBJ)_/.test(n)).sort();
        kv$("#kvb").innerHTML = buckets.map(n => `<option value="${esc(n)}">${n.startsWith("KV_") ? "KV · " + esc(n.slice(3)) : "Object · " + esc(n.slice(4))}</option>`).join("");
        DT.status(kv$("#kvst"), buckets.length ? "ok" : "warn", buckets.length ? `${buckets.length} bucket${buckets.length === 1 ? "" : "s"}.` : "No KV or object store buckets in this account.");
        if (buckets.length) openBucket(); else kv$("#kvbody").innerHTML = "";
      } catch (e) { DT.status(kv$("#kvst"), "err", e.message); }
    }
    kv$("#kvref").onclick = loadBuckets; kv$("#kvb").onchange = () => openBucket();
    kv$("#kvw").onchange = () => { if (kvCurrent) renderKvEntry(); kvHost.querySelectorAll(".kv-adm").forEach(x => { x.hidden = !kv$("#kvw").checked; }); };
    async function openBucket() {
      stopWatch(); const name = kv$("#kvb").value; if (!name) return;
      if (name.startsWith("OBJ_")) return openObjects(name.slice(4));
      const bucket = name.slice(3), body = kv$("#kvbody");
      body.innerHTML = `<div class="two"><div class="col"><label class="l">Keys</label><div class="opts"><input type="search" id="kvf" class="mono" placeholder="filter" style="width:200px"><label><input type="checkbox" id="kvwatch"> watch live</label></div><div class="tscroll" style="max-height:34vh"><table class="nl"><tbody id="kvkeys"></tbody></table></div>
        <div class="kv-adm" hidden><div class="opts" style="margin-top:8px"><input type="text" id="kvnk" class="mono" placeholder="new key" style="width:180px"><button class="btn" id="kvnew" type="button">Create key…</button></div></div></div><div class="col" id="kvdet"></div></div><div id="kvlive"></div>`;
      kv$("#kvbody .kv-adm").hidden = !kv$("#kvw").checked;
      try {
        const info = await ctx.api("STREAM.INFO.KV_" + bucket, { subjects_filter: `$KV.${bucket}.>` }), pre = `$KV.${bucket}.`;
        kvKeys = Object.keys(info.state.subjects || {}).map(s => s.slice(pre.length)).sort();
        const draw = () => { const f = kv$("#kvf").value.trim().toLowerCase(); kv$("#kvkeys").innerHTML = kvKeys.filter(k => !f || k.toLowerCase().includes(f)).slice(0, 500).map(k => `<tr data-k="${esc(k)}"><td class="s">${esc(k)}</td></tr>`).join("") || `<tr><td class="t">${kvKeys.length ? "No key matches." : "This bucket is empty."}</td></tr>`; };
        draw(); kv$("#kvf").oninput = DT.debounce(draw, 120);
        kv$("#kvkeys").onclick = e => { const tr = e.target.closest("tr[data-k]"); if (tr) openKey(bucket, tr.dataset.k); };
        kv$("#kvnew").onclick = () => newKey(bucket);
        kv$("#kvwatch").onchange = e => {
          stopWatch(); const live = kv$("#kvlive"); live.innerHTML = "";
          if (!e.target.checked) return;
          live.innerHTML = `<label class="l">Live changes</label><div class="tscroll" style="max-height:22vh"><table class="nl"><tbody id="kvch"></tbody></table></div>`;
          kvWatchSub = lib.kv.watch(client, bucket, ev => {
            if (!kvKeys.includes(ev.key)) { kvKeys.push(ev.key); kvKeys.sort(); draw(); }
            const tb = kv$("#kvch"); if (!tb) return;
            const v = lib.natsView(ev.value), tr = el("tr"); tr.innerHTML = `<td class="t">${hhmmss(ev.time)}</td><td class="s">${esc(ev.key)}</td><td class="ty">${esc(ev.op)}</td><td class="p">${esc(v.text.replace(/\s+/g, " ").slice(0, 100))}</td>`;
            tb.prepend(tr); while (tb.rows.length > 100) tb.deleteRow(-1);
          });
        };
      } catch (e) { DT.status(kv$("#kvst"), "err", e.message); }
    }
    async function openKey(bucket, key) {
      const det = kv$("#kvdet"); det.innerHTML = `<div class="status">Loading ${esc(key)}…</div>`;
      try { kvCurrent = { bucket, key, entry: await lib.kv.entry(ctx.api, bucket, key) }; renderKvEntry(); }
      catch (e) { kvCurrent = null; det.innerHTML = ""; DT.status(kv$("#kvst"), "err", e.errCode === 10037 ? "That key has no entries." : e.message); }
    }
    function renderKvEntry() {
      if (!kvCurrent) return; const { bucket, key, entry } = kvCurrent, det = kv$("#kvdet"), v = lib.natsView(entry.value), allow = kv$("#kvw").checked, gone = entry.op !== "PUT";
      det.innerHTML = `<div class="panel">${DT.kv([["key", key], ["revision", String(entry.revision)], ["operation", entry.op + (gone ? " (deleted marker)" : "")], ["time", entry.time || "-"], ["size", entry.value.length + " bytes (" + v.kind + ")"]])}
        <pre class="out" id="kvval"></pre>
        <div class="btns"><button class="btn" id="kvhist" type="button">History</button>${allow ? `<button class="btn" id="kvedit" type="button">Edit</button><button class="btn" id="kvdel" type="button">Delete</button><button class="btn" id="kvpurge" type="button">Purge</button>` : ""}</div>
        <div id="kvedbox"></div><div id="kvhistbox"></div></div>`;
      det.querySelector("#kvval").textContent = gone ? "(no value)" : v.kind === "empty" ? "(empty value)" : v.text;
      det.querySelector("#kvhist").onclick = async () => {
        const box = det.querySelector("#kvhistbox"); box.innerHTML = `<div class="status">Loading history…</div>`;
        try { const h = await lib.kv.history(ctx.api, bucket, key); box.innerHTML = `<label class="l">History (${h.length})</label><table class="kv"><thead><tr><th>Rev</th><th>Op</th><th>Time</th><th>Value</th></tr></thead><tbody>${h.map(x => `<tr><td>${x.revision}</td><td>${esc(x.op)}</td><td>${esc(x.time || "")}</td><td class="v">${esc(lib.natsView(x.value).text.replace(/\s+/g, " ").slice(0, 120))}</td></tr>`).join("")}</tbody></table>`; }
        catch (e) { box.innerHTML = `<div class="status err">${esc(e.message)}</div>`; }
      };
      if (!allow) return;
      const write = async (fn, ok) => { try { const r = await fn(); DT.status(kv$("#kvst"), "ok", ok(r)); await openKey(bucket, key); } catch (e) { DT.status(kv$("#kvst"), "err", e.errCode === 10071 ? "Someone changed this key since you opened it. Reload it and try again." : e.message); } };
      det.querySelector("#kvedit").onclick = () => {
        const box = det.querySelector("#kvedbox"); box.innerHTML = `<textarea id="kvnv" class="md" spellcheck="false"></textarea><div class="btns"><button class="btn primary" id="kvsave" type="button">Save (revision ${entry.revision + 1})</button></div>`;
        box.querySelector("#kvnv").value = v.kind === "binary" || gone ? "" : TD.decode(entry.value);
        box.querySelector("#kvsave").onclick = () => write(() => lib.kv.put(client, bucket, key, box.querySelector("#kvnv").value, { expected: entry.revision }), r => `Saved ${key} at revision ${r.revision}.`);
      };
      det.querySelector("#kvdel").onclick = () => { if (confirm(`Delete ${key}? History is kept; the key reads as deleted.`)) write(() => lib.kv.delete(client, bucket, key), r => `Deleted ${key} (revision ${r.revision}).`); };
      det.querySelector("#kvpurge").onclick = () => { if (confirm(`Purge ${key}? Every revision of it is removed.`)) write(() => lib.kv.purge(client, bucket, key), () => `Purged ${key}.`); };
    }
    function newKey(bucket) {
      const key = kv$("#kvnk").value.trim(), det = kv$("#kvdet");
      if (!lib.kv.validKey(key)) return DT.status(kv$("#kvst"), "err", "A key uses letters, digits and - _ = . / only.");
      det.innerHTML = `<div class="panel"><div class="hint">New key <code>${esc(key)}</code></div><textarea id="kvnv" class="md" spellcheck="false"></textarea><div class="btns"><button class="btn primary" id="kvcreate" type="button">Create</button></div></div>`;
      det.querySelector("#kvcreate").onclick = async () => {
        try { const r = await lib.kv.put(client, bucket, key, det.querySelector("#kvnv").value, { expected: 0 }); DT.status(kv$("#kvst"), "ok", `Created ${key} at revision ${r.revision}.`); await openBucket(); await openKey(bucket, key); }
        catch (e) { DT.status(kv$("#kvst"), "err", e.errCode === 10071 ? "That key already exists. Open it from the list to edit it." : e.message); }
      };
    }
    async function openObjects(bucket) {
      const body = kv$("#kvbody"); body.innerHTML = `<div class="status">Loading objects…</div>`;
      try {
        const list = await lib.obj.list(ctx.api, bucket);
        body.innerHTML = `<div class="tscroll" style="max-height:44vh"><table class="kv"><thead><tr><th>Name</th><th>Size</th><th>Chunks</th><th>Modified</th><th>Description</th><th></th></tr></thead><tbody>${list.map((o, i) => `<tr><td class="v">${esc(o.name)}</td><td>${lib.bytesLabel(o.size)}</td><td>${o.chunks}</td><td>${esc(o.mtime.replace("T", " ").replace(/\.\d+Z$|Z$/, "Z"))}</td><td class="v">${esc(o.description)}</td><td><button class="mini" data-i="${i}" type="button">download</button></td></tr>`).join("") || `<tr><td colspan="6" class="hint">This bucket has no objects.</td></tr>`}</tbody></table></div><div class="hint">Objects are read only here. Downloads are checked against the stored size and SHA-256.</div>`;
        body.onclick = async e => {
          const b = e.target.closest("button[data-i]"); if (!b) return; const o = list[+b.dataset.i];
          b.disabled = true; DT.status(kv$("#kvst"), "", `Downloading ${o.name}…`);
          try { const r = await lib.obj.get(ctx.api, bucket, o); DT.status(kv$("#kvst"), r.sizeOk && r.digestOk !== false ? "ok" : "err", `${o.name}: ${lib.bytesLabel(r.bytes.length)}, size ${r.sizeOk ? "ok" : "WRONG"}${r.digestOk === null ? "" : r.digestOk ? ", SHA-256 ok" : ", SHA-256 MISMATCH"}.`); DT.download(o.name.split("/").pop() || "object", r.bytes, "application/octet-stream"); }
          catch (err) { DT.status(kv$("#kvst"), "err", err.message); }
          b.disabled = false;
        };
        DT.status(kv$("#kvst"), "ok", `${list.length} object${list.length === 1 ? "" : "s"} in ${bucket}.`);
      } catch (e) { body.innerHTML = ""; DT.status(kv$("#kvst"), "err", e.message); }
    }

    /* ---------- JetStream administration (create, purge, delete) ---------- */
    function jsToolbar(host) {
      host.innerHTML = `<div class="opts"><label title="Unlocks the buttons that create, purge and delete streams, consumers and messages"><input type="checkbox" id="jwr"> allow changes</label><button class="btn" id="jcreate" type="button" hidden>Create stream…</button></div>
        <div id="jform" class="panel" hidden><div class="two"><div class="col"><label class="l">Name</label><input type="text" id="jfn" class="mono"><label class="l" style="margin-top:6px">Subjects (space or comma separated)</label><input type="text" id="jfs" class="mono" placeholder="orders.>"></div>
          <div class="col"><div class="opts"><label>Storage <select id="jfst" class="mono"><option value="file">file</option><option value="memory">memory</option></select></label><label>Retention <select id="jfr" class="mono"><option value="limits">limits</option><option value="interest">interest</option><option value="workqueue">work queue</option></select></label><label>Replicas <select id="jfrep" class="mono"><option>1</option><option>3</option><option>5</option></select></label></div>
          <div class="opts"><label>Max msgs <input type="text" id="jfmm" class="mono" style="width:90px" placeholder="no limit"></label><label>Max bytes <input type="text" id="jfmb" class="mono" style="width:100px" placeholder="no limit"></label><label>Max age (s) <input type="text" id="jfma" class="mono" style="width:90px" placeholder="no limit"></label><label>Per subject <input type="text" id="jfmp" class="mono" style="width:80px" placeholder="no limit"></label></div></div></div>
          <div class="btns"><button class="btn primary" id="jfgo" type="button">Create</button></div><div class="status" id="jfst2"></div></div>`;
      const q = s => host.querySelector(s);
      q("#jwr").onchange = e => { writeOn = e.target.checked; q("#jcreate").hidden = !writeOn; if (!writeOn) q("#jform").hidden = true; root.querySelectorAll(".adm-block").forEach(b => { b.hidden = !writeOn; }); };
      q("#jcreate").onclick = () => { q("#jform").hidden = !q("#jform").hidden; };
      q("#jfgo").onclick = async () => {
        try {
          const cfg = lib.jsStreamConfig({ name: q("#jfn").value, subjects: q("#jfs").value, storage: q("#jfst").value, retention: q("#jfr").value, replicas: q("#jfrep").value, maxMsgs: q("#jfmm").value, maxBytes: q("#jfmb").value, maxAge: q("#jfma").value, maxPerSubject: q("#jfmp").value });
          DT.status(q("#jfst2"), "", "Creating…"); await lib.jsOps.streamCreate(ctx.api, cfg);
          DT.status(q("#jfst2"), "ok", `Created ${cfg.name}.`); q("#jform").hidden = true; ctx.refreshJs();
        } catch (e) { DT.status(q("#jfst2"), "err", e.message); }
      };
    }
    /* Appended to a stream's detail panel: purge, delete, consumers, republish; plus the lag chart. */
    function streamAdmin(det, name, consumers, reload) {
      const box = el("div", "panel adm-block"); box.hidden = !writeOn; box.style.marginTop = "12px";
      box.innerHTML = `<label class="l">Changes to ${esc(name)}</label>
        <div class="opts"><label>Purge <select id="pm" class="mono"><option value="all">everything</option><option value="filter">one subject</option><option value="keep">keep the newest N</option><option value="seq">everything below sequence</option></select></label><input type="text" id="pv" class="mono" placeholder="" style="width:200px" hidden><button class="btn" id="pgo" type="button">Purge…</button><button class="btn" id="dgo" type="button">Delete stream…</button></div>
        <div class="opts"><label>Delete message # <input type="number" id="dseq" min="1" class="mono" style="width:100px"></label><button class="btn" id="dmsg" type="button">Delete message…</button></div>
        <div class="opts"><label>Add consumer <input type="text" id="cn" class="mono" placeholder="name" style="width:130px"></label><label>filter <input type="text" id="cf" class="mono" placeholder="optional subject" style="width:150px"></label>
          <label><select id="ca" class="mono"><option value="explicit">ack explicit</option><option value="none">ack none</option><option value="all">ack all</option></select></label><label><select id="cd" class="mono"><option value="all">deliver all</option><option value="new">new only</option><option value="last">last</option><option value="last_per_subject">last per subject</option></select></label>
          <button class="btn" id="cgo" type="button">Add consumer</button></div>
        <div class="opts"><label>Delete consumer <select id="cdel" class="mono">${consumers.map(c => `<option>${esc(c.name)}</option>`).join("")}</select></label><button class="btn" id="cdgo" type="button">Delete…</button></div>
        <div class="opts"><label>Republish #<input type="number" id="rf" min="1" class="mono" style="width:90px"> to #<input type="number" id="rt" min="1" class="mono" style="width:90px"></label><label>onto <input type="text" id="rs" class="mono" placeholder="subject" style="width:180px"></label><label>every <input type="number" id="rd" value="0" min="0" class="mono" style="width:70px"> ms</label><button class="btn" id="rgo" type="button">Republish</button></div>
        <div class="status" id="ast2"></div>`;
      det.appendChild(box);
      const q = s => box.querySelector(s), st = (k, m) => DT.status(q("#ast2"), k, m);
      if (adminNote) { st(adminNote[0], adminNote[1]); adminNote = null; }                 // what the last action reported, shown again after the panel reloads
      const hints = { all: "", filter: "subject, e.g. orders.new", keep: "number of messages to keep", seq: "sequence number" };
      q("#pm").onchange = () => { q("#pv").hidden = q("#pm").value === "all"; q("#pv").placeholder = hints[q("#pm").value]; };
      const run = async (what, fn) => { try { st("", what + "…"); const r = await fn(); adminNote = ["ok", what + ": done."]; await reload(); return r; } catch (e) { adminNote = null; st("err", e.message); } };
      q("#pgo").onclick = () => {
        const m = q("#pm").value, v = q("#pv").value.trim(); let body = {};
        if (m === "filter") { const p = lib.natsSubjectProblem(v, true); if (p) return st("err", "Subject: " + p); body = { filter: v }; }
        else if (m === "keep" || m === "seq") { if (!/^\d+$/.test(v) || +v < 1) return st("err", "Enter a whole number."); body = m === "keep" ? { keep: +v } : { seq: +v }; }
        if (confirm(`Purge ${m === "all" ? "ALL messages" : "messages (" + m + " " + v + ")"} from ${name}? This cannot be undone.`)) run("Purge", () => lib.jsOps.streamPurge(ctx.api, name, body));
      };
      q("#dgo").onclick = () => { if (confirm(`Delete the stream ${name} and all its messages and consumers? This cannot be undone.`)) run("Delete stream", async () => { await lib.jsOps.streamDelete(ctx.api, name); det.innerHTML = ""; ctx.refreshJs(); }); };
      q("#dmsg").onclick = () => { const s = +q("#dseq").value; if (!(s >= 1)) return st("err", "Enter a sequence number."); if (confirm(`Delete message #${s} from ${name}?`)) run("Delete message", () => lib.jsOps.msgDelete(ctx.api, name, s)); };
      q("#cgo").onclick = () => { try { const cfg = lib.jsConsumerConfig({ name: q("#cn").value, filter: q("#cf").value, ack: q("#ca").value, deliver: q("#cd").value }); run("Add consumer", () => lib.jsOps.consumerCreate(ctx.api, name, cfg)); } catch (e) { st("err", e.message); } };
      q("#cdgo").onclick = () => { const c = q("#cdel").value; if (c && confirm(`Delete consumer ${c}?`)) run("Delete consumer", () => lib.jsOps.consumerDelete(ctx.api, name, c)); };
      q("#rgo").onclick = async () => {
        const f = +q("#rf").value, t = +q("#rt").value, s = q("#rs").value.trim();
        if (!(f >= 1 && t >= f)) return st("err", "Enter a sequence range (from, to).");
        if (!confirm(`Publish messages #${f}-#${t} of ${name} onto ${s}? If ${s} is captured by a stream, they are stored again.`)) return;
        try { const r = await lib.jsOps.republish(ctx.api, client, name, f, t, s, { delayMs: +q("#rd").value || 0, onProgress: p => st("", `Republishing… ${p.sent} sent, ${p.missing} missing`) }); st("ok", `Republished ${r.sent} message${r.sent === 1 ? "" : "s"}${r.missing ? `; ${r.missing} sequence number${r.missing === 1 ? " was" : "s were"} not found` : ""}.`); }
        catch (e) { st("err", e.message); }
      };
    }
    /* Consumer lag chart for the open stream; sampling stops when the panel goes away. */
    function lagWatch(det, name) {
      clearInterval(lagTimer); lag.clear();
      const box = el("div", "chart"); box.style.marginTop = "12px";
      box.innerHTML = `<h3>Consumer lag over time</h3><p class="sub">Sampled every 2 s while this stream is open. A consumer is flagged when its backlog keeps growing, when redeliveries start, or when work is waiting and nothing moves.</p><div id="lagh" class="chip-row"></div><div class="plot"></div>`;
      det.appendChild(box); det.dataset.stream = name;
      const sample = async () => {
        if (!det.isConnected || det.dataset.stream !== name || !root.isConnected) return clearInterval(lagTimer);
        try {
          lag.sample(name, await ctx.paged("CONSUMER.LIST." + name, "consumers"));
          const rows = lag.rows().filter(r => r.stream === name);
          if (!rows.length) { box.querySelector(".plot").innerHTML = `<div class="hint" style="padding:8px 4px">No consumers on this stream.</div>`; box.querySelector("#lagh").innerHTML = ""; return; }
          const now = Date.now(), series = rows.flatMap(r => [{ name: r.name + " pending", points: r.points.map(p => [(p.t - now) / 1000, p.pending]) }, { name: r.name + " ack pending", points: r.points.map(p => [(p.t - now) / 1000, p.ackPending]) }]).slice(0, 8);
          const c = lib.chartLine(series, { zero: true, xFmt: x => (x >= -0.5 ? "now" : Math.round(x) + " s"), yFmt: v => lib.chartNum(v), w: 520, h: 160 });
          box.querySelector(".plot").innerHTML = c.svg; lib.chartAttachLine(box, c.plot);
          box.querySelector("#lagh").innerHTML = rows.map(r => `<span class="chip" style="${r.health !== "ok" ? "color:var(--warn);border-color:var(--warn)" : ""}">${esc(r.name)}: ${esc(r.health)}</span>`).join("");
        } catch (_) { /* a failed sample is just a gap */ }
      };
      sample(); lagTimer = setInterval(sample, 2000);
    }

    /* ---------- message diff, added to the feed's detail panel ---------- */
    let marked = null;
    function decorateDetail(box, m) {
      const bar = box.querySelector(".btns"); if (!bar || !m.payload) return;
      const out = el("div"); out.className = "diffout"; box.insertBefore(out, box.querySelector(".pl"));
      const mk = (label, fn) => { const b = el("button", "btn", label); b.type = "button"; b.onclick = fn; bar.append(b); return b; };
      const show = (a, b, la, lb) => {
        const d = lib.payloadDiff(a.payload, b.payload, {});
        if (d.same) { out.innerHTML = `<div class="status ok">Identical (${esc(la)} and ${esc(lb)}).</div>`; return; }
        if (d.structured) {
          out.innerHTML = `<div class="status warn">${d.changes.length} field${d.changes.length === 1 ? "" : "s"} differ between ${esc(la)} and ${esc(lb)}.</div><table class="kv"><thead><tr><th>Field</th><th>${esc(la)}</th><th>${esc(lb)}</th><th></th></tr></thead><tbody>${d.changes.slice(0, 300).map(c => `<tr><td class="s">${esc(c.path)}</td><td class="v">${esc(c.a === undefined ? "(absent)" : String(c.a))}</td><td class="v">${esc(c.b === undefined ? "(absent)" : String(c.b))}</td><td class="t">${c.type}</td></tr>`).join("")}</tbody></table>`;
        } else {
          let ops; try { ops = lib.foldContext(lib.lineDiff(TD.decode(a.payload), TD.decode(b.payload)), 2); } catch (e) { out.innerHTML = `<div class="status err">${esc(e.message)}</div>`; return; }
          out.innerHTML = `<div class="diff">${ops.map(o => o.t === "gap" ? `<div class="ctx">… ${o.n} unchanged lines</div>` : `<div class="${o.t}">${o.t === "add" ? "+ " : o.t === "del" ? "- " : "  "}${esc(o.line)}</div>`).join("")}</div>`;
        }
      };
      mk("Diff with previous", () => {
        const list = ctx.msgs(), i = list.indexOf(m); let prev = null;
        for (let k = i - 1; k >= 0; k--) if (list[k].subject === m.subject) { prev = list[k]; break; }
        if (!prev) { out.innerHTML = `<div class="status warn">No earlier message on ${esc(m.subject)} in the feed.</div>`; return; }
        show(prev, m, hhmmss(prev.t), hhmmss(m.t));
      });
      mk(marked === m ? "Marked for diff" : "Mark for diff", e => { marked = m; e.currentTarget.textContent = "Marked for diff"; });
      mk("Diff with marked", () => { if (!marked || marked === m) { out.innerHTML = `<div class="status warn">Mark another message first (open it and press Mark for diff).</div>`; return; } show(marked, m, "marked " + hhmmss(marked.t), "this " + hhmmss(m.t)); });
    }

    /* ---------- responder and scenario ---------- */
    const rootOf = m => (ctx.rootOf ? ctx.rootOf(m) : "");
    const scn = lib.scenarioUi($("#x-scn"), { storeKey: "dt.nats.scenario", word: "subject", send: async (topic, text) => { client.publish(topic, TE.encode(text)); },
      recent: () => ctx.msgs().slice(-50).map(m => ({ t: m.t, topic: m.subject, text: TD.decode(m.payload) })) });
    const responder = lib.responderUi($("#x-resp"), { storeKey: "dt.nats.responder", word: "subject", withMessage: true, reply: async (topic, text) => { client.publish(topic, TE.encode(text)); } });

    return {
      /* every message, before any filter */
      onMsg(m, now) {
        tracker.observe({ subject: m.subject, reply: m.reply, status: m.status }, now);
        if (observed.size < 20000 || observed.has(m.subject)) observed.set(m.subject, (observed.get(m.subject) || 0) + 1);
        if (responder.count && m.subject.charCodeAt(0) !== 95 && m.subject.charCodeAt(0) !== 36 && m.payload.length < 200000) {
          let text = ""; try { text = new TextDecoder("utf-8", { fatal: true }).decode(m.payload); } catch (_) { return; }
          responder.handle({ topic: m.subject, message: rootOf(m), text, replyTo: m.reply });
        }
      },
      tick() { if (activeTab === "lat") drawLatency(); },
      show(tab) {
        activeTab = tab;
        if (tab === "lat") drawLatency();
        if (tab === "srv" && !srv$("#sservers").innerHTML) refreshServer();
        if (tab === "kv" && !buckets.length) loadBuckets();
        if (tab !== "kv") stopWatch();
      },
      close() { clearInterval(lagTimer); clearInterval(srvTimer); stopWatch(); scn.stop(); },
      decorateDetail, jsToolbar, streamAdmin, lagWatch,
    };
  };
})();
