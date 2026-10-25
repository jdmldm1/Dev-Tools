/* Traffic analysis for UCI messages (from NATS or an LA-CAL, live or from a saved capture). Pure functions on DT.lib, no DOM.
     capture records   { n, t (ms), topic, text, source }   one JSON line each in a .jsonl capture
     meta              what one message says about itself: name, header, identifiers, states, positions, validity
     TrafficStore      keeps records, decodes them in time slices, and answers the Bus, Transactions, Analysis and Map views
   Works with a schema loaded (names, enum states, validation) and, more roughly, without one. */
(function () {
  const lib = DT.lib;
  const local = n => n.replace(/^\{[^}]*\}/, "").replace(/^[^:]+:/, "");
  const UUID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
  const STATE_NAME = /(State|Status|Result|Phase|Disposition|Outcome)$/;
  const ENUMISH = /^[A-Z][A-Z0-9_]*$/;
  const num = s => { const t = String(s).trim(); return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? +t : NaN; };

  /* ---------- capture format ---------- */

  /* One parsed JSON line (ours, or what the NATS / CAL explorers save) -> record, or null. */
  lib.capNormalize = function (o) {
    if (!o || typeof o !== "object") return null;
    let text = o.payload ?? o.message ?? o.text;
    if (text === undefined && o.payload_base64) { try { text = new TextDecoder().decode(Uint8Array.from(atob(o.payload_base64), c => c.charCodeAt(0))); } catch (_) { return null; } }
    if (typeof text !== "string") return null;
    const t = typeof o.t === "number" ? o.t : Date.parse(o.time);
    return { t: Number.isFinite(t) ? t : 0, topic: String(o.topic ?? o.subject ?? ""), text, source: o.source || (o.subject !== undefined ? "nats" : o.topic !== undefined ? "cal" : "") };
  };
  lib.capParse = function (text) {
    const records = []; let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r = null; try { r = lib.capNormalize(JSON.parse(line)); } catch (_) { /* not JSON */ }
      if (r) records.push(r); else skipped++;
    }
    return { records, skipped };
  };
  lib.capStringify = records => records.map(r => JSON.stringify({ time: new Date(r.t).toISOString(), source: r.source || undefined, topic: r.topic, payload: r.text })).join("\n") + (records.length ? "\n" : "");

  /* Delays for playing records back: [{ at (ms after the start), rec }]. speed 0 means as fast as possible. */
  lib.capSchedule = function (records, { speed = 1, from = 0, to = Infinity, filter } = {}) {
    const list = records.filter(r => r.t >= from && r.t <= to && (!filter || filter(r))).sort((a, b) => a.t - b.t || a.n - b.n);
    const t0 = list.length ? list[0].t : 0;
    return list.map(rec => ({ at: speed > 0 ? (rec.t - t0) / speed : 0, rec }));
  };

  /* Play records back through send(rec) at their original timing divided by speed (0 = as fast as possible). send may throw or reject:
     that counts as a failure and playback goes on. isStopped() is polled between messages; sleep is injectable for tests.
     control (optional, changed while playing): { paused, speed, seekTo (index in the plan), seekT (jump to the first record at or after this time) }.
     faults (optional): see lib.capFaults. -> { sent, failed, rounds, stopped, lastError, faults } */
  lib.capPlay = async function (records, send, { speed = 1, loop = false, filter, from, to, onProgress, isStopped, control, faults, rng, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    let sent = 0, failed = 0, rounds = 0, lastError = "", fstats = null;
    const ctl = control || {}, now = () => performance.now();
    do {
      let plan = lib.capSchedule(records, { speed: 1, from, to, filter });             // times at 1x; the speed is applied while playing so it can change
      if (!plan.length) break;
      if (faults && lib.capFaults) { const f = lib.capFaults(plan, faults, rng); plan = f.plan; fstats = f.stats; }
      let cur = ctl.speed !== undefined ? ctl.speed : speed, start = now();
      const at = i => (cur > 0 ? plan[i].at / cur : 0);
      for (let i = 0; i < plan.length; i++) {
        if (isStopped && isStopped()) return { sent, failed, rounds, stopped: true, lastError, faults: fstats };
        if (ctl.paused) { const p0 = now(); while (ctl.paused && !(isStopped && isStopped())) await sleep(50); start += now() - p0; if (isStopped && isStopped()) return { sent, failed, rounds, stopped: true, lastError, faults: fstats }; }
        if (ctl.speed !== undefined && ctl.speed !== cur) { const virt = cur > 0 ? (now() - start) * cur : (i ? plan[i - 1].at : 0); cur = ctl.speed; start = now() - (cur > 0 ? virt / cur : 0); }
        if (ctl.seekT !== undefined && ctl.seekT !== null) { const j = plan.findIndex(p => p.rec.t >= ctl.seekT); ctl.seekT = null; if (j >= 0) { i = j; start = now() - at(i); } }
        if (ctl.seekTo !== undefined && ctl.seekTo !== null) { i = Math.max(0, Math.min(plan.length - 1, ctl.seekTo)); ctl.seekTo = null; start = now() - at(i); }
        const wait = at(i) - (now() - start);
        if (wait > 2) await sleep(ctl.paused !== undefined ? Math.min(wait, 100) : wait); else if (cur === 0 && i % 200 === 199) await sleep(0);
        if (wait > 100 && ctl.paused !== undefined) { i--; continue; }                // long waits are taken in slices so pause, seek and speed changes stay responsive
        try { await send(plan[i].rec); sent++; } catch (e) { failed++; lastError = e && e.message || String(e); }
        if (onProgress) onProgress({ sent, failed, i: i + 1, of: plan.length, rounds, lastError, rec: plan[i].rec });
      }
      rounds++;
    } while (loop && !(isStopped && isStopped()));
    return { sent, failed, rounds, stopped: false, lastError, faults: fstats };
  };
  /* Make the MessageHeader timestamp of a message (XML or OMS JSON text) the given time. */
  lib.capRestamp = function (text, when = new Date()) {
    const iso = when.toISOString().replace(/\.\d+Z$/, "Z");
    return text.replace(/(<(?:[\w.-]+:)?Timestamp>)[^<]*(<\/)/, "$1" + iso + "$2").replace(/("Timestamp"\s*:\s*")[^"]*(")/, "$1" + iso + "$2");
  };

  /* Re-express a record for the other protocol: UCI XML for NATS, OMS JSON for a CAL. */
  lib.capConvert = function (model, rec, target) {
    const t = rec.text.trimStart(), isJson = t.startsWith("{");
    if (target === "oms-json") return isJson ? rec.text : lib.owpXmlToJson(model, rec.text);
    if (target === "xml") return isJson ? lib.owpJsonToXml(model, rec.text).xml : rec.text;
    return rec.text;
  };
  lib.capTopic = subject => subject.replace(/[^A-Za-z0-9_\-.]/g, "_");

  /* ---------- one message ---------- */

  function walkXml(root) {
    const meta = { header: {}, ids: [], states: [], positions: [] };
    const hdr = root.kids.find(k => k.t === "el" && local(k.name) === "MessageHeader");
    const text = e => e.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join("").trim();
    const child = (e, n) => e.kids.find(k => k.t === "el" && local(k.name) === n);
    if (hdr) {
      const uuidOf = n => { const e = child(hdr, n); const u = e && (child(e, "UUID") || e); return u ? text(u) : ""; };
      meta.header = { systemId: uuidOf("SystemID"), serviceId: uuidOf("ServiceID"), timestamp: text(child(hdr, "Timestamp") || { kids: [] }), mode: text(child(hdr, "Mode") || { kids: [] }), schemaVersion: text(child(hdr, "SchemaVersion") || { kids: [] }) };
      meta.header.ts = Date.parse(meta.header.timestamp);
    }
    const idFound = [];
    (function walk(e, path, inData) {
      const kids = e.kids.filter(k => k.t === "el"), name = local(e.name);
      if (!kids.length) {
        const v = text(e);
        if (inData && UUID.test(v)) { meta.ids.push({ path, uuid: v.toLowerCase() }); idFound.push(v.toLowerCase()); }
        if (inData && v && ENUMISH.test(v) && v.length > 2 && (STATE_NAME.test(name) || (path.split("/").slice(-2, -1)[0] || "").match(STATE_NAME)) && meta.states.length < 8) meta.states.push({ path, value: v });
        return;
      }
      const lat = kids.find(k => local(k.name) === "Latitude"), lon = kids.find(k => local(k.name) === "Longitude");
      if (inData && lat && lon && !Number.isNaN(num(text(lat))) && !Number.isNaN(num(text(lon))) && (num(text(lat)) !== 0 || num(text(lon)) !== 0)) {     // exactly 0,0 means "no fix", not a place
        const alt = kids.find(k => /^(Altitude|Elevation|Height)$/.test(local(k.name)));
        meta.positions.push({ lat: num(text(lat)), lon: num(text(lon)), alt: alt ? num(text(alt)) : NaN, at: path });
      }
      for (const k of kids) {
        if (e === root && ["MessageHeader", "SecurityInformation"].includes(local(k.name))) continue;
        walk(k, path + "/" + local(k.name), inData || e === root);
      }
    })(root, "", false);
    // the entity a position belongs to: the first identifier in the message body
    const id = (meta.ids.find(x => /(Entity|Track|Platform|Asset|Object)\w*ID\/UUID$/.test(x.path)) || meta.ids[0] || {}).uuid || meta.header.systemId || "";
    for (const p of meta.positions) p.id = id;
    return meta;
  }

  /* Find lat/lon pairs in a plain JSON payload (degrees): { lat, lon } or { latitude, longitude }, anywhere inside. */
  function walkJson(text) {
    const out = [];
    let v; try { v = JSON.parse(text); } catch (_) { return out; }
    (function go(x, path, id) {
      if (Array.isArray(x)) x.slice(0, 50).forEach((y, i) => go(y, path + "[" + i + "]", id));
      else if (x && typeof x === "object") {
        const get = (...ks) => { for (const k of Object.keys(x)) if (ks.includes(k.toLowerCase()) && typeof x[k] === "number") return x[k]; return NaN; };
        const lat = get("lat", "latitude"), lon = get("lon", "lng", "long", "longitude");
        const ident = typeof x.id === "string" ? x.id : typeof x.name === "string" ? x.name : id;
        if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({ lat, lon, alt: get("alt", "altitude"), at: path, id: ident || "", degrees: true });
        for (const k of Object.keys(x)) go(x[k], path + "/" + k, ident);
      }
    })(v, "", "");
    return out;
  }

  /* Decode one record. model may be null. opts.validate runs the schema validator (slower). Never throws. */
  lib.trMeta = function (model, rec, { validate = false } = {}) {
    const text = rec.text, t = text.trimStart();
    const meta = { name: "", format: "other", ns: "", header: {}, ids: [], states: [], positions: [], known: false, valid: undefined, errors: [] };
    try {
      let xml = null;
      if (t.startsWith("<")) { meta.format = "xml"; xml = text; }
      else if (t.startsWith("{")) {
        meta.format = "json";
        const m = /^\s*\{\s*"([^"]+)"/.exec(text); if (m) meta.name = local(m[1]);
        if (model && m && model.elements.has(meta.name)) { try { xml = lib.owpJsonToXml(model, text).xml; } catch (e) { meta.errors.push({ message: e.message, path: "" }); meta.valid = false; } }
        else if (!model || !m) { meta.positions = walkJson(text); }
        else meta.positions = walkJson(text);
      }
      if (xml) {
        const tree = lib.xmlParse(xml), root = tree.root;
        meta.name = local(root.name);
        meta.ns = (root.attrs.find(a => a[0] === "xmlns") || [])[1] || "";
        Object.assign(meta, walkXml(root));
        meta.known = !!model && model.elements.has(meta.name);
        if (model && validate && meta.known) {
          const v = lib.xsdValidate(model, xml);
          meta.valid = v.ok; meta.errors = v.errors.slice(0, 5).map(e => ({ message: e.message, path: e.path || "" }));
          const f = model.files.find(x => x.name === (model.elements.get(meta.name) || {}).file);
          meta.nsMatch = !f || f.targetNamespace === meta.ns;
        } else if (model && meta.format === "xml" && !meta.known) meta.valid = undefined;
      } else if (meta.format === "json") meta.known = !!model && model.elements.has(meta.name);
    } catch (e) { meta.format = "broken"; meta.errors.push({ message: e.message, path: "" }); meta.valid = false; }
    return meta;
  };

  /* ---------- the store ---------- */

  const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN;

  lib.TrafficStore = class {
    constructor(model, { max = 50000, validate = true } = {}) {
      this.model = model; this.max = max; this.validate = validate;
      this.clear();
    }
    clear() {
      this.records = []; this.cursor = 0; this.seq = 0; this.dropped = 0; this.version = 0;
      this.systems = new Map(); this.names = new Map(); this.uuids = new Map(); this.positions = [];
    }
    /* A new schema (or validation switch) means everything is decoded again. */
    reset(model, validate) {
      this.model = model; if (validate !== undefined) this.validate = validate;
      const keep = this.records; this.clear(); for (const r of keep) { delete r.meta; this.records.push(r); r.n = ++this.seq; }
    }
    add(rec) {
      rec.n = ++this.seq; this.records.push(rec);
      if (this.records.length > this.max * 1.1) {                                 // drop the oldest in a block (and what they contributed is left in the aggregates)
        const drop = this.records.length - this.max; this.records.splice(0, drop); this.cursor = Math.max(0, this.cursor - drop); this.dropped += drop;
      }
    }
    addMany(list) { for (const r of list) this.add(r); }
    get pending() { return this.records.length - this.cursor; }

    /* Decode pending records for about `budget` ms. -> records still waiting. */
    process(budget = 15) {
      const end = performance.now() + budget;
      while (this.cursor < this.records.length && performance.now() < end) {
        const rec = this.records[this.cursor++];
        if (!rec.meta) rec.meta = lib.trMeta(this.model, rec, { validate: this.validate });
        this._aggregate(rec); this.version++;
      }
      return this.pending;
    }
    _aggregate(rec) {
      const m = rec.meta, sys = m.header.systemId || "(no MessageHeader)";
      let s = this.systems.get(sys); if (!s) this.systems.set(sys, s = { id: sys, first: rec.t, last: rec.t, count: 0, services: new Set(), messages: new Map(), times: [] });
      s.count++; s.last = Math.max(s.last, rec.t); s.first = Math.min(s.first, rec.t); if (m.header.serviceId) s.services.add(m.header.serviceId);
      s.messages.set(m.name || "(unknown)", (s.messages.get(m.name || "(unknown)") || 0) + 1);
      if (s.times.length < 5000) s.times.push(rec.t); else { s.times.shift(); s.times.push(rec.t); }
      const key = m.name || "(not XML or OMS JSON)";
      let n = this.names.get(key); if (!n) this.names.set(key, n = { name: key, count: 0, bytes: 0, valid: 0, invalid: 0, unchecked: 0, unknown: 0, errors: new Map(), first: rec.t, last: rec.t, topics: new Set() });
      n.count++; n.bytes += rec.text.length; n.last = Math.max(n.last, rec.t); n.first = Math.min(n.first, rec.t); n.topics.add(rec.topic);
      if (m.valid === true) n.valid++; else if (m.valid === false) n.invalid++; else n.unchecked++;
      if (this.model && m.format !== "other" && !m.known) n.unknown++;
      for (const e of m.errors) { const k = e.message.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "#").slice(0, 160); n.errors.set(k, (n.errors.get(k) || 0) + 1); }
      for (const id of m.ids) { let a = this.uuids.get(id.uuid); if (!a) this.uuids.set(id.uuid, a = []); a.push({ rec, path: id.path }); }
      for (const p of m.positions) this.positions.push({ n: rec.n, t: rec.t, id: p.id || rec.topic, name: m.name, topic: rec.topic, sys: m.header.systemId, lat: p.lat, lon: p.lon, alt: p.alt, degrees: !!p.degrees });
    }

    /* ----- Bus: who is talking ----- */
    bus(now = Date.now()) {
      return [...this.systems.values()].map(s => {
        const recent = s.times.filter(t => t > now - 60000).length;
        return { id: s.id, count: s.count, first: s.first, last: s.last, services: [...s.services], types: s.messages.size, messages: [...s.messages].sort((a, b) => b[1] - a[1]), ratePerMin: recent, ageMs: now - s.last };
      }).sort((a, b) => b.count - a.count);
    }

    /* ----- Transactions: messages that share an identifier ----- */
    /* Identifiers that appear in at least `min` messages. role = the paths the identifier shows up under. */
    transactions({ min = 2 } = {}) {
      const out = [], total = Math.max(1, this.cursor);
      for (const [uuid, refs] of this.uuids) {
        const recs = [...new Set(refs.map(r => r.rec))];
        if (recs.length < min) continue;
        recs.sort((a, b) => a.t - b.t || a.n - b.n);
        const roles = [...new Set(refs.map(r => r.path.replace(/^\/(MessageData\/)?/, "")))];
        out.push({ uuid, count: recs.length, first: recs[0].t, last: recs[recs.length - 1].t, span: recs[recs.length - 1].t - recs[0].t, names: [...new Set(recs.map(r => r.meta.name))], roles, popular: recs.length / total > 0.25 });
      }
      return out.sort((a, b) => b.last - a.last);
    }
    /* The timeline of one identifier: every message that mentions it, with the states it reported. */
    timeline(uuid) {
      const refs = this.uuids.get(uuid) || [], by = new Map();
      for (const r of refs) { let a = by.get(r.rec); if (!a) by.set(r.rec, a = []); a.push(r.path); }
      const rows = [...by].map(([rec, paths]) => ({ rec, name: rec.meta.name, topic: rec.topic, t: rec.t, sys: rec.meta.header.systemId, paths: paths.map(p => p.replace(/^\/(MessageData\/)?/, "")), states: rec.meta.states, valid: rec.meta.valid }))
        .sort((a, b) => a.t - b.t || a.rec.n - b.rec.n);
      rows.forEach((r, i) => { r.delta = i ? r.t - rows[i - 1].t : 0; });
      return rows;
    }

    /* ----- Analysis ----- */
    analysis() {
      const metas = this.records.slice(0, this.cursor);
      const lat = [], gaps = [], series = new Map();
      let outOfOrder = 0, dup = 0; const seen = new Set();
      for (const r of metas) {
        const m = r.meta, ts = m.header.ts;
        if (Number.isFinite(ts) && r.t) lat.push(r.t - ts);
        const sk = (m.header.systemId || "") + "|" + (m.name || "");
        let s = series.get(sk); if (!s) series.set(sk, s = { system: m.header.systemId || "", name: m.name, times: [], ts: [] });
        s.times.push(r.t); if (Number.isFinite(ts)) s.ts.push(ts);
        const h = r.topic + "\u0000" + r.text; if (seen.has(h)) dup++; else if (seen.size < 100000) seen.add(h);
      }
      for (const s of series.values()) {
        const t = s.times.slice().sort((a, b) => a - b), d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
        const sorted = d.slice().sort((a, b) => a - b), med = pct(sorted, 0.5);
        if (d.length >= 5 && med > 0) { for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > Math.max(med * 5, 1000)) gaps.push({ system: s.system, name: s.name, at: t[i - 1], gapMs: t[i] - t[i - 1], medianMs: med }); }
        for (let i = 1; i < s.ts.length; i++) if (s.ts[i] < s.ts[i - 1]) outOfOrder++;
      }
      lat.sort((a, b) => a - b);
      const messages = [...this.names.values()].map(n => ({ ...n, topics: [...n.topics], errors: [...n.errors].sort((a, b) => b[1] - a[1]) })).sort((a, b) => b.count - a.count);
      const mismatch = metas.filter(r => r.meta.nsMatch === false).length, versions = new Map();
      for (const r of metas) if (r.meta.header.schemaVersion) versions.set(r.meta.header.schemaVersion, (versions.get(r.meta.header.schemaVersion) || 0) + 1);
      const span = metas.length ? Math.max(...metas.map(r => r.t)) - Math.min(...metas.map(r => r.t)) : 0;
      return {
        total: metas.length, spanMs: span, messages, systems: this.systems.size, invalid: messages.reduce((s, n) => s + n.invalid, 0), valid: messages.reduce((s, n) => s + n.valid, 0),
        unknown: messages.reduce((s, n) => s + n.unknown, 0), duplicates: dup, outOfOrder, nsMismatch: mismatch, versions: [...versions].sort((a, b) => b[1] - a[1]),
        latency: lat.length ? { count: lat.length, min: lat[0], p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: lat[lat.length - 1] } : null,
        gaps: gaps.sort((a, b) => b.gapMs / b.medianMs - a.gapMs / a.medianMs).slice(0, 50),
      };
    }

    /* ----- Map: positions per entity (radians in UCI, degrees when the payload says so or `unit` forces it) ----- */
    tracks(unit = "auto") {
      const by = new Map();
      for (const p of this.positions) {
        const deg = unit === "degrees" || (unit === "auto" && (p.degrees || Math.abs(p.lat) > Math.PI / 2 + 1e-6 || Math.abs(p.lon) > Math.PI + 1e-6));
        const lat = deg ? p.lat : p.lat * 180 / Math.PI, lon = deg ? p.lon : p.lon * 180 / Math.PI;
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;
        let t = by.get(p.id); if (!t) by.set(p.id, t = { id: p.id, name: p.name, sys: p.sys, points: [] });
        t.points.push({ t: p.t, lat, lon, alt: p.alt, n: p.n });
      }
      for (const t of by.values()) t.points.sort((a, b) => a.t - b.t);
      return [...by.values()].sort((a, b) => b.points.length - a.points.length);
    }
  };
})();
