/* JetStream, KV, object store and $SYS helpers for the NATS Explorer. Everything takes an `api(subject, body)` function (the JetStream
   API: JSON in, JSON out) or a connected lib.NatsClient, so it can be tested with fakes and run against a real server. */
(function () {
  const lib = DT.lib, TE = new TextEncoder(), TD = new TextDecoder();
  const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const bytesToB64 = b => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const b64u = s => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fromB64u = s => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const NO_MSG = 10037;

  /* ---------- many replies to one request ($SYS and service discovery) ---------- */
  /* Publishes with a private reply subject and gathers every reply that arrives within timeout ms (or until max). */
  lib.natsRequestMany = function (client, subject, payload = new Uint8Array(0), { timeout = 1500, max = 1000, headers } = {}) {
    return new Promise((resolve, reject) => {
      const inbox = "_INBOX." + Array.from(crypto.getRandomValues(new Uint8Array(10)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""), out = [];
      let sub, timer;
      const finish = () => { clearTimeout(timer); try { sub.unsubscribe(); } catch (_) { /* closed */ } resolve(out); };
      try {
        sub = client.subscribe(inbox, m => { out.push(m); if (out.length >= max) finish(); });
        client.publish(subject, payload, { reply: inbox, headers });
        timer = setTimeout(finish, timeout);
      } catch (e) { clearTimeout(timer); reject(e); }
    });
  };
  /* $SYS replies look like { server: { name, id, ... }, data: {...}, error? } */
  lib.sysDecode = m => { try { return JSON.parse(TD.decode(m.payload)); } catch (_) { return null; } };

  /* ---------- stream and consumer configuration from form values ---------- */
  const list = s => String(s || "").split(/[\s,]+/).filter(Boolean);
  const seconds = (v, what) => { if (v === "" || v === undefined || v === null) return 0; const n = Number(v); if (!(n >= 0)) throw new Error(`${what} must be a number of seconds, or empty for no limit.`); return Math.round(n * 1e9); };
  const limit = (v, what) => { if (v === "" || v === undefined || v === null) return -1; const n = Number(v); if (!(n >= 0) || !Number.isInteger(n)) throw new Error(`${what} must be a whole number, or empty for no limit.`); return n; };
  lib.jsStreamConfig = function (f) {
    const name = String(f.name || "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("A stream name uses letters, digits, - and _ only.");
    const subjects = list(f.subjects);
    if (!subjects.length) throw new Error("A stream needs at least one subject to capture, for example orders.>");
    for (const s of subjects) { const p = lib.natsSubjectProblem(s, true); if (p) throw new Error(`Subject "${s}": ${p}`); }
    const replicas = Number(f.replicas || 1);
    if (![1, 3, 5].includes(replicas)) throw new Error("Replicas must be 1, 3 or 5.");
    return { name, subjects, storage: f.storage === "memory" ? "memory" : "file", retention: ["limits", "interest", "workqueue"].includes(f.retention) ? f.retention : "limits",
      discard: f.discard === "new" ? "new" : "old", num_replicas: replicas, max_msgs: limit(f.maxMsgs, "Max messages"), max_bytes: limit(f.maxBytes, "Max bytes"),
      max_age: seconds(f.maxAge, "Max age"), max_msgs_per_subject: limit(f.maxPerSubject, "Max per subject"), allow_direct: false };
  };
  lib.jsConsumerConfig = function (f) {
    const name = String(f.name || "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("A consumer name uses letters, digits, - and _ only.");
    const filter = String(f.filter || "").trim();
    if (filter) { const p = lib.natsSubjectProblem(filter, true); if (p) throw new Error(`Filter subject: ${p}`); }
    const maxDeliver = f.maxDeliver === "" || f.maxDeliver === undefined ? -1 : Number(f.maxDeliver);
    if (!Number.isInteger(maxDeliver) || maxDeliver === 0 || maxDeliver < -1) throw new Error("Max deliveries must be a positive whole number, or empty for unlimited.");
    const cfg = { durable_name: name, ack_policy: ["explicit", "none", "all"].includes(f.ack) ? f.ack : "explicit", deliver_policy: ["all", "last", "new", "last_per_subject"].includes(f.deliver) ? f.deliver : "all",
      replay_policy: f.replay === "original" ? "original" : "instant", max_deliver: maxDeliver };
    if (filter) cfg.filter_subject = filter;
    if (f.ackWait !== "" && f.ackWait !== undefined) cfg.ack_wait = seconds(f.ackWait, "Ack wait");
    return cfg;
  };

  /* ---------- JetStream write operations (the caller decides when they are allowed) ---------- */
  lib.jsOps = {
    streamCreate: (api, cfg) => api("STREAM.CREATE." + cfg.name, cfg),
    streamUpdate: (api, cfg) => api("STREAM.UPDATE." + cfg.name, cfg),
    streamDelete: (api, name) => api("STREAM.DELETE." + name),
    /* body: {} purges everything; { filter } one subject; { seq } everything below that sequence; { keep } keep the newest N */
    streamPurge: (api, name, body = {}) => api("STREAM.PURGE." + name, body),
    msgDelete: (api, name, seq) => api("STREAM.MSG.DELETE." + name, { seq, no_erase: true }),
    consumerCreate: (api, stream, cfg) => api(`CONSUMER.DURABLE.CREATE.${stream}.${cfg.durable_name}`, { stream_name: stream, config: cfg, action: "create" }),
    consumerDelete: (api, stream, name) => api(`CONSUMER.DELETE.${stream}.${name}`),
    /* Publish stored messages [from..to] back onto `target` (a subject), optionally spaced by delayMs. -> { sent, missing } */
    async republish(api, client, stream, from, to, target, { delayMs = 0, onProgress, isStopped, max = 5000 } = {}) {
      const bad = lib.natsSubjectProblem(target, false); if (bad) throw new Error("Target subject: " + bad);
      let sent = 0, missing = 0;
      for (let seq = from; seq <= to && sent + missing < max; seq++) {
        if (isStopped && isStopped()) break;
        try {
          const r = await api("STREAM.MSG.GET." + stream, { seq }), m = lib.natsStreamMsg(r.message);
          client.publish(target, m.payload, { headers: m.headers.filter(h => !/^Nats-/.test(h[0])) }); sent++;
        } catch (e) { if (e.errCode === NO_MSG) missing++; else throw e; }
        if (onProgress) onProgress({ seq, sent, missing, of: to - from + 1 });
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      }
      return { sent, missing };
    },
  };

  /* ---------- consumer lag over time ---------- */
  lib.LagSeries = class {
    constructor(keep = 120) { this.keep = keep; this.by = new Map(); }
    /* consumers: the CONSUMER.LIST entries of one stream */
    sample(stream, consumers, now = Date.now()) {
      for (const c of consumers) {
        const key = stream + "/" + c.name; let a = this.by.get(key); if (!a) this.by.set(key, a = { stream, name: c.name, points: [] });
        a.points.push({ t: now, pending: c.num_pending || 0, ackPending: c.num_ack_pending || 0, redelivered: c.num_redelivered || 0, delivered: c.delivered ? c.delivered.stream_seq : 0, waiting: c.num_waiting || 0 });
        if (a.points.length > this.keep) a.points.splice(0, a.points.length - this.keep);
      }
    }
    /* "ok" | "growing" (pending rose in each of the last 4 samples) | "stalled" (work waiting, nothing delivered or acked for 3 samples) | "redelivering" */
    health(key) {
      const a = this.by.get(key); if (!a || a.points.length < 2) return "ok";
      const p = a.points, last = p[p.length - 1], tail = p.slice(-3);
      if (p.length >= 3 && last.pending + last.ackPending > 0 && tail.every(x => x.delivered === last.delivered && x.pending === last.pending && x.ackPending === last.ackPending)) return "stalled";
      if (p.length >= 2 && last.redelivered > p[p.length - 2].redelivered) return "redelivering";
      const t4 = p.slice(-5); if (t4.length === 5 && t4.every((x, i) => !i || x.pending > t4[i - 1].pending)) return "growing";
      return "ok";
    }
    rows() { return [...this.by.entries()].map(([key, a]) => ({ key, stream: a.stream, name: a.name, last: a.points[a.points.length - 1], health: this.health(key), points: a.points })); }
    clear() { this.by.clear(); }
  };

  /* ---------- KV ---------- */
  const kvSubject = (bucket, key) => `$KV.${bucket}.${key}`;
  const ack = (client, subject, payload, headers) => client.request(subject, payload, { headers, timeout: 3000 }).then(r => {
    let j; try { j = JSON.parse(TD.decode(r.payload)); } catch (_) { throw new Error("The server's acknowledgement was not JSON."); }
    if (j.error) { const e = new Error(`${j.error.description || "error"} (code ${j.error.code}, err_code ${j.error.err_code})`); e.errCode = j.error.err_code; throw e; }
    return j;
  });
  lib.kv = {
    subject: kvSubject,
    validKey: key => /^[-/_=.A-Za-z0-9]+$/.test(key) && !key.startsWith(".") && !key.endsWith("."),
    async entry(api, bucket, key) {
      const r = await api("STREAM.MSG.GET.KV_" + bucket, { last_by_subj: kvSubject(bucket, key) }), m = lib.natsStreamMsg(r.message);
      const op = (m.headers.find(h => h[0] === "KV-Operation") || [, "PUT"])[1];
      return { key, revision: m.seq, op, value: m.payload, time: m.time };
    },
    /* expected: the revision the key must still be at (compare-and-set), 0 means "must not exist", undefined means no check */
    async put(client, bucket, key, value, { expected } = {}) {
      if (!lib.kv.validKey(key)) throw new Error("A key uses letters, digits and - _ = . / only.");
      const headers = expected === undefined ? [] : [["Nats-Expected-Last-Subject-Sequence", String(expected)]];
      const j = await ack(client, kvSubject(bucket, key), typeof value === "string" ? TE.encode(value) : value, headers);
      return { revision: j.seq };
    },
    delete: (client, bucket, key) => ack(client, kvSubject(bucket, key), new Uint8Array(0), [["KV-Operation", "DEL"]]).then(j => ({ revision: j.seq })),
    purge: (client, bucket, key) => ack(client, kvSubject(bucket, key), new Uint8Array(0), [["KV-Operation", "PURGE"], ["Nats-Rollup", "sub"]]).then(j => ({ revision: j.seq })),
    /* Every stored revision of a key, oldest first. */
    async history(api, bucket, key, { max = 200 } = {}) {
      const info = await api("STREAM.INFO.KV_" + bucket, {}), subject = kvSubject(bucket, key), out = [];
      let seq = info.state.first_seq || 1;
      while (out.length < max) {
        let r;
        try { r = await api("STREAM.MSG.GET.KV_" + bucket, { seq, next_by_subj: subject }); }
        catch (e) { if (e.errCode === NO_MSG) break; throw e; }
        const m = lib.natsStreamMsg(r.message);
        out.push({ revision: m.seq, op: (m.headers.find(h => h[0] === "KV-Operation") || [, "PUT"])[1], value: m.payload, time: m.time });
        seq = m.seq + 1;
      }
      return out;
    },
    /* Live changes: cb({ key, op, value }). Returns the subscription. */
    watch(client, bucket, cb, prefix = ">") {
      const base = `$KV.${bucket}.`;
      return client.subscribe(base + prefix, m => cb({ key: m.subject.slice(base.length), op: (m.headers.find(h => h[0] === "KV-Operation") || [, "PUT"])[1], value: m.payload, time: Date.now() }));
    },
  };

  /* ---------- object store (read only) ---------- */
  lib.obj = {
    metaSubject: (bucket, name) => `$O.${bucket}.M.${bytesToB64(TE.encode(name)).replace(/\+/g, "-").replace(/\//g, "_")}`,     // URL-safe Base64 of the UTF-8 name, padded like the Go client
    nameFromSubject(bucket, subject) { try { return TD.decode(Uint8Array.from(fromB64u(subject.slice(`$O.${bucket}.M.`.length)), c => c.charCodeAt(0))); } catch (_) { return subject; } },
    async list(api, bucket) {
      const info = await api("STREAM.INFO.OBJ_" + bucket, { subjects_filter: `$O.${bucket}.M.>` }), subs = Object.keys(info.state.subjects || {}), out = [];
      for (const s of subs) {
        try {
          const r = await api("STREAM.MSG.GET.OBJ_" + bucket, { last_by_subj: s }), meta = JSON.parse(TD.decode(lib.natsStreamMsg(r.message).payload));
          if (!meta.deleted) out.push({ name: meta.name, size: meta.size || 0, chunks: meta.chunks || 0, digest: meta.digest || "", nuid: meta.nuid, mtime: meta.mtime || "", description: meta.description || "", subject: s });
        } catch (e) { if (e.errCode !== NO_MSG) throw e; }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    /* The object's bytes, checked against its size and SHA-256 digest. */
    async get(api, bucket, meta) {
      const parts = [], subject = `$O.${bucket}.C.${meta.nuid}`;
      let seq = 1, total = 0;
      while (parts.length < Math.max(meta.chunks, 1) && total < meta.size) {
        const r = await api("STREAM.MSG.GET.OBJ_" + bucket, { seq, next_by_subj: subject }), m = lib.natsStreamMsg(r.message);
        parts.push(m.payload); total += m.payload.length; seq = m.seq + 1;
      }
      const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      let digestOk = null;
      if (/^SHA-256=/i.test(meta.digest) && crypto.subtle) {
        const h = new Uint8Array(await crypto.subtle.digest("SHA-256", out)), want = fromB64u(meta.digest.slice(8));
        digestOk = h.length === want.length && h.every((b, i) => b === want.charCodeAt(i));
      }
      return { bytes: out, sizeOk: out.length === meta.size, digestOk };
    },
  };

  /* ---------- subject usage from $SYS connection data ---------- */
  /* connz: the data of a CONNZ reply with subscriptions_detail. observed: Map subject -> count of messages seen.
     -> { rows: [{ subject, subscribers, clients, queues, observed }], orphans: [subjects with traffic and no other subscriber],
          idle: [subscription patterns that matched no observed subject] }. selfCid is this explorer's own connection, left out. */
  lib.subjectUsage = function (connz, observed, selfCid) {
    const subs = new Map();
    for (const c of (connz && connz.connections) || []) {
      if (selfCid !== undefined && c.cid === selfCid) continue;
      for (const s of c.subscriptions_list_detail || []) {
        let e = subs.get(s.subject); if (!e) subs.set(s.subject, e = { subject: s.subject, subscribers: 0, clients: new Set(), queues: new Set() });
        e.subscribers++; e.clients.add(c.name || c.cid); if (s.qgroup) e.queues.add(s.qgroup);
      }
    }
    const rows = [...subs.values()].map(e => {
      let n = 0; for (const [subj, c] of observed) if (lib.natsSubjectMatch(e.subject, subj)) n += c;
      return { subject: e.subject, subscribers: e.subscribers, clients: [...e.clients], queues: [...e.queues], observed: n };
    }).sort((a, b) => b.observed - a.observed || a.subject.localeCompare(b.subject));
    const orphans = [...observed.keys()].filter(subj => !rows.some(r => lib.natsSubjectMatch(r.subject, subj))).sort();
    return { rows, orphans, idle: rows.filter(r => !r.observed).map(r => r.subject) };
  };
})();
