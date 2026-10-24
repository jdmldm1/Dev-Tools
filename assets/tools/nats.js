(function () {
  const lib = DT.lib;
  const TE = new TextEncoder(), TD = new TextDecoder();
  const EMPTY = new Uint8Array(0), CRLF = TE.encode("\r\n"), STRICT = new TextDecoder("utf-8", { fatal: true });
  const cat = parts => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
  const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const bytesToB64 = b => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const rand = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

  /* ---------- wire format ---------- */

  /* Header block: "NATS/1.0[ status[ description]]\r\nKey: value\r\n...\r\n\r\n". */
  lib.natsEncodeHeaders = pairs => TE.encode("NATS/1.0\r\n" + pairs.map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
  lib.natsParseHeaders = bytes => {
    const lines = TD.decode(bytes).split("\r\n");
    const m = /^NATS\/1\.0(?:[ \t]+(\d{3}))?(?:[ \t]+(.*))?$/.exec(lines[0]);
    if (!m) throw new Error("protocol error: bad header block");
    const headers = [];
    for (const l of lines.slice(1)) {
      const i = l.indexOf(":");
      if (i > 0) headers.push([l.slice(0, i), l.slice(i + 1).trim()]);
    }
    return { status: m[1] ? +m[1] : 0, description: (m[2] || "").trim(), headers };
  };

  /* PUB / HPUB frame as bytes. */
  lib.natsPub = (subject, reply, headers, payload) => {
    const h = headers && headers.length ? lib.natsEncodeHeaders(headers) : null;
    const line = `${h ? "HPUB" : "PUB"} ${subject}${reply ? " " + reply : ""}${h ? " " + h.length : ""} ${(h ? h.length : 0) + payload.length}\r\n`;
    return cat([TE.encode(line), h || EMPTY, payload, CRLF]);
  };

  /* Incremental parser for the server-to-client stream. push() takes any chunking of the bytes; emit() gets
     { op: "INFO", info } | { op: "MSG"|"HMSG", subject, sid, reply, headers, status, description, payload } |
     { op: "PING"|"PONG"|"+OK" } | { op: "-ERR", message }. Throws on a protocol violation. */
  lib.natsParser = function (emit) {
    let buf = EMPTY;
    const crlf = b => { for (let i = 0; i + 1 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10) return i; return -1; };
    return {
      push(chunk) {
        buf = buf.length ? cat([buf, chunk]) : chunk;
        for (;;) {
          const i = crlf(buf);
          if (i < 0) { if (buf.length > 65536) throw new Error("protocol error: control line too long"); return; }
          const line = TD.decode(buf.subarray(0, i)), sp = line.indexOf(" ");
          const op = (sp < 0 ? line : line.slice(0, sp)).toUpperCase(), rest = sp < 0 ? "" : line.slice(sp + 1).trim();
          if (op === "MSG" || op === "HMSG") {
            const a = rest.split(/\s+/), hasHdr = op === "HMSG", need = hasHdr ? 4 : 3;
            if (a.length < need || a.length > need + 1) throw new Error(`protocol error: bad ${op} line`);
            const hlen = hasHdr ? +a[a.length - 2] : 0, total = +a[a.length - 1];
            if (!(hlen >= 0) || !(total >= hlen)) throw new Error(`protocol error: bad ${op} sizes`);
            const end = i + 2 + total;
            if (buf.length < end + 2) return;                         // payload not complete yet
            if (buf[end] !== 13 || buf[end + 1] !== 10) throw new Error(`protocol error: ${op} not terminated`);
            const body = buf.slice(i + 2, end);
            buf = buf.subarray(end + 2);
            const m = { op, subject: a[0], sid: a[1], reply: a.length === need + 1 ? a[2] : "", headers: [], status: 0, description: "", payload: body.subarray(hlen) };
            if (hlen) Object.assign(m, lib.natsParseHeaders(body.subarray(0, hlen)));
            emit(m);
            continue;
          }
          buf = buf.subarray(i + 2);
          if (op === "INFO") emit({ op, info: JSON.parse(rest) });
          else if (op === "-ERR") emit({ op, message: rest.replace(/^'|'$/g, "") });
          else if (op === "PING" || op === "PONG" || op === "+OK") emit({ op });
          else throw new Error("protocol error: unknown operation " + JSON.stringify(op.slice(0, 20)));
        }
      },
    };
  };

  /* ---------- subjects ---------- */

  /* Returns "" when valid, else the reason. Wildcards are only allowed when wild is true. */
  lib.natsSubjectProblem = (s, wild) => {
    if (!s) return "Subject is empty.";
    if (/\s/.test(s)) return "Subjects cannot contain spaces.";
    const t = s.split(".");
    for (let i = 0; i < t.length; i++) {
      if (!t[i]) return "Subjects cannot have empty tokens (check for a leading, trailing or doubled dot).";
      if (/[*>]/.test(t[i])) {
        if (!wild) return "Wildcards (* and >) are only valid when subscribing.";
        if (t[i] !== "*" && t[i] !== ">") return `"${t[i]}": wildcards must be a whole token.`;
        if (t[i] === ">" && i !== t.length - 1) return "> must be the last token.";
      }
    }
    return "";
  };
  lib.natsSubjectMatch = (pattern, subject) => {
    const p = pattern.split("."), s = subject.split(".");
    for (let i = 0; i < p.length; i++) {
      if (p[i] === ">") return s.length > i;
      if (i >= s.length || (p[i] !== "*" && p[i] !== s[i])) return false;
    }
    return p.length === s.length;
  };

  /* ---------- payloads ---------- */

  /* Bytes to show: { kind: "json"|"text"|"binary"|"empty", text }. JSON objects and arrays are pretty-printed. */
  lib.natsView = bytes => {
    if (!bytes.length) return { kind: "empty", text: "" };
    let text;
    try { text = STRICT.decode(bytes); } catch (_) { text = null; }
    if (text === null || /[\x00-\x08\x0e-\x1f]/.test(text)) return { kind: "binary", text: lib.hexdump ? lib.hexdump(bytes) : Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(" ") };
    if (/^\s*[{[]/.test(text)) { try { return { kind: "json", text: JSON.stringify(JSON.parse(text), null, 2) }; } catch (_) { /* plain text */ } }
    return { kind: "text", text };
  };
  /* Turn what the user typed into bytes. mode: "text" | "json" (validated) | "hex". */
  lib.natsPayloadBytes = (mode, text) => {
    if (mode === "hex") {
      const h = text.replace(/0x/gi, "").replace(/[\s,:-]/g, "");
      if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error("Hex payload must be an even number of hex digits.");
      return Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
    }
    if (mode === "json") { try { JSON.parse(text); } catch (e) { throw new Error("Payload is not valid JSON: " + e.message); } }
    return TE.encode(text);
  };
  /* "Key: value" lines to pairs. */
  lib.natsParseHeaderLines = text => text.split(/\r?\n/).filter(l => l.trim()).map(l => {
    const i = l.indexOf(":");
    if (i < 1) throw new Error(`Header line needs "Key: value": ${l.slice(0, 40)}`);
    const k = l.slice(0, i).trim(), v = l.slice(i + 1).trim();
    if (/[\s:]/.test(k)) throw new Error(`Invalid header name: ${k}`);
    return [k, v];
  });
  /* JetStream STREAM.MSG.GET reply -> the same shape as a delivered message. */
  lib.natsStreamMsg = m => ({
    subject: m.subject, seq: m.seq, time: m.time, reply: "",
    ...(m.hdrs ? lib.natsParseHeaders(b64ToBytes(m.hdrs)) : { headers: [], status: 0, description: "" }),
    payload: m.data ? b64ToBytes(m.data) : EMPTY,
  });
  lib.bytesLabel = n => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KiB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MiB" : (n / 1073741824).toFixed(2) + " GiB";

  /* ---------- client ---------- */

  /* Minimal NATS client over WebSocket (the server needs a `websocket {}` listener). No TLS or NKey/JWT auth;
     user/password and token auth work. opts.WebSocket lets tests inject a socket class. */
  lib.NatsClient = class {
    constructor(opts = {}) {
      this.WS = opts.WebSocket || globalThis.WebSocket;
      this.ws = null; this.info = null; this.connected = false;
      this.subs = new Map(); this.sid = 0; this.reqs = new Map();
      this.inbox = "_INBOX." + rand(12); this.mux = null;
      this.onclose = null; this.onerror = null;
    }
    connect(url, o = {}) {
      return new Promise((resolve, reject) => {
        let settled = false, sentConnect = false;
        const done = err => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (err) { this.close(); reject(err); } else resolve(this.info);
        };
        const timer = setTimeout(() => done(new Error("Timed out waiting for the server.")), o.timeout || 6000);
        let ws;
        try { ws = new this.WS(url); } catch (e) { return done(e); }
        this.ws = ws; ws.binaryType = "arraybuffer";
        const parser = lib.natsParser(op => {
          if (op.op === "INFO") {
            this.info = op.info;
            if (!sentConnect) {
              sentConnect = true;
              const c = { verbose: false, pedantic: false, lang: "js", version: "dev-tools", name: "dev-tools nats explorer", protocol: 1, headers: !!op.info.headers, no_responders: !!op.info.headers };
              if (o.user) { c.user = o.user; c.pass = o.pass || ""; }
              if (o.token) c.auth_token = o.token;
              this._send(TE.encode("CONNECT " + JSON.stringify(c) + "\r\nPING\r\n"));
            }
          } else if (op.op === "PING") this._send(TE.encode("PONG\r\n"));
          else if (op.op === "PONG") { if (!this.connected) { this.connected = true; done(); } }
          else if (op.op === "-ERR") { if (!this.connected) done(new Error(op.message)); else if (this.onerror) this.onerror(op.message); }
          else if (op.op === "MSG" || op.op === "HMSG") { const s = this.subs.get(op.sid); if (s) s.cb(op); }
        });
        ws.onmessage = e => {
          if (ws !== this.ws) return;
          try { parser.push(typeof e.data === "string" ? TE.encode(e.data) : new Uint8Array(e.data)); }
          catch (err) { if (!settled) done(err); else { this.close(); if (this.onclose) this.onclose(err.message); } }
        };
        ws.onerror = () => { if (ws === this.ws) done(new Error("Could not open a WebSocket to " + url)); };
        ws.onclose = e => {
          if (ws !== this.ws) return;
          if (!settled) return done(new Error("Connection closed before the handshake finished" + (e && e.reason ? ": " + e.reason : "") + "."));
          this.close();
          if (this.onclose) this.onclose((e && e.reason) || "connection closed");
        };
      });
    }
    _send(bytes) {
      if (!this.ws || this.ws.readyState !== 1) throw new Error("Not connected.");
      this.ws.send(bytes);
    }
    close() {
      const ws = this.ws; this.ws = null; this.connected = false; this.subs.clear(); this.mux = null;
      for (const r of this.reqs.values()) { clearTimeout(r.timer); r.reject(new Error("Connection closed.")); }
      this.reqs.clear();
      try { if (ws) ws.close(); } catch (_) { /* already closed */ }
    }
    publish(subject, payload = EMPTY, o = {}) {
      const bad = lib.natsSubjectProblem(subject, false); if (bad) throw new Error(bad);
      if (o.reply) { const r = lib.natsSubjectProblem(o.reply, false); if (r) throw new Error("Reply subject: " + r); }
      if (o.headers && o.headers.length && this.info && !this.info.headers) throw new Error("This server does not support headers.");
      const max = this.info && this.info.max_payload;
      if (max && payload.length > max) throw new Error(`Payload is ${payload.length} bytes; the server's max_payload is ${max}.`);
      this._send(lib.natsPub(subject, o.reply, o.headers, payload));
    }
    subscribe(subject, cb, o = {}) {
      const bad = lib.natsSubjectProblem(subject, true); if (bad) throw new Error(bad);
      if (o.queue && /\s/.test(o.queue)) throw new Error("Queue group names cannot contain spaces.");
      const sid = String(++this.sid);
      this._send(TE.encode(`SUB ${subject}${o.queue ? " " + o.queue : ""} ${sid}\r\n`));
      this.subs.set(sid, { cb });
      return { sid, subject, queue: o.queue || "", unsubscribe: () => { if (this.subs.delete(sid) && this.ws) this._send(TE.encode(`UNSUB ${sid}\r\n`)); } };
    }
    /* Resolves with the first reply; rejects on no responders or timeout. */
    request(subject, payload = EMPTY, o = {}) {
      return new Promise((resolve, reject) => {
        try {
          if (!this.mux) {
            this.mux = this.subscribe(this.inbox + ".*", m => {
              const r = this.reqs.get(m.subject.slice(this.inbox.length + 1)); if (!r) return;
              this.reqs.delete(m.subject.slice(this.inbox.length + 1)); clearTimeout(r.timer);
              if (m.status === 503) r.reject(new Error("No responders: nothing is subscribed to " + subject + "."));
              else r.resolve(m);
            });
          }
          const token = rand(10), ms = o.timeout || 2000;
          const timer = setTimeout(() => { this.reqs.delete(token); reject(new Error(`No reply within ${ms} ms.`)); }, ms);
          this.reqs.set(token, { resolve, reject, timer });
          try { this.publish(subject, payload, { reply: this.inbox + "." + token, headers: o.headers }); }
          catch (e) { clearTimeout(timer); this.reqs.delete(token); throw e; }
        } catch (e) { reject(e); }
      });
    }
    /* JetStream API call: JSON in, JSON out, API errors thrown with their code. */
    async jsApi(subject, body, o = {}) {
      const r = await this.request((o.prefix || "$JS.API") + "." + subject, body === undefined ? EMPTY : TE.encode(JSON.stringify(body)), { timeout: o.timeout || 4000 });
      let j; try { j = JSON.parse(TD.decode(r.payload)); } catch (_) { throw new Error("JetStream sent a reply that is not JSON."); }
      if (j.error) { const e = new Error(`${j.error.description || "JetStream error"} (code ${j.error.code}, err_code ${j.error.err_code})`); e.code = j.error.code; e.errCode = j.error.err_code; throw e; }
      return j;
    }
  };

  /* ---------- UI ---------- */

  const MAX_SUBJECTS = 50000, MAX_KEEP = 2000, MAX_ROWS = 300, MAX_SHOW = 65536, MAX_PLOT = 2000, MAX_PLOTS = 6;
  let current = null;                    // the client of the page that is open, closed when the tool is rendered again
  const esc = DT.esc, local = n => n.replace(/^[^:]+:/, "");
  const hhmmss = t => new Date(t).toISOString().slice(11, 23);
  const clock = t => new Date(t).toTimeString().slice(0, 8);
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join(" ");
  const preview = (m, n = 100) => { const v = lib.natsView(m.payload.subarray(0, 400)); return (v.kind === "binary" ? "[binary] " + hex(m.payload.subarray(0, 24)) : v.text.replace(/\s+/g, " ")).slice(0, n); };
  /* Root element name of an XML payload, from its first bytes only (cheap enough to run on every message). */
  const quickRoot = p => {
    let i = 0; while (i < 64 && i < p.length && (p[i] === 32 || p[i] === 9 || p[i] === 10 || p[i] === 13 || p[i] === 0xef || p[i] === 0xbb || p[i] === 0xbf)) i++;
    if (p[i] !== 60) return "";
    const m = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<([A-Za-z_][\w.:-]*)/.exec(TD.decode(p.subarray(0, 500)));
    return m ? local(m[1]) : "";
  };
  const internal = s => /^(\$JS\.|\$SYS\.|\$SRV\.|_INBOX\.)/.test(s);
  /* Does subscription pattern a already deliver everything pattern b would? */
  const covers = (a, b) => { const x = a.split("."), y = b.split("."); for (let i = 0; i < x.length; i++) { if (x[i] === ">") return true; if (i >= y.length || y[i] === ">" || (y[i] === "*" && x[i] !== "*")) return false; if (x[i] !== "*" && x[i] !== y[i]) return false; } return x.length === y.length; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  DT.register({
    id: "nats", name: "NATS Explorer", group: "UCI",
    desc: "Connect to a NATS server over WebSocket: watch subjects live, graph traffic and numeric fields, publish and request/reply, browse JetStream and KV, and decode XML (UCI) messages against any schema version you load. Read-only for JetStream; nothing is sent anywhere except to the server you enter.",
    keywords: "nats jetstream pubsub publish subscribe request reply kv key value stream consumer subject messaging broker websocket uci xsd schema xml chart graph",
    render(root) {
      if (current) current.close();
      const client = (current = new lib.NatsClient());
      const $ = s => root.querySelector(s);
      let remembered = ""; try { remembered = localStorage.getItem("dt.nats.url") || ""; } catch (_) { /* storage blocked */ }
      let model = lib.sharedSchema.model, gen = 1, activeTab = "sub";

      root.innerHTML = `
        <div class="panel">
          <div class="col"><label class="l" for="url">WebSocket URL</label><input type="text" id="url" class="mono" value="${esc(remembered || "ws://localhost:8080")}" spellcheck="false" autocomplete="off"></div>
          <div class="three" id="creds" style="margin-top:10px">
            <div class="col"><label class="l" for="user">User (optional)</label><input type="text" id="user" class="mono" autocomplete="off"></div>
            <div class="col"><label class="l" for="pass">Password</label><input type="password" id="pass" class="mono" autocomplete="off"></div>
            <div class="col"><label class="l" for="tok">…or token</label><input type="text" id="tok" class="mono" autocomplete="off"></div>
          </div>
          <div class="btns" style="align-items:center"><button class="btn primary" id="conn" type="button">Connect</button><button class="btn" id="disc" type="button" hidden>Disconnect</button><label class="hint" title="Reconnects to the last server you connected to without credentials"><input type="checkbox" id="auto"> connect automatically when I open this page</label></div>
          <div class="status" id="cst"></div>
          <div id="info"></div>
          ${lib.schemaPanelHtml("XML / UCI messages")}
          <details class="hint"><summary>The server needs a WebSocket listener</summary>
            <p>Add this to the server config (or the NATS Helm values) and restart. Browsers cannot speak the plain TCP protocol on 4222.</p>
            <pre class="out">websocket {
  port: 8080
  no_tls: true      # dev only; use a certificate and wss:// anywhere else
}</pre>
            <p>Run it with <code>nats-server -js -c nats.conf</code> to include JetStream. A page served over https:// can only open wss:// URLs. Credentials above support user/password and token auth; NKey and .creds (JWT) auth are not supported.</p>
          </details>
        </div>
        <div id="work" hidden>
          <div class="tabs nav" role="tablist"><button class="tab on" data-t="sub" type="button">Live</button><button class="tab" data-t="an" type="button">Analyze</button><button class="tab" data-t="pub" type="button">Publish &amp; Request</button><button class="tab" data-t="js" type="button">JetStream</button></div>

          <section data-p="sub">
            <div class="opts" style="margin:0 0 4px">
              <input type="text" id="ssub" class="mono" placeholder="add a subject, e.g. uci.&gt; or orders.*" spellcheck="false" style="width:260px"><input type="text" id="sq" class="mono" placeholder="queue group" spellcheck="false" style="width:120px">
              <button class="btn primary" id="sadd" type="button">Subscribe</button><button class="btn" id="spause" type="button">Pause</button><button class="btn" id="sclear" type="button">Clear</button><button class="btn" id="ssave" type="button">Save .jsonl</button>
              <label title="Hide $JS.*, $SYS.* and _INBOX.* traffic (this explorer's own requests and server internals)"><input type="checkbox" id="shide" checked> hide internal</label>
            </div>
            <div class="chip-row" id="subs"></div>
            <div class="status" id="swarn" style="margin:2px 0;min-height:0"></div>
            <div class="status" id="sst" style="margin:2px 0"></div>
            <div class="tiles" id="tiles"></div>
            <div class="three">
              <div class="chart" id="c-rate"><h3>Messages / second</h3><div class="plot"></div></div>
              <div class="chart" id="c-subj"><h3>Busiest subjects</h3><div class="plot"></div></div>
              <div class="chart" id="c-type"><h3>Message types</h3><div class="plot"></div></div>
            </div>
            <div class="opts" style="margin:8px 0 4px"><input type="search" id="sf" class="mono" placeholder="filter by subject or payload text" style="width:280px"><span class="chip-row" id="types"></span></div>
            <div class="tscroll" style="max-height:30vh"><table class="nl"><tbody id="feed"></tbody></table></div>
            <div id="sdet" style="margin-top:10px"></div>
            <details class="chart" id="c-tree" open><summary><b class="h3">Subject tree</b> <span class="hint">click to expand, double-click to filter the feed</span></summary><div class="stree" id="stree"></div></details>
            <details class="chart" id="c-plot" open><summary><b class="h3">Plot a field over time</b> <span class="hint">numeric fields of JSON or XML payloads, collected from now on</span></summary>
              <div class="opts"><label>Subject <select id="gsubj" class="mono"></select></label><label>Field <select id="gfield" class="mono"></select></label><button class="btn" id="gadd" type="button">Add to chart</button><button class="btn" id="gclr" type="button">Clear</button></div>
              <div class="lgd" id="glgd"></div><div class="plot"></div></details>
          </section>

          <section data-p="an" hidden>
            <div class="opts" style="margin:0 0 6px"><label><input type="checkbox" id="rec" checked> record what arrives (the newest 20,000 messages)</label><label><input type="checkbox" id="recv" checked> validate</label><button class="btn" id="recsave" type="button">Save capture</button><button class="btn" id="reclab" type="button" title="Analyse or replay it in the UCI Traffic Lab">Open in Traffic Lab</button><button class="btn" id="recclr" type="button">Clear</button></div>
            <div id="labhost"></div>
          </section>

          <section data-p="pub" hidden>
            <div class="two">
              <div class="col"><label class="l" for="psub">Subject</label><input type="text" id="psub" class="mono" spellcheck="false" placeholder="orders.new"></div>
              <div class="col"><label class="l" for="prep">Reply-to (optional)</label><input type="text" id="prep" class="mono" spellcheck="false" placeholder="set one to receive replies in a subscription"></div>
            </div>
            <div class="panel" id="pschema" hidden style="margin-bottom:0"><div class="opts" style="margin:0">
              <label>Message <input type="text" id="pmsg" class="mono" list="pmsgs" placeholder="schema message name" style="width:260px" autocomplete="off"></label><datalist id="pmsgs"></datalist>
              <label><input type="checkbox" id="pall"> include optional fields</label>
              <button class="btn" id="pgen" type="button">Generate sample</button><button class="btn" id="pval" type="button">Validate</button></div>
              <div class="status" id="pvs"></div><div id="pverr"></div></div>
            <div class="two" style="margin-top:10px">
              <div class="col"><label class="l" for="pdata">Payload</label><textarea id="pdata" class="md" spellcheck="false"></textarea>
                <div class="opts"><label>Format <select id="pfmt" class="mono"><option value="text">Text (UTF-8)</option><option value="json">JSON (validated)</option><option value="hex">Hex bytes</option></select></label></div></div>
              <div class="col"><label class="l" for="phdr">Headers (one <code>Key: value</code> per line)</label><textarea id="phdr" class="md" spellcheck="false" placeholder="Nats-Msg-Id: 42"></textarea></div>
            </div>
            <div class="opts"><button class="btn primary" id="ppub" type="button">Publish</button><button class="btn" id="preq" type="button">Request (wait for reply)</button><label>Timeout <input type="number" id="ptmo" value="2000" min="100" step="100" class="mono" style="width:90px"> ms</label></div>
            <div class="status" id="pst"></div>
            <div id="pres"></div>
          </section>

          <section data-p="js" hidden>
            <div class="opts"><button class="btn primary" id="jref" type="button">Refresh</button><label>Domain <input type="text" id="jdom" class="mono" placeholder="optional" style="width:160px"></label></div>
            <div class="status" id="jst"></div>
            <div id="jacct"></div>
            <div id="jgraph"></div>
            <div id="jstreams"></div>
            <div id="jdet" style="margin-top:14px"></div>
          </section>
        </div>`;

      DT.wire(root);
      const status = (id, kind, msg) => DT.status($(id), kind, msg);

      /* ----- Analyze: record the traffic into a store and show the traffic views on it ----- */
      const store = new lib.TrafficStore(model, { max: 20000, validate: true });
      let lab = null, recording = true;
      const mountLab = () => { if (!lab) lab = lib.trafficLab($("#labhost"), { store, getModel: () => model, live: true }); else lab.refresh(); };
      $("#rec").onchange = e => { recording = e.target.checked; };
      $("#recv").onchange = e => { store.reset(model, e.target.checked); if (lab) lab.refresh(); };
      $("#recclr").onclick = () => { store.clear(); if (lab) lab.refresh(); };
      $("#recsave").onclick = () => { if (!store.records.length) return; DT.download("capture.jsonl", lib.capStringify(store.records), "application/x-ndjson"); };
      $("#reclab").onclick = () => { lib.pendingCapture = store.records.map(r => ({ t: r.t, topic: r.topic, text: r.text, source: r.source })); location.hash = "#ucilab"; };

      /* ----- schema ----- */
      const sp = lib.schemaPanel(root, m => {
        model = m; gen++; store.reset(m); if (lab) lab.refresh();
        $("#pschema").hidden = !m;
        $("#pmsgs").innerHTML = m ? [...m.elements.keys()].sort().map(k => `<option value="${esc(k)}">`).join("") : "";
        draw(); drawGraphs(true);
        if (selected) $("#sdet").replaceChildren(detail(selected, detailOpts));
      });

      /* ----- connection ----- */
      function showTab(t) {
        activeTab = t;
        root.querySelectorAll(".tabs.nav .tab").forEach(b => b.classList.toggle("on", b.dataset.t === t));
        root.querySelectorAll("section[data-p]").forEach(s => { s.hidden = s.dataset.p !== t; });
        if (t === "js" && !jsLoaded) refreshJs();
        if (t === "sub") drawGraphs(true);
        if (t === "an") mountLab();
      }
      root.querySelectorAll(".tabs.nav .tab").forEach(b => { b.onclick = () => showTab(b.dataset.t); });

      function disconnected(msg, kind) {
        clearInterval(gTimer); gTimer = 0;
        $("#work").hidden = true; $("#disc").hidden = true; $("#conn").hidden = false; $("#conn").disabled = false;
        $("#info").innerHTML = ""; $("#creds").style.display = ""; subList.length = 0; renderSubs(); jsLoaded = false;
        status("#cst", kind || "", msg);
      }
      async function connect() {
        const url = $("#url").value.trim();
        if (!/^wss?:\/\/\S+$/i.test(url)) return status("#cst", "err", "The URL must start with ws:// or wss://, for example ws://localhost:8080.");
        $("#conn").disabled = true; status("#cst", "", "Connecting…");
        client.onclose = reason => disconnected("Connection lost: " + reason + ".", "err");
        client.onerror = msg => status("#swarn", "warn", "Server: " + msg);
        try {
          const info = await client.connect(url, { user: $("#user").value, pass: $("#pass").value, token: $("#tok").value.trim() });
          try { localStorage.setItem("dt.nats.url", url); localStorage.setItem("dt.nats.noauth", $("#user").value || $("#pass").value || $("#tok").value ? "0" : "1"); } catch (_) { /* storage blocked */ }
          const rows = [["server", info.server_name || info.server_id], ["version", info.version], ["go", info.go], ["host", `${info.host}:${info.port}`], ["max payload", lib.bytesLabel(info.max_payload || 0)],
            ["headers", info.headers ? "yes" : "no"], ["JetStream", info.jetstream ? "yes" : "no / unknown"], ["auth required", info.auth_required ? "yes" : "no"], ["client id", info.client_id], ["cluster", info.cluster || "-"]];
          $("#info").innerHTML = `<div class="hint" style="margin:4px 0">${esc(info.server_name || "server")} · v${esc(info.version)} · ${info.jetstream ? "JetStream" : "no JetStream"} · max payload ${esc(lib.bytesLabel(info.max_payload || 0))} · client ${esc(String(info.client_id))}</div><details class="hint"><summary>all server info</summary>${DT.kv(rows.filter(r => r[1] !== undefined && r[1] !== ""))}</details>`;
          $("#creds").style.display = "none";
          $("#conn").hidden = true; $("#disc").hidden = false; $("#work").hidden = false;
          status("#cst", "ok", "Connected to " + url);
          gTimer = setInterval(tick, 1000);
          if (pendingPub) { pendingPub = false; showTab("pub"); }
          try { subList.push(client.subscribe(">", onMsg)); renderSubs(); } catch (e) { status("#swarn", "warn", "Could not subscribe to >: " + e.message); }
          draw(); drawGraphs(true);
        } catch (e) {
          $("#conn").disabled = false;
          status("#cst", "err", /authorization|authentication/i.test(e.message) ? e.message + " Set a user/password or token above." : e.message);
        }
      }
      $("#conn").onclick = connect;
      $("#disc").onclick = () => { client.close(); disconnected("Disconnected."); };
      $("#url").addEventListener("keydown", e => { if (e.key === "Enter") connect(); });
      window.addEventListener("pagehide", () => client.close(), { once: true });

      /* ----- decoding XML payloads ----- */
      const decodeFor = (m, validate) => {
        if (m._ug !== gen) { m._ug = gen; m._d = undefined; m._dv = false; }
        if (m._d === undefined || (validate && !m._dv)) {
          if (!m.payload.length || m.payload.length > 3e6) return (m._d = null);
          m._d = lib.uciDecode(model, TD.decode(m.payload), { validate: !!validate && !!model }); m._dv = !!validate;
        }
        return m._d;
      };
      /* ----- message detail (shared by the feed, request replies and JetStream) ----- */
      function detail(m, o = {}) {
        const box = document.createElement("div"); box.className = "panel";
        const v = lib.natsView(m.payload.length > MAX_SHOW ? m.payload.subarray(0, MAX_SHOW) : m.payload);
        const rows = [["subject", m.subject]];
        if (m.seq !== undefined) rows.push(["sequence", String(m.seq)]);
        if (m.time) rows.push(["time", m.time]);
        if (m.reply) rows.push(["reply-to", m.reply]);
        const d = m.payload.length && quickRoot(m.payload) ? decodeFor(m, true) : null;
        rows.push(["size", `${m.payload.length} bytes (${d ? (d.xml ? "xml" : "broken xml") : v.kind})`]);
        if (m.status) rows.push(["status", `${m.status} ${m.description}`.trim()]);
        for (const [k, val] of m.headers || []) rows.push(["header: " + k, val]);
        box.innerHTML = DT.kv(rows) + `<div class="btns"><button class="btn" data-a="copy" type="button">Copy payload</button>${m.reply && o.onReply ? '<button class="btn" data-a="reply" type="button">Reply to this</button>' : ""}${d && d.xml ? '<button class="btn" data-a="pub" type="button">Edit as new message</button>' : ""}</div><div class="pl"></div>`
          + (m.payload.length > MAX_SHOW ? `<div class="hint">Showing the first ${MAX_SHOW.toLocaleString()} of ${m.payload.length.toLocaleString()} bytes.</div>` : "");
        const pl = box.querySelector(".pl");
        const raw = () => { const pre = el("pre", "out", v.kind === "empty" ? "(empty payload)" : v.text); return pre; };
        if (d && d.xml) {
          const tabs = el("div", "tabs"), panes = {};
          const mk = (key, label, build) => { const b = el("button", "tab", label); b.type = "button"; b.dataset.k = key; tabs.append(b); panes[key] = { b, build, node: null }; };
          mk("dec", "Decoded", () => lib.uciView(d, model));
          mk("xml", "XML", () => el("pre", "out", lib.xmlSerialize(d.tree)));
          mk("raw", "Raw", raw);
          const show = k => { for (const [kk, p] of Object.entries(panes)) { p.b.classList.toggle("on", kk === k); if (kk === k && !p.node) { p.node = p.build(); pl.append(p.node); } if (p.node) p.node.hidden = kk !== k; } };
          pl.append(tabs); show("dec");
          tabs.onclick = e => { const b = e.target.closest(".tab"); if (b) show(b.dataset.k); };
        } else if (d && !d.xml) { pl.append(el("div", "status err", "Looks like XML but is not well-formed: " + d.error), raw()); }
        else pl.append(raw());
        box.querySelector('[data-a="copy"]').onclick = e => DT.copy(v.kind === "binary" ? hex(m.payload).replace(/ /g, "") : TD.decode(m.payload), e.target);
        const rb = box.querySelector('[data-a="reply"]'); if (rb) rb.onclick = () => o.onReply(m);
        const pb = box.querySelector('[data-a="pub"]');
        if (pb) pb.onclick = () => { $("#psub").value = m.subject; $("#pdata").value = d.xml ? lib.xmlSerialize(d.tree) : TD.decode(m.payload); $("#pfmt").value = "text"; if (d.msgName) $("#pmsg").value = d.msgName; showTab("pub"); };
        return box;
      }
      const detailOpts = { onReply: m => { $("#psub").value = m.reply; showTab("pub"); $("#pdata").focus(); } };

      /* ----- traffic statistics (for the graphs), updated on every message even when the feed is paused ----- */
      const secs = new Map(), subj = new Map(), typeCounts = new Map(), plots = [];
      let tot = { n: 0, b: 0 }, gTimer = 0, treeOpen = new Set(["|"]), sig = "";
      let curSec = 0, cur = null, subjOverflow = 0;
      function tally(m, now) {
        const sec = Math.floor(now / 1000), size = m.payload.length;
        if (sec !== curSec) { curSec = sec; cur = secs.get(sec) || secs.set(sec, { n: 0, b: 0 }).get(sec); }
        cur.n++; cur.b += size; tot.n++; tot.b += size;
        let e = subj.get(m.subject);
        if (!e) { if (subj.size >= MAX_SUBJECTS) subjOverflow++; else subj.set(m.subject, e = { n: 0, b: 0, last: null, tokens: m.subject.split(".") }); }
        if (e) { e.n++; e.b += size; e.last = m; }
        if (m.root) typeCounts.set(m.root, (typeCounts.get(m.root) || 0) + 1);
        for (const p of plots) {
          if (p.subject !== m.subject || now - (p.last || 0) < 40) continue;      // at most 25 points per second per series, however busy the subject is
          p.last = now;
          const v = lib.natsNumericFields(m.payload).get(p.path);
          if (v !== undefined) { p.points.push([now, v]); if (p.points.length > MAX_PLOT) p.points.splice(0, p.points.length - MAX_PLOT); }
        }
      }
      const resetStats = () => { subjOverflow = 0; curSec = 0; cur = null; secs.clear(); subj.clear(); typeCounts.clear(); tot = { n: 0, b: 0 }; plots.forEach(p => { p.points = []; }); };

      /* ----- subscribe ----- */
      const subList = [];
      let msgs = [], total = 0, paused = false, selected = null, timer = 0, typeFilter = "", typeSig = "";
      function renderSubs() {
        $("#subs").innerHTML = subList.map((s, i) => `<span class="chip" data-i="${i}" title="Click to unsubscribe">${esc(s.subject)}${s.queue ? " [" + esc(s.queue) + "]" : ""} ×</span>`).join("");
      }
      $("#subs").onclick = e => { const c = e.target.closest(".chip"); if (!c) return; const s = subList.splice(+c.dataset.i, 1)[0]; if (s) s.unsubscribe(); renderSubs(); };
      function draw() {
        timer = 0;
        const f = $("#sf").value.trim().toLowerCase(), rows = [];
        for (let i = msgs.length - 1; i >= 0 && rows.length < MAX_ROWS; i--) {
          const m = msgs[i];
          if (typeFilter && m.root !== typeFilter) continue;
          if (f) { m.lc = m.lc || (m.subject + " " + TD.decode(m.payload.subarray(0, 4000))).toLowerCase(); if (!m.lc.includes(f)) continue; }
          const unk = model && m.root && !model.elements.has(m.root);
          rows.push(`<tr data-n="${m.n}"${m === selected ? ' class="on"' : ""}><td class="t">${hhmmss(m.t)}</td><td class="s">${esc(m.subject)}</td><td class="ty">${m.root ? `<span${unk ? ' class="unk" title="Not in the loaded schema"' : ""}>${esc(m.root)}</span>` : ""}</td><td class="t">${m.payload.length} B</td><td class="p">${esc(m.pv || (m.pv = preview(m)))}</td></tr>`);
        }
        $("#feed").innerHTML = rows.join("") || `<tr><td class="t">${total ? "No message matches the filter." : "Waiting for messages…"}</td></tr>`;
        status("#sst", paused ? "warn" : "", `${total.toLocaleString()} received · ${Math.min(msgs.length, MAX_KEEP).toLocaleString()} kept (last ${MAX_KEEP.toLocaleString()}) · ${paused ? "paused" : "live"}${stride > 1 ? ` · busy: feed shows 1 in ${stride}, counts and charts stay exact` : ""}`);
        const top = [...typeCounts].sort((a, b) => b[1] - a[1]).slice(0, 12), s2 = typeFilter + "|" + top.map(x => x[0] + x[1]).join();
        if (s2 !== typeSig) {
          typeSig = s2;
          $("#types").innerHTML = top.length ? `<span class="chip" data-ty="" style="${!typeFilter ? "color:var(--accent);border-color:var(--accent)" : ""}">all types</span>` + top.map(([t, n]) => `<span class="chip" data-ty="${esc(t)}" style="${typeFilter === t ? "color:var(--accent);border-color:var(--accent)" : ""}">${esc(t)} ${n}</span>`).join("") : "";
        }
      }
      $("#types").onclick = e => { const c = e.target.closest(".chip"); if (c) { typeFilter = c.dataset.ty; typeSig = ""; draw(); } };
      const schedule = () => { if (!timer) timer = setTimeout(draw, 120); };
      let hideInternal = true, stride = 1, strideN = 0;
      $("#shide").onchange = e => { hideInternal = e.target.checked; };
      function onMsg(m) {
        total++;
        if ((total & 1023) === 0 && !root.isConnected) { client.close(); return; }        // the page moved on to another tool
        const c0 = m.subject.charCodeAt(0);
        if (hideInternal && (c0 === 36 || c0 === 95) && internal(m.subject)) return;
        const now = Date.now();
        m.root = quickRoot(m.payload); tally(m, now);
        if (paused || (stride > 1 && ++strideN % stride)) return;                         // above ~20k msg/s only every Nth message goes into the feed; counts stay exact
        m.n = total; m.t = now;
        msgs.push(m);
        if (recording && m.payload.length) { const c = m.payload[0]; if (c === 60 || c === 123 || c === 32 || c === 10 || c === 13) store.add({ t: now, topic: m.subject, text: TD.decode(m.payload), source: "nats" }); }
        if (msgs.length > MAX_KEEP * 1.25) msgs.splice(0, msgs.length - MAX_KEEP);
        schedule();
      }
      $("#sadd").onclick = () => {
        const subject = $("#ssub").value.trim(), queue = $("#sq").value.trim();
        const clash = subList.find(x => x.queue === queue && (covers(x.subject, subject) || covers(subject, x.subject)));
        if (clash) return status("#swarn", "warn", `"${subject}" overlaps the existing subscription "${clash.subject}" and would show every message twice. Click that chip to remove it first.`);
        try { subList.push(client.subscribe(subject, onMsg, { queue })); $("#ssub").value = ""; renderSubs(); draw(); }
        catch (e) { status("#swarn", "err", e.message); }
      };
      $("#ssub").addEventListener("keydown", e => { if (e.key === "Enter") $("#sadd").click(); });
      $("#spause").onclick = e => { paused = !paused; e.target.textContent = paused ? "Resume" : "Pause"; draw(); };
      $("#sclear").onclick = () => { msgs = []; total = 0; selected = null; typeFilter = ""; typeSig = ""; resetStats(); $("#sdet").innerHTML = ""; draw(); drawGraphs(true); };
      $("#sf").addEventListener("input", DT.debounce(draw, 150));
      $("#feed").onclick = e => {
        const tr = e.target.closest("tr[data-n]"); if (!tr) return;
        selected = msgs.find(m => m.n === +tr.dataset.n); if (!selected) return;
        $("#feed").querySelectorAll("tr.on").forEach(r => r.classList.remove("on")); tr.classList.add("on");
        $("#sdet").replaceChildren(detail(selected, detailOpts));
      };
      $("#ssave").onclick = () => {
        const lines = msgs.map(m => { const v = lib.natsView(m.payload); return JSON.stringify({ time: new Date(m.t).toISOString(), subject: m.subject, reply: m.reply || undefined, headers: m.headers.length ? m.headers : undefined, ...(v.kind === "binary" ? { payload_base64: bytesToB64(m.payload) } : { payload: TD.decode(m.payload) }) }); });
        if (!lines.length) return status("#swarn", "warn", "Nothing to save yet.");
        DT.download("nats-messages.jsonl", lines.join("\n") + "\n", "application/x-ndjson");
      };
      draw();

      /* ----- graphs ----- */
      const rate = (lo, hi) => { let s = 0; for (let i = lo; i <= hi; i++) s += (secs.get(i) || { n: 0 }).n; return s / (hi - lo + 1); };
      const hovered = e => e.matches(":hover");
      const plotInto = (host, html) => { host.querySelector(".plot").innerHTML = html; };
      function tick() {
        if (!root.isConnected) { client.close(); clearInterval(gTimer); return; }
        const last = secs.get(Math.floor(Date.now() / 1000) - 1); stride = last && last.n > 20000 ? Math.ceil(last.n / 10000) : 1;
        const cut = Math.floor(Date.now() / 1000) - 620; for (const k of secs.keys()) if (k < cut) secs.delete(k);
        if (activeTab === "sub") drawGraphs(false);
      }
      const topK = k => {
        const out = []; let min = -1; const byN = (a, b) => b[1].n - a[1].n;
        for (const kv of subj) {
          const n = kv[1].n;
          if (out.length < k) { out.push(kv); if (out.length === k) { out.sort(byN); min = out[k - 1][1].n; } }
          else if (n > min) { out[k - 1] = kv; out.sort(byN); min = out[k - 1][1].n; }
        }
        return out.sort(byN);
      };
      function drawGraphs(force) {
        if (!force && activeTab !== "sub") return;
        const now = Math.floor(Date.now() / 1000), pts = [];
        for (let i = now - 300; i < now; i++) pts.push([i - now, (secs.get(i) || { n: 0 }).n]);
        const r5 = rate(now - 5, now - 1), b5 = (() => { let s = 0; for (let i = now - 5; i < now; i++) s += (secs.get(i) || { b: 0 }).b; return s / 5; })();
        $("#tiles").innerHTML = [["Messages / s", num1(r5), lib.chartSpark(pts.slice(-60).map(p => p[1]))], ["Throughput", lib.bytesLabel(b5) + "/s", lib.chartSpark(pts.slice(-60).map((p, i, a) => (secs.get(now - a.length + i) || { b: 0 }).b), 110, 26, lib.chartColors[2])],
          ["Total messages", tot.n.toLocaleString(), ""], ["Total bytes", lib.bytesLabel(tot.b), ""], ["Subjects seen", subj.size.toLocaleString() + (subjOverflow ? "+" : ""), ""], ["Message types", typeCounts.size.toLocaleString(), ""]]
          .map(([l, v, s]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${esc(v)}</div>${s}</div>`).join("");
        const cr = $("#c-rate");
        if (!hovered(cr)) { const c = lib.chartLine([{ name: "msgs/s", points: pts }], { zero: true, xFmt: x => (x === 0 ? "now" : x + " s"), yFmt: v => lib.chartNum(v), w: 420, h: 150 }); plotInto(cr, c.svg); lib.chartAttachLine(cr, c.plot); }
        const cs = $("#c-subj");
        if (!hovered(cs)) {
          const top = topK(12);
          plotInto(cs, lib.chartBars(top.map(([s, e]) => ({ label: s, value: e.n, tip: `${s}: ${e.n.toLocaleString()} messages, ${lib.bytesLabel(e.b)}` })), { click: true, labelW: 150, w: 420, fmt: v => v.toLocaleString(), empty: "Subscribe to a subject to see traffic." }));
          cs._top = top.map(x => x[0]); lib.chartAttachTips(cs);
        }
        const ct = $("#c-type");
        if (!hovered(ct)) {
          const top = [...typeCounts].sort((a, b) => b[1] - a[1]).slice(0, 12), inS = t => !model || model.elements.has(t);
          plotInto(ct, lib.chartBars(top.map(([t, n]) => ({ label: t, value: n, color: inS(t) ? lib.chartColors[0] : lib.chartColors[1], tip: `${t}: ${n.toLocaleString()} messages${inS(t) ? "" : " (not in the loaded schema)"}` })), { click: true, labelW: 150, w: 420, fmt: v => v.toLocaleString(), empty: "No XML messages seen yet." }));
          ct._top = top.map(x => x[0]); lib.chartAttachTips(ct);
          ct.querySelector("h3").innerHTML = model && top.some(([t]) => !inS(t)) ? `Message types <span class="lg-note"><span class="sw" style="background:${lib.chartColors[0]}"></span>in schema <span class="sw" style="background:${lib.chartColors[1]}"></span>not in schema</span>` : "Message types";
        }
        drawTree(force); drawPlotControls(force);
        const cp = $("#c-plot");
        $("#glgd").innerHTML = plots.map((p, i) => `<span><span class="sw" style="background:${lib.chartColors[i % 8]}"></span>${esc(p.name)} <a class="go" data-rm="${i}">remove</a></span>`).join("");
        if (!hovered(cp)) {
          const c = lib.chartLine(plots.map((p, i) => ({ name: p.name, color: lib.chartColors[i % 8], points: p.points })), { xFmt: clock, yFmt: v => lib.chartNum(v), w: 900, h: 190 });
          plotInto(cp, plots.length ? c.svg : `<div class="hint" style="padding:14px 4px">Choose a subject and field above, then Add to chart.</div>`); if (plots.length) lib.chartAttachLine(cp, c.plot);
        }
      }
      const num1 = v => v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1);
      const filterTo = text => { $("#sf").value = text; typeFilter = ""; typeSig = ""; draw(); showTab("sub"); };
      $("#c-subj").addEventListener("click", e => { const g = e.target.closest(".brow"); if (g) filterTo($("#c-subj")._top[+g.dataset.i]); });
      $("#c-type").addEventListener("click", e => { const g = e.target.closest(".brow"); if (g) { typeFilter = $("#c-type")._top[+g.dataset.i]; typeSig = ""; $("#sf").value = ""; draw(); showTab("sub"); } });

      let treeAt = 0;
      function drawTree(force) {
        if (!$("#c-tree").open) return;
        const t = Date.now(); if (!force && subj.size > 5000 && t - treeAt < 5000) return;
        treeAt = t;
        const host = $("#stree"), st = host.scrollTop;
        const rootN = { kids: new Map(), n: 0 };
        for (const e of subj.values()) { let node = rootN; rootN.n += e.n; for (const tk of e.tokens) { let k = node.kids.get(tk); if (!k) node.kids.set(tk, k = { kids: new Map(), n: 0 }); node = k; node.n += e.n; } }
        if (!rootN.n) { host.textContent = "No subjects yet."; return; }
        let max = 1; for (const k of rootN.kids.values()) if (k.n > max) max = k.n;
        const build = (node, path) => {
          const sorted = [...node.kids].sort((x, y) => y[1].n - x[1].n), shown = sorted.slice(0, 200);
          return shown.map(([tok, k]) => {
            const p = path + "." + tok, open = treeOpen.has(p), has = k.kids.size > 0;
            return `<div><div class="sn" data-p="${esc(p.slice(1))}"><span class="tg">${has ? (open ? "▾" : "▸") : ""}</span><span>${esc(tok)}</span><span class="bar" style="width:${Math.max(2, Math.round(k.n / max * 140))}px"></span><span class="ct">${k.n.toLocaleString()}</span></div>${has && open ? `<div class="kids">${build(k, p)}</div>` : ""}</div>`;
          }).join("") + (sorted.length > shown.length ? `<div class="hint" style="padding-left:22px">…and ${(sorted.length - shown.length).toLocaleString()} more (the busiest 200 are shown)</div>` : "");
        };
        host.innerHTML = build(rootN, "");
        host.scrollTop = st;
      }
      $("#stree").onclick = e => { const sn = e.target.closest(".sn"); if (!sn) return; const p = "." + sn.dataset.p; if (treeOpen.has(p)) treeOpen.delete(p); else treeOpen.add(p); drawTree(true); };
      $("#stree").ondblclick = e => { const sn = e.target.closest(".sn"); if (sn) filterTo(sn.dataset.p); };

      function drawPlotControls(force) {
        const sel = $("#gsubj");
        if (!force && sel._at && subj.size > 5000 && Date.now() - sel._at < 5000) return;
        sel._at = Date.now();
        const names = topK(200).map(x => x[0]).sort(), want = names.join("|");
        if (sel._sig !== want) { const cur = sel.value; sel.innerHTML = names.map(k => `<option>${esc(k)}</option>`).join(""); if (cur && names.includes(cur)) sel.value = cur; sel._sig = want; fillFields(); }
      }
      function fillFields() {
        const f = $("#gfield"), e = subj.get($("#gsubj").value), fields = e && e.last ? [...lib.natsNumericFields(e.last.payload).keys()] : [];
        f.innerHTML = fields.length ? fields.map(k => `<option>${esc(k)}</option>`).join("") : `<option value="">(no numeric fields in the latest message)</option>`;
      }
      $("#gsubj").onchange = fillFields;
      $("#gsubj").addEventListener("mousedown", () => drawPlotControls(true));       // opening the list always shows the current busiest subjects
      $("#gadd").onclick = () => {
        const subject = $("#gsubj").value, path = $("#gfield").value;
        if (!subject || !path) return;
        if (plots.some(p => p.subject === subject && p.path === path)) return;
        if (plots.length >= MAX_PLOTS) return status("#swarn", "warn", `At most ${MAX_PLOTS} plotted series.`);
        const e = subj.get(subject), v = e && e.last ? lib.natsNumericFields(e.last.payload).get(path) : undefined;
        plots.push({ subject, path, name: `${subject} ${path}`, points: v === undefined ? [] : [[Date.now(), v]] });
        drawGraphs(true);
      };
      $("#gclr").onclick = () => { plots.length = 0; drawGraphs(true); };
      $("#glgd").onclick = e => { const a = e.target.closest("[data-rm]"); if (a) { plots.splice(+a.dataset.rm, 1); drawGraphs(true); } };

      /* ----- publish & request ----- */
      function outgoing() {
        const subject = $("#psub").value.trim();
        const payload = lib.natsPayloadBytes($("#pfmt").value, $("#pdata").value);
        const headers = lib.natsParseHeaderLines($("#phdr").value);
        return { subject, payload, headers, reply: $("#prep").value.trim() };
      }
      function schemaCheck(text, into) {
        const d = model && lib.uciDecode(model, text, { validate: true });
        const box = $("#pverr"); box.innerHTML = "";
        if (!model) return into && DT.status($("#pvs"), "warn", "Load a schema (top of the page) to validate.");
        if (!d) return DT.status($("#pvs"), "warn", "The payload does not look like XML.");
        if (!d.xml) { DT.status($("#pvs"), "err", "Not well-formed XML: " + d.error); return d; }
        if (!d.known) { DT.status($("#pvs"), "warn", `<${d.rootName}> is not a message in the loaded schema.${d.suggest && d.suggest.length ? " Closest: " + d.suggest.join(", ") + "." : ""}`); return d; }
        if (d.wrapped) { DT.status($("#pvs"), "warn", `Wrapped in <${d.wrapped}>; only the inner ${d.msgName} was recognised, so it was not validated.`); return d; }
        const v = d.validation;
        DT.status($("#pvs"), v.ok ? "ok" : "err", v.ok ? `${d.msgName}: valid against the loaded schema${d.nsMatch ? "" : " (note: namespace differs from the schema's)"}.` : `${d.msgName}: ${v.errors.length}${v.truncated ? "+" : ""} schema error${v.errors.length === 1 ? "" : "s"}.`);
        if (!v.ok) { const list = el("div", "errlist"); for (const e of v.errors.slice(0, 25)) { const r = el("div", "er"); r.append(el("span", "ln", `${e.line}:${e.col}`), el("span", "ms", e.message), el("span", "pa", e.path || "")); list.append(r); } box.append(list); }
        return d;
      }
      $("#pgen").onclick = () => {
        try {
          const name = $("#pmsg").value.trim(); if (!name) throw new Error("Choose a message name from the schema first.");
          $("#pdata").value = lib.uciSample(model, name, { all: $("#pall").checked }); $("#pfmt").value = "text";
          schemaCheck($("#pdata").value);
        } catch (e) { DT.status($("#pvs"), "err", e.message); }
      };
      $("#pval").onclick = () => schemaCheck($("#pdata").value, true);
      $("#ppub").onclick = () => {
        try {
          const o = outgoing(); client.publish(o.subject, o.payload, { reply: o.reply, headers: o.headers });
          let note = "";
          if (model && $("#pfmt").value !== "hex") { const d = lib.uciDecode(model, $("#pdata").value, { validate: true }); if (d && d.known && d.validation && !d.validation.ok) note = ` Note: ${d.msgName} has ${d.validation.errors.length} schema error${d.validation.errors.length === 1 ? "" : "s"} (use Validate to see them).`; }
          status("#pst", note ? "warn" : "ok", `Published ${o.payload.length} bytes to ${o.subject}.${note}`);
        } catch (e) { status("#pst", "err", e.message); }
      };
      $("#preq").onclick = async () => {
        $("#pres").innerHTML = "";
        try {
          const o = outgoing(), t0 = performance.now();
          status("#pst", "", "Waiting for a reply…");
          const r = await client.request(o.subject, o.payload, { headers: o.headers, timeout: +$("#ptmo").value || 2000 });
          status("#pst", "ok", `Reply after ${Math.round(performance.now() - t0)} ms.`);
          $("#pres").replaceChildren(detail(r));
        } catch (e) { status("#pst", "err", e.message); }
      };

      /* ----- JetStream ----- */
      let jsLoaded = false, jsStreams = [];
      const api = (subject, body) => {
        const d = $("#jdom").value.trim();
        return client.jsApi(subject, body, d ? { prefix: `$JS.${d}.API` } : {}).catch(e => {
          throw /No responders/.test(e.message) ? new Error("No JetStream API answered. JetStream may be disabled for this account (start the server with -js), or this domain is wrong.") : e;
        });
      };
      async function paged(subject, key) {
        const out = []; let offset = 0, tot2 = Infinity;
        while (offset < tot2) {
          const r = await api(subject, { offset }); tot2 = r.total || 0;
          const list = r[key] || []; out.push(...list); if (!list.length) break; offset += list.length;
        }
        return out;
      }
      const when = t => (t && !t.startsWith("0001-") ? t.replace("T", " ").replace(/\.\d+Z$|Z$/, "Z") : "-");
      async function refreshJs() {
        jsLoaded = true; status("#jst", "", "Loading…"); $("#jdet").innerHTML = "";
        try {
          const acct = await api("INFO");
          const l = acct.limits || {};
          $("#jacct").innerHTML = DT.kv([["streams", String(acct.streams)], ["consumers", String(acct.consumers)], ["memory used", lib.bytesLabel(acct.memory || 0)], ["storage used", lib.bytesLabel(acct.storage || 0)],
            ["limits", `streams ${l.max_streams ?? "?"} · consumers ${l.max_consumers ?? "?"} · memory ${l.max_memory > 0 ? lib.bytesLabel(l.max_memory) : "unlimited"} · storage ${l.max_storage > 0 ? lib.bytesLabel(l.max_storage) : "unlimited"}`]]);
          const streams = jsStreams = await paged("STREAM.LIST", "streams");
          status("#jst", "ok", `${streams.length} stream${streams.length === 1 ? "" : "s"}.`);
          const kind = n => n.startsWith("KV_") ? "KV" : n.startsWith("OBJ_") ? "Object" : "";
          const bySize = [...streams].sort((a, b) => b.state.bytes - a.state.bytes).slice(0, 12);
          $("#jgraph").innerHTML = streams.length ? `<div class="two"><div class="chart" id="jg-size"><h3>Stream size</h3><p class="sub">Click a bar to open the stream.</p><div class="plot"></div></div><div class="chart" id="jg-msgs"><h3>Messages per stream</h3><p class="sub">&nbsp;</p><div class="plot"></div></div></div>` : "";
          if (streams.length) {
            const bars = (host, list, f, fmt) => { plotInto(host, lib.chartBars(list.map(s => ({ label: s.config.name, value: f(s), tip: `${s.config.name}: ${fmt(f(s))}` })), { click: true, labelW: 150, w: 520, fmt })); host._list = list; lib.chartAttachTips(host); host.addEventListener("click", e => { const g = e.target.closest(".brow"); if (g) openStream(host._list[+g.dataset.i].config.name); }); };
            bars($("#jg-size"), bySize, s => s.state.bytes, lib.bytesLabel);
            bars($("#jg-msgs"), [...streams].sort((a, b) => b.state.messages - a.state.messages).slice(0, 12), s => s.state.messages, v => v.toLocaleString());
          }
          $("#jstreams").innerHTML = streams.length ? `<div class="tscroll"><table class="kv"><thead><tr><th>Stream</th><th>Subjects</th><th>Messages</th><th>Size</th><th>Consumers</th><th>Storage</th><th>Retention</th></tr></thead><tbody>${streams.map(s => {
            const c = s.config, st = s.state, k = kind(c.name);
            return `<tr class="go" data-s="${esc(c.name)}" style="cursor:pointer"><td class="v"><a class="go">${esc(c.name)}</a>${k ? ` <span class="kb">${k}</span>` : ""}</td><td class="v">${esc((c.subjects || []).join(", "))}</td><td>${st.messages.toLocaleString()}</td><td>${lib.bytesLabel(st.bytes)}</td><td>${st.consumer_count}</td><td>${esc(c.storage)}</td><td>${esc(c.retention)}</td></tr>`;
          }).join("")}</tbody></table></div>` : `<p class="hint">No streams in this account.</p>`;
        } catch (e) { jsLoaded = false; $("#jacct").innerHTML = ""; $("#jgraph").innerHTML = ""; $("#jstreams").innerHTML = ""; status("#jst", "err", e.message); }
      }
      $("#jref").onclick = refreshJs;
      $("#jstreams").onclick = e => { const tr = e.target.closest("tr[data-s]"); if (tr) openStream(tr.dataset.s); };

      async function openStream(name) {
        const det = $("#jdet");
        det.innerHTML = `<div class="status">Loading ${esc(name)}…</div>`;
        try {
          const info = await api("STREAM.INFO." + name, { subjects_filter: ">" });
          const consumers = await paged("CONSUMER.LIST." + name, "consumers").catch(() => []);
          const st = info.state, subjects = st.subjects || {};
          const kvPrefix = name.startsWith("KV_") ? `$KV.${name.slice(3)}.` : "";
          const keys = Object.keys(subjects).sort();
          const nice = k => kvPrefix && k.startsWith(kvPrefix) ? k.slice(kvPrefix.length) : k;
          det.innerHTML = `<div class="dhead"><h2>${esc(name)}</h2>${kvPrefix ? '<span class="kb">KV bucket</span>' : ""}</div>
            ${DT.kv([["messages", st.messages.toLocaleString()], ["size", lib.bytesLabel(st.bytes)], ["first", `#${st.first_seq} · ${when(st.first_ts)}`], ["last", `#${st.last_seq} · ${when(st.last_ts)}`],
              ["subjects", String(st.num_subjects ?? keys.length)], ["deleted", String(st.num_deleted || 0)], ["consumers", String(st.consumer_count)], ...(info.cluster && info.cluster.leader ? [["leader", info.cluster.leader]] : [])])}
            <div class="two" style="margin-top:12px">
              <div class="chart" id="sg-subj"><h3>${kvPrefix ? "Revisions per key" : "Messages per subject"}</h3><p class="sub">Top 12. Click a bar to fetch the latest message.</p><div class="plot"></div></div>
              <div class="chart" id="sg-cons"><h3>Consumer backlog</h3><p class="sub">Messages pending delivery, and delivered but not yet acked.</p><div class="plot"></div></div>
            </div>
            <div class="two" style="margin-top:12px">
              <div class="col"><label class="l">${kvPrefix ? "Keys" : "Subjects"} (${keys.length.toLocaleString()}${st.num_subjects > keys.length ? " of " + st.num_subjects.toLocaleString() : ""})</label>
                <input type="search" class="mono" id="kf" placeholder="filter"><div class="tscroll" style="max-height:34vh"><table class="nl"><tbody id="klist"></tbody></table></div></div>
              <div class="col"><label class="l">Look up a message</label>
                <div class="opts"><label>Sequence <input type="number" id="gseq" min="1" class="mono" style="width:110px" value="${st.last_seq || 1}"></label><button class="btn" id="gseqb" type="button">Get</button></div>
                <div class="opts"><label>Last on subject <input type="text" id="gsub" class="mono" placeholder="${esc(keys[0] || "subject")}" style="width:220px"></label><button class="btn" id="gsubb" type="button">Get</button></div>
                <div class="status" id="gst"></div></div>
            </div>
            <div id="gmsg"></div>
            <div class="col" style="margin-top:12px"><label class="l">Consumers (${consumers.length})</label>${consumers.length ? `<div class="tscroll"><table class="kv"><thead><tr><th>Name</th><th>Filter</th><th>Ack policy</th><th>Deliver</th><th>Pending</th><th>Ack pending</th><th>Redelivered</th><th>Delivered #</th></tr></thead><tbody>${consumers.map(c => {
              const cf = c.config || {}, f = cf.filter_subject || (cf.filter_subjects || []).join(", ") || "all";
              return `<tr><td class="v">${esc(c.name)}</td><td class="v">${esc(f)}</td><td>${esc(cf.ack_policy || "")}</td><td>${esc(cf.deliver_policy || "")}</td><td>${(c.num_pending ?? 0).toLocaleString()}</td><td>${c.num_ack_pending ?? 0}</td><td>${c.num_redelivered ?? 0}</td><td>${c.delivered ? c.delivered.stream_seq : "-"}</td></tr>`;
            }).join("")}</tbody></table></div>` : '<div class="hint">None.</div>'}</div>
            <div class="col" style="margin-top:12px"><label class="l">Configuration</label><pre class="out" id="gcfg"></pre></div>`;
          det.querySelector("#gcfg").textContent = JSON.stringify(info.config, null, 2);

          const topKeys = keys.map(k => [k, subjects[k]]).sort((a, b) => b[1] - a[1]).slice(0, 12), sg = det.querySelector("#sg-subj");
          plotInto(sg, lib.chartBars(topKeys.map(([k, n]) => ({ label: nice(k), value: n, tip: `${nice(k)}: ${n.toLocaleString()}` })), { click: true, labelW: 190, w: 520, fmt: v => v.toLocaleString(), empty: "No subjects." }));
          lib.chartAttachTips(sg);
          sg.addEventListener("click", e => { const g = e.target.closest(".brow"); if (g) { const k = topKeys[+g.dataset.i][0]; det.querySelector("#gsub").value = k; get({ last_by_subj: k }); } });
          const sc = det.querySelector("#sg-cons"), cb = consumers.filter(c => (c.num_pending || 0) + (c.num_ack_pending || 0) > 0 || consumers.length <= 6);
          plotInto(sc, consumers.length ? lib.chartBars(cb.flatMap(c => [{ label: c.name + " · pending", value: c.num_pending || 0, color: lib.chartColors[0] }, { label: c.name + " · ack pending", value: c.num_ack_pending || 0, color: lib.chartColors[1] }]).slice(0, 14), { labelW: 190, w: 520, fmt: v => v.toLocaleString() }) : `<div class="hint" style="padding:12px 4px">No consumers on this stream.</div>`);
          lib.chartAttachTips(sc);

          const klist = det.querySelector("#klist");
          const drawKeys = () => {
            const f = det.querySelector("#kf").value.trim().toLowerCase();
            const shown = keys.filter(k => !f || k.toLowerCase().includes(f)).slice(0, 500);
            klist.innerHTML = shown.map(k => `<tr data-k="${esc(k)}"><td class="s">${esc(nice(k))}</td><td class="t">${subjects[k]}</td></tr>`).join("") || '<tr><td class="t">Nothing to show.</td></tr>';
          };
          drawKeys();
          det.querySelector("#kf").addEventListener("input", DT.debounce(drawKeys, 120));
          const get = async req => {
            const g = det.querySelector("#gst"), out = det.querySelector("#gmsg");
            out.innerHTML = ""; DT.status(g, "", "Fetching…");
            try {
              const r = await api("STREAM.MSG.GET." + name, req);
              const m = lib.natsStreamMsg(r.message);
              const op = m.headers.find(h => h[0] === "KV-Operation");
              DT.status(g, op ? "warn" : "ok", op ? `This key was ${op[1] === "DEL" ? "deleted" : op[1] === "PURGE" ? "purged" : op[1]} (marker message).` : `Message #${m.seq}.`);
              out.replaceChildren(detail(m));
            } catch (e) { DT.status(g, "err", e.errCode === 10037 ? "No such message." : e.message); }
          };
          klist.onclick = e => { const tr = e.target.closest("tr[data-k]"); if (tr) { det.querySelector("#gsub").value = tr.dataset.k; get({ last_by_subj: tr.dataset.k }); } };
          det.querySelector("#gseqb").onclick = () => get({ seq: +det.querySelector("#gseq").value });
          det.querySelector("#gsubb").onclick = () => get({ last_by_subj: det.querySelector("#gsub").value.trim() });
        } catch (e) { det.innerHTML = ""; status("#jst", "err", e.message); }
      }

      /* ----- start-up: use the schema from an earlier visit or the XSD explorer ----- */
      sp.start();
      draw(); drawGraphs(true);

      /* ----- reconnect to the last server when the page opens (only a connection that needed no credentials) ----- */
      let autoOn = true, noAuth = false;
      try { autoOn = localStorage.getItem("dt.nats.auto") !== "0"; noAuth = localStorage.getItem("dt.nats.noauth") === "1"; } catch (_) { /* storage blocked */ }
      $("#auto").checked = autoOn;
      $("#auto").onchange = e => { try { localStorage.setItem("dt.nats.auto", e.target.checked ? "1" : "0"); } catch (_) { /* storage blocked */ } };
      /* a message sent here by the Message Builder waits in the publisher */
      let pendingPub = false;
      if (lib.handoff && lib.handoff.kind === "xml") {
        const h = lib.handoff; lib.handoff = null; pendingPub = true;
        $("#psub").value = "uci.builder." + h.name; $("#pdata").value = h.text; $("#pfmt").value = "text"; $("#pmsg").value = h.name;
        status("#cst", "", "A message from the Message Builder is ready in the Publish tab. Connect to send it.");
      }
      if (remembered && autoOn && noAuth) connect();
    },
  });
})();
