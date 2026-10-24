/* The traffic views (Bus, Transactions, Analysis, Map) on a TrafficStore from uci-analysis.js. Used by the UCI Traffic Lab tool (saved
   captures) and as the Analyze tab of the NATS and CAL explorers (live traffic). lib.trafficLab(host, opts) -> { destroy(), refresh() }.
   opts: { store, getModel(), live (bool: "now" is the wall clock, else the newest record), extraTabs: [{ key, label, render(el) }] } */
(function () {
  const lib = DT.lib, esc = DT.esc;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const short = id => (id && id.length > 12 ? id.slice(0, 8) : id) || "";
  const dur = ms => !Number.isFinite(ms) ? "–" : Math.abs(ms) < 1000 ? Math.round(ms) + " ms" : Math.abs(ms) < 60000 ? (ms / 1000).toFixed(1) + " s" : Math.abs(ms) < 3600000 ? (ms / 60000).toFixed(1) + " min" : (ms / 3600000).toFixed(1) + " h";
  const clock = t => new Date(t).toISOString().slice(11, 23);
  const COLORS = lib.chartColors || ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  const badge = (cls, text, title) => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;

  lib.trafficLab = function (host, opts) {
    const store = opts.store, live = opts.live !== false;
    let tab = "bus", destroyed = false, lastVer = -1, lastDraw = 0, selectedTx = "", txSort = "recent", txFilter = "", hidePopular = true;
    const extra = opts.extraTabs || [];
    host.innerHTML = `<div class="tabs lab"><button class="tab on" data-t="bus" type="button">Bus</button><button class="tab" data-t="tx" type="button">Transactions</button><button class="tab" data-t="an" type="button">Analysis</button><button class="tab" data-t="map" type="button">Map</button>${extra.map(x => `<button class="tab" data-t="${esc(x.key)}" type="button">${esc(x.label)}</button>`).join("")}<span class="hint" id="lstat" style="margin-left:auto;align-self:center"></span></div><div id="lbody"></div>`;
    const body = host.querySelector("#lbody"), stat = host.querySelector("#lstat");
    const now = () => live ? Date.now() : (store.records.length ? Math.max(...store.records.slice(-200).map(r => r.t)) : 0);

    host.querySelector(".tabs.lab").onclick = e => { const b = e.target.closest(".tab"); if (!b) return; tab = b.dataset.t; host.querySelectorAll(".tabs.lab .tab").forEach(x => x.classList.toggle("on", x === b)); lastVer = -1; mounted = ""; draw(true); };
    let mounted = "";

    /* ---------------- Bus ---------------- */
    function drawBus() {
      const rows = store.bus(now());
      if (!rows.length) { body.innerHTML = `<div class="hint" style="padding:14px 4px">No messages decoded yet. Systems appear as their MessageHeader SystemID shows up.</div>`; return; }
      const open = drawBus.open || (drawBus.open = new Set());
      body.innerHTML = `<div class="hint" style="margin:6px 0">${rows.length} system${rows.length === 1 ? "" : "s"} seen, by MessageHeader SystemID. Click a row for its message types.</div><div class="tscroll" style="max-height:62vh"><table class="kv"><thead><tr><th>System</th><th>Services</th><th>Messages</th><th>Types</th><th>Last minute</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>${rows.map(r => {
        const stale = r.ageMs > 30000;
        return `<tr data-s="${esc(r.id)}" style="cursor:pointer"><td class="v" title="${esc(r.id)}">${esc(short(r.id))}${r.id.length > 12 ? "…" : ""} ${stale ? badge("warn", "quiet " + dur(r.ageMs)) : badge("ok", "active")}</td><td class="v">${r.services.map(short).join(", ") || "–"}</td><td>${r.count.toLocaleString()}</td><td>${r.types}</td><td>${r.ratePerMin.toLocaleString()}</td><td class="v">${clock(r.first)}</td><td class="v">${clock(r.last)}</td></tr>`
          + (open.has(r.id) ? `<tr><td colspan="7" class="v" style="background:var(--code)">${r.messages.map(([n, c]) => `<span class="chip" style="cursor:default">${esc(n)} ${c.toLocaleString()}</span>`).join(" ")}</td></tr>` : "");
      }).join("")}</tbody></table></div>`;
      body.querySelector("tbody").onclick = e => { const tr = e.target.closest("tr[data-s]"); if (tr) { const s = tr.dataset.s; if (open.has(s)) open.delete(s); else open.add(s); drawBus(); } };
    }

    /* ---------------- Transactions ---------------- */
    function drawTx() {
      if (mounted !== "tx") {
        body.innerHTML = `<div class="opts"><input type="search" id="txq" class="mono" placeholder="identifier, message or field name" style="width:300px" value="${esc(txFilter)}"><label>Sort <select id="txs" class="mono"><option value="recent">most recent</option><option value="count">most messages</option><option value="span">longest</option></select></label><label title="Identifiers that appear in over a quarter of all messages (a system's own id, a capability id) tell you little"><input type="checkbox" id="txp" ${hidePopular ? "checked" : ""}> hide very common identifiers</label></div>
          <div class="hint" style="margin-bottom:6px">Messages that mention the same identifier belong together: a command and its statuses, a plan and its status. Pick one to follow it through time.</div>
          <div class="xg"><div class="left"><div class="reslist" id="txlist"></div></div><div id="txdet"></div></div>`;
        body.querySelector("#txs").value = txSort;
        body.querySelector("#txq").oninput = e => { txFilter = e.target.value; fillTxList(); };
        body.querySelector("#txs").onchange = e => { txSort = e.target.value; fillTxList(); };
        body.querySelector("#txp").onchange = e => { hidePopular = e.target.checked; fillTxList(); };
        body.querySelector("#txlist").onclick = e => { const r = e.target.closest(".res"); if (r) { selectedTx = r.dataset.u; fillTxList(); fillTxDetail(); } };
        mounted = "tx";
      }
      fillTxList(); fillTxDetail();
    }
    function fillTxList() {
      const q = txFilter.trim().toLowerCase();
      let list = store.transactions({ min: 2 }).filter(t => (!hidePopular || !t.popular) && (!q || t.uuid.includes(q) || t.names.some(n => n.toLowerCase().includes(q)) || t.roles.some(r => r.toLowerCase().includes(q))));
      list.sort(txSort === "count" ? (a, b) => b.count - a.count : txSort === "span" ? (a, b) => b.span - a.span : (a, b) => b.last - a.last);
      const box = body.querySelector("#txlist");
      box.innerHTML = list.slice(0, 300).map(t => `<div class="res${t.uuid === selectedTx ? " on" : ""}" data-u="${t.uuid}"><b>${esc(short(t.uuid))}</b><span class="sub">${t.count} msgs · ${esc(t.names.slice(0, 3).join(", "))}${t.names.length > 3 ? "…" : ""} · ${dur(t.span)}</span></div>`).join("") || `<div class="hint" style="padding:10px">${store.pending ? "Decoding…" : "No identifier is shared by two or more messages yet."}</div>`;
    }
    function fillTxDetail() {
      const box = body.querySelector("#txdet"); if (!selectedTx) { box.innerHTML = `<div class="hint" style="padding:10px">Select an identifier on the left.</div>`; return; }
      const rows = store.timeline(selectedTx); if (!rows.length) { box.innerHTML = ""; return; }
      const t0 = rows[0].t, span = Math.max(1, rows[rows.length - 1].t - t0);
      const lanes = [...new Set(rows.map(r => r.name))];
      const W = 760, H = 26 + lanes.length * 24, X = t => 120 + (t - t0) / span * (W - 150);
      const dots = rows.map((r, i) => `<circle cx="${X(r.t).toFixed(1)}" cy="${20 + lanes.indexOf(r.name) * 24}" r="5" fill="${COLORS[lanes.indexOf(r.name) % 8]}" class="ring"><title>${esc(`${r.name} at +${dur(r.t - t0)}${r.states.length ? ": " + r.states.map(s => s.value).join(", ") : ""}`)}</title></circle>`).join("");
      const line = rows.map((r, i) => (i ? "L" : "M") + X(r.t).toFixed(1) + " " + (20 + lanes.indexOf(r.name) * 24)).join("");
      const flow = []; for (const r of rows) for (const s of r.states.slice(0, 1)) if (!flow.length || flow[flow.length - 1] !== s.value) flow.push(s.value);
      box.innerHTML = `<div class="dhead"><h2 style="font-size:16px">${esc(selectedTx)}</h2><button class="mini" data-copytext="${esc(selectedTx)}" type="button">copy</button></div>
        <div class="meta"><span>${rows.length} messages</span><span>over ${dur(span)}</span><span>${lanes.length} message type${lanes.length === 1 ? "" : "s"}</span></div>
        ${flow.length > 1 ? `<div class="hint" style="margin-bottom:6px">State flow: ${flow.map(esc).join(" → ")}</div>` : ""}
        <div class="chart" style="margin:6px 0"><svg class="ch" viewBox="0 0 ${W} ${H}" width="100%"><g>${lanes.map((n, i) => `<text x="112" y="${24 + i * 24}" text-anchor="end">${esc(n.length > 18 ? n.slice(0, 17) + "…" : n)}</text><line class="grid" x1="120" x2="${W - 30}" y1="${20 + i * 24}" y2="${20 + i * 24}"/>`).join("")}<path d="${line}" fill="none" stroke="#5d6b7c" stroke-width="1.5"/>${dots}</g></svg></div>
        <div class="tscroll" style="max-height:44vh"><table class="kv"><thead><tr><th>Time</th><th>Δ</th><th>Message</th><th>System</th><th>Where the id is</th><th>States</th></tr></thead><tbody>${rows.map(r => `<tr><td class="v">${clock(r.t)}</td><td>${r.delta ? "+" + dur(r.delta) : ""}</td><td class="v"><b>${esc(r.name || "?")}</b> ${r.valid === false ? badge("err", "invalid") : ""}<div class="hint">${esc(r.topic)}</div></td><td class="v" title="${esc(r.sys)}">${esc(short(r.sys))}</td><td class="v">${esc(r.paths.join(", "))}</td><td class="v">${r.states.map(s => esc(s.value)).join(", ")}</td></tr>`).join("")}</tbody></table></div>`;
    }

    /* ---------------- Analysis ---------------- */
    let anCache = { ver: -1, at: 0, val: null };
    function drawAnalysis() {
      if (anCache.ver !== store.version && Date.now() - anCache.at > 1500) anCache = { ver: store.version, at: Date.now(), val: store.analysis() };
      const a = anCache.val; if (!a || !a.total) { body.innerHTML = `<div class="hint" style="padding:14px 4px">Nothing to analyse yet.</div>`; return; }
      const lat = a.latency;
      const tile = (l, v, s = "") => `<div class="tile"><div class="tl">${l}</div><div class="tv">${esc(String(v))}</div>${s}</div>`;
      body.innerHTML = `<div class="tiles">${tile("Messages", a.total.toLocaleString())}${tile("Systems", a.systems)}${tile("Span", dur(a.spanMs))}${tile("Valid", a.valid.toLocaleString())}${tile("Invalid", a.invalid.toLocaleString())}${tile("Unknown to schema", a.unknown.toLocaleString())}${tile("Duplicates", a.duplicates.toLocaleString())}${tile("Out of order", a.outOfOrder.toLocaleString())}${lat ? tile("Latency p50 / p95", dur(lat.p50) + " / " + dur(lat.p95)) : ""}</div>
        <div class="hint" style="margin:4px 0">${lat ? `Latency is receive time minus the MessageHeader Timestamp (n = ${lat.count.toLocaleString()}; it includes clock differences between systems; min ${dur(lat.min)}, max ${dur(lat.max)}). ` : ""}${a.nsMismatch ? `${a.nsMismatch} message(s) use a namespace other than the schema's. ` : ""}${a.versions.length ? "SchemaVersion in headers: " + a.versions.map(([v, n]) => `${esc(v)} (${n})`).join(", ") + ". " : ""}${store.dropped ? `${store.dropped.toLocaleString()} older messages were dropped to stay within the cap. ` : ""}${store.pending ? `Still decoding ${store.pending.toLocaleString()} messages…` : ""}</div>
        <div class="two"><div class="chart"><h3>Messages by type</h3><div id="anbars"></div></div><div class="chart"><h3>Gaps in a stream</h3><p class="sub">Silences longer than 5 times the usual interval for a system and message type.</p><div class="tscroll" style="max-height:34vh">${a.gaps.length ? `<table class="kv"><thead><tr><th>System</th><th>Message</th><th>After</th><th>Gap</th><th>Usual</th></tr></thead><tbody>${a.gaps.map(g => `<tr><td class="v">${esc(short(g.system))}</td><td class="v">${esc(g.name)}</td><td class="v">${clock(g.at)}</td><td>${dur(g.gapMs)}</td><td>${dur(g.medianMs)}</td></tr>`).join("")}</tbody></table>` : `<div class="hint">None found.</div>`}</div></div></div>
        <div class="chart"><h3>Per message type</h3><div class="tscroll" style="max-height:48vh"><table class="kv"><thead><tr><th>Message</th><th>Count</th><th>Size</th><th>Valid</th><th>Invalid</th><th>Topics</th><th>Most common problem</th></tr></thead><tbody>${a.messages.map(m => `<tr><td class="v"><b>${esc(m.name)}</b>${m.unknown ? " " + badge("warn", "not in schema") : ""}</td><td>${m.count.toLocaleString()}</td><td>${lib.bytesLabel(m.bytes / m.count)} avg</td><td>${m.valid + m.invalid ? Math.round(100 * m.valid / (m.valid + m.invalid)) + "%" : "–"}</td><td>${m.invalid || ""}</td><td class="v">${m.topics.length}</td><td class="v">${m.errors.length ? esc(m.errors[0][0]) + " <span class='hint'>×" + m.errors[0][1] + "</span>" : ""}</td></tr>`).join("")}</tbody></table></div></div>`;
      body.querySelector("#anbars").innerHTML = lib.chartBars(a.messages.slice(0, 14).map(m => ({ label: m.name, value: m.count, color: m.invalid ? lib.chartColors[1] : lib.chartColors[0], tip: `${m.name}: ${m.count} (${m.invalid} invalid)` })), { labelW: 160, w: 420, fmt: v => v.toLocaleString() });
      lib.chartAttachTips(body.querySelector("#anbars").parentElement);
    }

    /* ---------------- Map ---------------- */
    const M = { view: null, unit: "auto", trail: 50, follow: true, cur: 0, playing: 0, sel: "", drag: null, tracks: [], hit: [], raf: 0, fitted: false };
    function drawMap() {
      if (mounted !== "map") {
        body.innerHTML = `<div class="opts" style="margin:0 0 6px"><label>Angles <select id="mu" class="mono"><option value="auto">auto (UCI: radians)</option><option value="radians">radians</option><option value="degrees">degrees</option></select></label><label>Trail <select id="mt" class="mono"><option value="10">10 points</option><option value="50" selected>50 points</option><option value="500">500 points</option><option value="100000">everything</option></select></label><button class="btn" id="mf" type="button">Fit</button><button class="btn" id="mp" type="button">Play</button><label><input type="checkbox" id="mfl" checked> follow newest</label><span class="hint" id="mi"></span></div>
          <div class="opts" style="margin:0 0 6px"><input type="range" id="ms" min="0" max="1000" value="1000" style="flex:1"><span class="hint" id="mc" style="min-width:12ch"></span></div>
          <div class="chart" style="padding:0;position:relative"><canvas id="mcv" style="width:100%;height:56vh;display:block;cursor:grab"></canvas><div class="ctip" id="mtip" hidden></div></div><div class="chip-row" id="mleg" style="margin-top:6px"></div>`;
        const cv = body.querySelector("#mcv");
        body.querySelector("#mu").onchange = e => { M.unit = e.target.value; M.fitted = false; mapData(); paintMap(); };
        body.querySelector("#mt").onchange = e => { M.trail = +e.target.value; paintMap(); };
        body.querySelector("#mf").onclick = () => { fitMap(); paintMap(); };
        body.querySelector("#mfl").onchange = e => { M.follow = e.target.checked; if (M.follow) { M.cur = Infinity; syncSlider(); paintMap(); } };
        body.querySelector("#ms").oninput = e => { M.follow = false; body.querySelector("#mfl").checked = false; const r = timeRange(); M.cur = r[0] + (r[1] - r[0]) * (+e.target.value / 1000); paintMap(); };
        body.querySelector("#mp").onclick = e => {
          if (M.playing) { clearInterval(M.playing); M.playing = 0; e.target.textContent = "Play"; return; }
          const r = timeRange(); if (!(r[1] > r[0])) return;
          M.follow = false; body.querySelector("#mfl").checked = false; if (!(M.cur < r[1])) M.cur = r[0];
          e.target.textContent = "Pause";
          M.playing = setInterval(() => { const rr = timeRange(); M.cur += (rr[1] - rr[0]) / 300; if (M.cur >= rr[1]) { M.cur = rr[1]; clearInterval(M.playing); M.playing = 0; body.querySelector("#mp").textContent = "Play"; } syncSlider(); paintMap(); }, 50);
        };
        cv.addEventListener("wheel", e => { e.preventDefault(); const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, v = M.view; const lon = (mx - r.width / 2) / v.k + v.lon, lat = v.lat - (my - r.height / 2) / v.k; v.k = Math.min(4000, Math.max(1.2, v.k * (e.deltaY < 0 ? 1.25 : 0.8))); v.lon = lon - (mx - r.width / 2) / v.k; v.lat = lat + (my - r.height / 2) / v.k; paintMap(); }, { passive: false });
        cv.addEventListener("mousedown", e => { M.drag = { x: e.clientX, y: e.clientY, lon: M.view.lon, lat: M.view.lat }; cv.style.cursor = "grabbing"; });
        window.addEventListener("mouseup", () => { M.drag = null; cv.style.cursor = "grab"; });
        cv.addEventListener("mousemove", e => {
          const r = cv.getBoundingClientRect();
          if (M.drag) { M.view.lon = M.drag.lon - (e.clientX - M.drag.x) / M.view.k; M.view.lat = M.drag.lat + (e.clientY - M.drag.y) / M.view.k; paintMap(); return; }
          const mx = e.clientX - r.left, my = e.clientY - r.top; let best = null, bd = 100;
          for (const h of M.hit) { const d = (h.x - mx) ** 2 + (h.y - my) ** 2; if (d < bd) { bd = d; best = h; } }
          const tip = body.querySelector("#mtip");
          if (best) { tip.hidden = false; tip.innerHTML = `<div class="tt-h">${esc(best.tr.id.length > 12 ? short(best.tr.id) : best.tr.id)} · ${esc(best.tr.name || "")}</div><div>${best.p.lat.toFixed(4)}°, ${best.p.lon.toFixed(4)}°${Number.isFinite(best.p.alt) ? " · alt " + Math.round(best.p.alt) : ""}</div><div class="tt-h">${clock(best.p.t)}</div>`; tip.style.left = Math.min(r.width - 220, mx + 14) + "px"; tip.style.top = Math.max(0, my - 10) + "px"; } else tip.hidden = true;
        });
        cv.addEventListener("mouseleave", () => { body.querySelector("#mtip").hidden = true; });
        cv.addEventListener("dblclick", () => { fitMap(); paintMap(); });
        body.querySelector("#mleg").onclick = e => { const c = e.target.closest(".chip"); if (c) { M.sel = M.sel === c.dataset.id ? "" : c.dataset.id; const t = M.tracks.find(x => x.id === M.sel); if (t) { const p = t.points[t.points.length - 1]; M.view.lon = p.lon; M.view.lat = p.lat; M.view.k = Math.max(M.view.k, 30); } legend(); paintMap(); } };
        mounted = "map"; M.fitted = false; M.cur = Infinity;
      }
      mapData(); if (!M.fitted && M.tracks.length) fitMap(); else if (!M.view) M.view = { lon: 0, lat: 20, k: 3 };
      syncSlider(); paintMap();
    }
    const timeRange = () => { let a = Infinity, b = -Infinity; for (const t of M.tracks) { a = Math.min(a, t.points[0].t); b = Math.max(b, t.points[t.points.length - 1].t); } return a <= b ? [a, b] : [0, 1]; };
    function syncSlider() { const r = timeRange(), s = body.querySelector("#ms"); if (!s) return; const c = M.cur === Infinity ? r[1] : Math.min(M.cur, r[1]); s.value = r[1] > r[0] ? Math.round(1000 * (c - r[0]) / (r[1] - r[0])) : 1000; body.querySelector("#mc").textContent = M.tracks.length ? clock(c) : ""; }
    function mapData() { M.tracks = store.tracks(M.unit); const pts = M.tracks.reduce((n, t) => n + t.points.length, 0); body.querySelector("#mi").textContent = M.tracks.length ? `${M.tracks.length} entit${M.tracks.length === 1 ? "y" : "ies"}, ${pts.toLocaleString()} positions. Drag to pan, wheel to zoom, double-click to fit.` : "No positions yet: messages with Latitude and Longitude (UCI radians, or lat/lon degrees in JSON) appear here."; if (M.follow) M.cur = Infinity; legend(); }
    function legend() { body.querySelector("#mleg").innerHTML = M.tracks.slice(0, 40).map((t, i) => `<span class="chip" data-id="${esc(t.id)}" style="${M.sel === t.id ? "color:var(--accent);border-color:var(--accent)" : ""}"><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:${COLORS[i % 8]}"></span>${esc(t.id.length > 12 ? short(t.id) : t.id)} ${esc(t.name || "")} · ${t.points.length}</span>`).join("") + (M.tracks.length > 40 ? ` <span class="hint">…${M.tracks.length - 40} more</span>` : ""); }
    function fitMap() {
      const all = M.tracks.flatMap(t => t.points); if (!all.length) { M.view = { lon: 0, lat: 20, k: 3 }; return; }
      const cv = body.querySelector("#mcv"), W = cv.clientWidth || 800, H = cv.clientHeight || 400;
      const lo = Math.min(...all.map(p => p.lon)), hi = Math.max(...all.map(p => p.lon)), la = Math.min(...all.map(p => p.lat)), lb = Math.max(...all.map(p => p.lat));
      const spanLon = Math.max(hi - lo, 4), spanLat = Math.max(lb - la, 3);
      M.view = { lon: (lo + hi) / 2, lat: (la + lb) / 2, k: Math.min(W / (spanLon * 1.3), H / (spanLat * 1.3), 400) }; M.fitted = true;
    }
    function paintMap() {
      cancelAnimationFrame(M.raf);
      M.raf = requestAnimationFrame(() => {
        const cv = body.querySelector("#mcv"); if (!cv || !M.view) return;
        const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const v = M.view, X = lon => (lon - v.lon) * v.k + W / 2, Y = lat => (v.lat - lat) * v.k + H / 2;
        g.fillStyle = "#0b1118"; g.fillRect(0, 0, W, H);
        g.strokeStyle = "#1c2733"; g.lineWidth = 1; g.fillStyle = "#4b5a6b"; g.font = "10px monospace";
        const step = v.k > 60 ? 1 : v.k > 20 ? 5 : v.k > 6 ? 10 : 30;
        for (let lon = -180; lon <= 180; lon += step) { const x = X(lon); if (x < 0 || x > W) continue; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(lon + "°", x + 2, H - 3); }
        for (let lat = -90; lat <= 90; lat += step) { const y = Y(lat); if (y < 0 || y > H) continue; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(lat + "°", 3, y - 2); }
        if (lib.worldLand) {
          g.fillStyle = "#16212d"; g.strokeStyle = "#2c3d50";
          for (const ring of lib.worldLand) { g.beginPath(); for (let i = 0; i < ring.length; i += 2) { const x = X(ring[i] / 10), y = Y(ring[i + 1] / 10); if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.closePath(); g.fill(); g.stroke(); }
        }
        M.hit = [];
        M.tracks.forEach((t, ti) => {
          const col = COLORS[ti % 8], cut = M.cur === Infinity ? Infinity : M.cur;
          let n = 0; while (n < t.points.length && t.points[n].t <= cut) n++;
          if (!n) return;
          const from = Math.max(0, n - M.trail), sel = M.sel === t.id;
          g.strokeStyle = col; g.globalAlpha = M.sel && !sel ? 0.25 : 0.9; g.lineWidth = sel ? 2.5 : 1.5; g.beginPath();
          for (let i = from; i < n; i++) { const p = t.points[i], x = X(p.lon), y = Y(p.lat); if (i === from) g.moveTo(x, y); else g.lineTo(x, y); if (i % Math.ceil((n - from) / 60 + 1) === 0 || i === n - 1) M.hit.push({ x, y, p, tr: t }); }
          g.stroke();
          const last = t.points[n - 1], x = X(last.lon), y = Y(last.lat);
          g.fillStyle = col; g.strokeStyle = "#0b1118"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); g.stroke(); g.globalAlpha = 1;
        });
      });
    }

    /* ---------------- plumbing ---------------- */
    function draw(force) {
      if (destroyed) return;
      const model = opts.getModel && opts.getModel();
      stat.textContent = `${store.records.length.toLocaleString()} messages${store.pending ? " · decoding " + store.pending.toLocaleString() + " left" : ""}${model ? "" : " · no schema loaded (names, states and positions are read from the XML itself)"}`;
      const x = extra.find(e => e.key === tab);
      if (x) { if (mounted !== tab) { body.innerHTML = ""; x.render(body); mounted = tab; } return; }
      if (!force && store.version === lastVer && tab !== "bus") return;
      if (!force && Date.now() - lastDraw < 900 && tab !== "map") return;
      lastVer = store.version; lastDraw = Date.now();
      if (tab !== "tx" && tab !== "map") mounted = "";
      if (tab === "bus") drawBus(); else if (tab === "tx") drawTx(); else if (tab === "an") drawAnalysis(); else if (tab === "map") drawMap();
    }
    const timer = setInterval(() => {
      if (destroyed || !host.isConnected) { destroy(); return; }
      if (store.pending) store.process(12);
      draw(false);
    }, 400);
    function destroy() { destroyed = true; clearInterval(timer); if (M.playing) clearInterval(M.playing); cancelAnimationFrame(M.raf); }
    draw(true);
    return { destroy, refresh: () => draw(true), select: u => { selectedTx = u; tab = "tx"; host.querySelectorAll(".tabs.lab .tab").forEach(x => x.classList.toggle("on", x.dataset.t === "tx")); mounted = ""; draw(true); } };
  };
})();
