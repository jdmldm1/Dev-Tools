/* OMS Language-Agnostic CAL (OMSC-SPC-013): the OMS WebSocket Protocol (OWP 1.0) client and the OMS JSON message format.
   Pure functions on DT.lib, no DOM. OMS JSON is mapped to and from XML with the loaded schema, so the XSD validator and
   the decoded-message view work on CAL messages too. Numbers are kept as their original text (64-bit values survive). */
(function () {
  const lib = DT.lib;
  const local = n => n.replace(/^\{[^}]*\}/, "").replace(/^[^:]+:/, "");
  const XSI = "http://www.w3.org/2001/XMLSchema-instance";
  const TOKEN = /^[A-Za-z0-9_\-.]+$/, MSGNAME = /^(\{[^{}\s]+\})?[A-Za-z_][\w.\-]*$/;
  lib.owpToken = TOKEN; lib.owpMessageName = MSGNAME;

  /* ---------- lossless JSON ---------- */
  /* Objects are Maps (order kept), numbers are Num (raw text), the rest are plain JS values. */
  class Num { constructor(raw) { this.raw = raw; } toString() { return this.raw; } }
  lib.OwpNum = Num;

  lib.owpParseJson = function (text) {
    let i = 0;
    const fail = (msg, at = i) => { const b = text.slice(0, at).split("\n"); const e = new Error(`${msg} (line ${b.length}, column ${b[b.length - 1].length + 1})`); e.line = b.length; e.col = b[b.length - 1].length + 1; throw e; };
    const ws = () => { while (i < text.length && " \t\r\n".includes(text[i])) i++; };
    function value() {
      ws();
      const c = text[i];
      if (c === "{") {
        i++; const m = new Map(); ws();
        if (text[i] === "}") { i++; return m; }
        for (;;) {
          ws(); if (text[i] !== '"') fail("Expected a member name in double quotes");
          const k = str(); ws(); if (text[i] !== ":") fail("Expected ':' after the member name"); i++;
          if (m.has(k)) fail(`Duplicate member "${k}"`);
          m.set(k, value()); ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "}") { i++; return m; }
          fail("Expected ',' or '}'");
        }
      }
      if (c === "[") {
        i++; const a = []; ws();
        if (text[i] === "]") { i++; return a; }
        for (;;) {
          a.push(value()); ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "]") { i++; return a; }
          fail("Expected ',' or ']'");
        }
      }
      if (c === '"') return str();
      if (text.startsWith("true", i)) { i += 4; return true; }
      if (text.startsWith("false", i)) { i += 5; return false; }
      if (text.startsWith("null", i)) { i += 4; return null; }
      const m = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y; m.lastIndex = i;
      const r = m.exec(text);
      if (!r) fail(i >= text.length ? "Unexpected end of JSON" : "Unexpected character " + JSON.stringify(c));
      i += r[0].length; return new Num(r[0]);
    }
    function str() {
      const start = i; i++; let out = "";
      for (;;) {
        if (i >= text.length) fail("Unterminated string", start);
        const c = text[i++];
        if (c === '"') return out;
        if (c === "\\") {
          const e = text[i++];
          if (e === "u") { const h = text.slice(i, i + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("Bad \\u escape"); out += String.fromCharCode(parseInt(h, 16)); i += 4; }
          else if (e in { '"': 1, "\\": 1, "/": 1 }) out += e;
          else if (e === "b") out += "\b"; else if (e === "f") out += "\f"; else if (e === "n") out += "\n"; else if (e === "r") out += "\r"; else if (e === "t") out += "\t";
          else fail("Bad escape \\" + e);
        } else if (c < " ") fail("Control character in string", i - 1);
        else out += c;
      }
    }
    const v = value(); ws();
    if (i < text.length) fail("Unexpected content after the JSON value");
    return v;
  };

  /* Back to text. indent: number of spaces, or undefined for compact output. */
  lib.owpStringify = function (v, indent) {
    const nl = d => indent === undefined ? "" : "\n" + " ".repeat(indent * d), sep = indent === undefined ? ":" : ": ";
    const go = (x, d) => {
      if (x instanceof Num) return x.raw;
      if (x === null || typeof x === "boolean") return String(x);
      if (typeof x === "string") return JSON.stringify(x);
      if (Array.isArray(x)) return x.length ? "[" + x.map(y => nl(d + 1) + go(y, d + 1)).join(",") + nl(d) + "]" : "[]";
      if (x instanceof Map) return x.size ? "{" + [...x].map(([k, y]) => nl(d + 1) + JSON.stringify(k) + sep + go(y, d + 1)).join(",") + nl(d) + "}" : "{}";
      return JSON.stringify(x);
    };
    return go(v, 0);
  };

  /* ---------- schema mapping ---------- */
  const NUMERIC = new Set("byte short int long integer nonNegativeInteger positiveInteger nonPositiveInteger negativeInteger unsignedByte unsignedShort unsignedInt unsignedLong decimal float double".split(" "));
  const FLOATY = new Set(["float", "double"]);
  const builtinOf = (model, typeName) => typeName ? lib.xsdSimpleInfo(model, typeName).builtin : "string";
  const isComplex = (model, typeName) => { const t = model.types.get(typeName); return !!t && t.kind === "complex" && !t.simpleContent; };
  const escText = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = s => escText(s).replace(/"/g, "&quot;");
  const tnsOf = (model, decl) => { const f = model.files.find(x => x.name === decl.file); return f ? f.targetNamespace : ""; };

  /* OMS JSON text -> XML text (schema order, repeated members from arrays, "$type" as xsi:type). Throws with a message when the
     JSON is malformed or the message is not a global element. Unknown members are kept so the validator can report them. */
  lib.owpJsonToXml = function (model, jsonText) {
    const v = lib.owpParseJson(jsonText);
    if (!(v instanceof Map) || v.size !== 1) throw new Error("An OMS JSON message is an object with exactly one member: the message name.");
    const [[key, body]] = [...v];
    const decl = model.elements.get(local(key));
    if (!decl) { const e = new Error(`"${key}" is not a message (global element) in the loaded schema.`); e.suggest = lib.uciSuggest(model, local(key)); throw e; }
    const ns = key.startsWith("{") ? key.slice(1, key.indexOf("}")) : tnsOf(model, decl);
    const out = [];
    function emit(name, val, typeName, depth, nsAttr) {
      const pad = "  ".repeat(depth), attrs = nsAttr ? ` xmlns="${escAttr(nsAttr)}"` : "";
      if (val instanceof Map) {
        let tn = typeName, xt = "";
        const dt = val.get("$type");
        if (typeof dt === "string") { const l = local(dt); if (model.types.has(l)) { tn = l; xt = ` xsi:type="${escAttr(l)}"`; } }
        const kids = [];
        const members = isComplex(model, tn) ? lib.xsdMembers(model, tn).filter(m => m.kind === "element") : [];
        const seen = new Set();
        const sub = (nm, child, memberType) => {
          const arr = Array.isArray(child) ? child : [child];
          for (const c of arr) kids.push([nm, c, memberType]);
        };
        for (const m of members) if (val.has(m.name) && !seen.has(m.name)) { seen.add(m.name); sub(m.name, val.get(m.name), m.type); }
        for (const [k, c] of val) if (k !== "$type" && !seen.has(k)) sub(k, c, "");
        if (!kids.length) { out.push(`${pad}<${name}${attrs}${xt}/>`); return; }
        out.push(`${pad}<${name}${attrs}${xt}>`);
        for (const [k, c, mt] of kids) {
          if (k.startsWith("{")) emit(local(k), c, "", depth + 1, k.slice(1, k.indexOf("}")));
          else emit(k, c, mt, depth + 1, "");
        }
        out.push(`${pad}</${name}>`);
      } else if (Array.isArray(val)) {
        for (const c of val) emit(name, c, typeName, depth, nsAttr);
      } else {
        let text = val instanceof Num ? val.raw : val === null ? "" : String(val);
        if (typeof val === "string" && FLOATY.has(builtinOf(model, typeName))) text = { Infinity: "INF", "-Infinity": "-INF" }[val] || val;
        out.push(`${pad}<${name}${attrs}>${escText(text)}</${name}>`);
      }
    }
    // the root declares the namespace and xsi; children inherit the default namespace
    const mark = out.length;
    emit(local(key), body, decl.type, 0, ns);
    out[mark] = out[mark].replace(/^(\s*<[^\s>/]+)/, `$1 xmlns:xsi="${XSI}"`);
    return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n${out.join("\n")}`, name: local(key), decl };
  };

  /* XML message (text) -> OMS JSON value (Map tree). Members that can repeat become arrays; xsi:type becomes "$type". */
  lib.owpXmlToJsonValue = function (model, xmlText) {
    const tree = lib.xmlParse(xmlText), root = tree.root, decl = model.elements.get(local(root.name));
    if (!decl) throw new Error(`<${root.name}> is not a message (global element) in the loaded schema.`);
    function conv(el, typeName) {
      const kids = el.kids.filter(k => k.t === "el");
      const xt = el.attrs.find(([k, v]) => /:type$/.test(k) && model.types.has(local(v)));
      const tn = xt ? local(xt[1]) : typeName;
      if (!kids.length && !isComplex(model, tn)) {
        const text = el.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join("");
        const b = builtinOf(model, tn), t = text.trim();
        if (b === "boolean") return t === "true" || t === "1";
        if (NUMERIC.has(b) && t !== "") {
          if (FLOATY.has(b) && /^(NaN|-?INF)$/.test(t)) return t === "NaN" ? "NaN" : t === "INF" ? "Infinity" : "-Infinity";
          return new Num(t.replace(/^\+/, ""));
        }
        return text;
      }
      const m = new Map();
      if (xt) m.set("$type", local(xt[1]));
      const members = isComplex(model, tn) ? lib.xsdMembers(model, tn).filter(x => x.kind === "element") : [];
      const def = new Map(members.map(x => [x.name, x]));
      for (const k of kids) {
        const ln = local(k.name), d = def.get(ln), key = k.attrs.some(([a, v]) => a === "xmlns" && v !== (model.files[0] || {}).targetNamespace) && !d ? "{" + k.attrs.find(([a]) => a === "xmlns")[1] + "}" + ln : ln;
        const val = conv(k, d ? d.type : "");
        if (d && d.max > 1) { if (!m.has(key)) m.set(key, []); m.get(key).push(val); }
        else m.set(key, val);
      }
      return m;
    }
    return new Map([[decl.name, conv(root, decl.type)]]);
  };
  lib.owpXmlToJson = (model, xmlText, indent) => lib.owpStringify(lib.owpXmlToJsonValue(model, xmlText), indent);

  /* Validate OMS JSON text against the schema. -> { ok, errors:[{message,path}], xml } (errors are XML-based, so they carry paths, not JSON positions). */
  lib.owpValidate = function (model, jsonText) {
    let conv;
    try { conv = lib.owpJsonToXml(model, jsonText); }
    catch (e) { return { ok: false, errors: [{ message: e.message, path: "", line: e.line, col: e.col }], xml: "", suggest: e.suggest }; }
    const v = lib.xsdValidate(model, conv.xml);
    return { ok: v.ok, errors: v.errors, xml: conv.xml, name: conv.name, truncated: v.truncated };
  };

  /* ---------- OWP frames ---------- */
  lib.owpInit = ({ versions, schema, serviceId, verbose = true }) => "INIT " + JSON.stringify({ versions, schema, service_id: serviceId, verbose });
  lib.owpSub = (id, messageName, topic, group) => `SUB ${id} ${messageName} ${topic}${group ? " " + group : ""}`;
  lib.owpUnsub = id => "UNSUB " + id;
  lib.owpPub = (topic, jsonText) => `PUB ${topic} ${lib.owpStringify(lib.owpParseJson(jsonText))}`;      // compact: one WebSocket message, no stray newlines

  /* One server frame -> { op, ... }. Throws on anything that is not a server operation. */
  lib.owpParse = function (frame) {
    const m = /^[ \t]*(\S+)(?:[ \t]+([\s\S]*))?$/.exec(frame);
    if (!m) throw new Error("empty frame");
    const op = m[1], rest = (m[2] || "").replace(/[ \t\r\n]+$/, "");
    if (op === "+OK") return { op };
    if (op === "-ERR") { const e = /^(\S+)(?:[ \t]+([\s\S]*))?$/.exec(rest); return { op, error: e ? e[1] : "", details: e && e[2] || "" }; }
    if (op === "INFO") { try { return { op, info: JSON.parse(rest) }; } catch (e) { throw new Error("INFO is not valid JSON: " + e.message); } }
    if (op === "MSG") { const r = /^(\S+)[ \t]+([\s\S]+)$/.exec(rest); if (!r) throw new Error("MSG needs a subscription id and a message"); return { op, sid: r[1], text: r[2] }; }
    throw new Error("unexpected operation " + JSON.stringify(op.slice(0, 20)));
  };

  const HELP = {
    "Unsupported-Version": "The server supports none of the OWP versions requested (try 1.0).",
    "Unsupported-Schema": "The server does not support that schema version. Use the version string from the server's configuration (the version attribute of its UCI schema, e.g. 002.6.0).",
    "Unsupported-Service": "The server does not know that service identifier. It must be one configured on the server.",
    "Illegal-Operation": "The server did not recognise the operation.",
    "Illegal-Argument": "Malformed argument: a token with characters outside A-Z a-z 0-9 _ - . , a message name that is not a global element of the server's schema, or a message type the topic does not carry.",
    "Illegal-State": "Not allowed in the current state: usually a topic that is not enabled for this service on the server, a duplicate subscription id, or INIT out of order.",
    "Internal-Error": "The server hit an internal error.",
    "Invalid-Message": "The message is not valid against the server's schema.",
  };
  lib.owpErrorHelp = code => HELP[code] || "";

  /* Topics a server advertises in INFO (non-standard key "x_topics": [{ name, message }]; OWP itself cannot list them). */
  lib.owpAdvertisedTopics = info => (info && Array.isArray(info.x_topics) ? info.x_topics : []).filter(t => t && TOKEN.test(t.name || "") && MSGNAME.test(t.message || ""));

  /* Find which (topic, message) pairs a server accepts by trying them: OWP has no wildcard and no listing, but a SUB is acknowledged
     or refused per pair, so the pairs that succeed are the answer (and stay subscribed). Messages are tried in pipelined batches
     (acknowledgments arrive in order). With stopAtFirst a topic is finished after the first batch with a match. Messages whose names
     resemble the topic's words are tried first. -> { found: [sub], tried, cancelled? } */
  lib.owpDiscover = async function (client, topics, messages, { stopAtFirst = true, batch = 100, onProgress, isCancelled } = {}) {
    const found = []; let tried = 0;
    for (const topic of topics) {
      const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
      const score = m => { const l = m.toLowerCase(); return words.reduce((n, w) => n + (l.includes(w) ? 1 : 0), 0); };
      const order = messages.map((m, i) => [m, i]).sort((a, b) => score(b[0]) - score(a[0]) || a[1] - b[1]).map(x => x[0]);
      for (let i = 0; i < order.length; i += batch) {
        if (isCancelled && isCancelled()) return { found, tried, cancelled: true };
        const chunk = order.slice(i, i + batch);
        const results = await Promise.all(chunk.map(m => client.subscribe(m, topic).then(s => s, () => null)));
        tried += chunk.length;
        const ok = results.filter(Boolean); found.push(...ok);
        if (onProgress) onProgress({ topic, tried, found: found.length });
        if (stopAtFirst && ok.length) break;
      }
    }
    return { found, tried };
  };

  /* ---------- client ---------- */
  /* opts.WebSocket injects a socket class (tests). Acknowledgments (+OK / -ERR) answer client operations in order, so every
     operation waits in a queue; the connection is always verbose so each one is acknowledged. */
  lib.OwpClient = class {
    constructor(opts = {}) {
      this.WS = opts.WebSocket || globalThis.WebSocket;
      this.ws = null; this.info = null; this.connected = false;
      this.subs = new Map(); this.pending = []; this.seq = 0;
      this.onmsg = null; this.onclose = null; this.onerror = null; this.oninfo = null; this.onframe = null;
    }
    connect(url, init, timeout = 6000) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = err => { if (settled) return; settled = true; clearTimeout(timer); if (err) { this.close(); reject(err); } else resolve(this.info); };
        const timer = setTimeout(() => done(new Error("Timed out waiting for INFO. Check the service id, schema version and OWP version; some servers fail the connection without an error.")), timeout);
        let ws;
        try { ws = new this.WS(url, "owp"); } catch (e) { return done(e); }
        this.ws = ws;
        ws.onopen = () => {
          if (ws !== this.ws) return;
          if (ws.protocol !== "owp") return done(new Error(`The server did not select the "owp" subprotocol${ws.protocol ? " (it chose " + JSON.stringify(ws.protocol) + ")" : ""}.`));
          this._send(lib.owpInit({ ...init, verbose: true }));
        };
        ws.onmessage = e => {
          if (ws !== this.ws) return;
          const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
          if (this.onframe) this.onframe("in", text);
          let op; try { op = lib.owpParse(text); } catch (err) { if (!settled) return done(err); if (this.onerror) this.onerror(err.message); return; }
          if (!this.connected) {
            if (op.op === "INFO") { this.info = op.info; this.connected = true; done(); }
            else if (op.op === "-ERR") done(new Error(`${op.error}${op.details ? " " + op.details : ""}. ${lib.owpErrorHelp(op.error)}`.trim()));
            return;                                                                      // +OK before INFO on a verbose connection
          }
          this._op(op);
        };
        ws.onerror = () => { if (ws === this.ws && !settled) done(new Error("Could not open a WebSocket to " + url + " (is the URL right, and does the server accept the owp subprotocol?)")); };
        ws.onclose = e => {
          if (ws !== this.ws) return;
          if (!settled) return done(new Error("The server closed the connection before sending INFO" + (e && e.reason ? ": " + e.reason : "") + ". It fails the connection on an unsupported version, schema version or service id."));
          this.close();
          if (this.onclose) this.onclose((e && e.reason) || "connection closed");
        };
      });
    }
    _op(op) {
      if (op.op === "INFO") { this.info = op.info; if (this.oninfo) this.oninfo(op.info); }
      else if (op.op === "MSG") { const s = this.subs.get(op.sid); if (s && this.onmsg) this.onmsg({ sub: s, sid: op.sid, text: op.text }); }
      else if (op.op === "+OK") { const p = this.pending.shift(); if (p) { clearTimeout(p.timer); p.resolve(); } }
      else if (op.op === "-ERR") {
        const p = this.pending.shift(), err = new Error(`${op.error}${op.details ? " " + op.details : ""}`); err.code = op.error; err.help = lib.owpErrorHelp(op.error);
        if (p) { clearTimeout(p.timer); p.reject(err); } else if (this.onerror) this.onerror(`${err.message}: ${err.help}`);
      }
    }
    _send(text) {
      if (!this.ws || this.ws.readyState !== 1) throw new Error("Not connected.");
      if (this.onframe) this.onframe("out", text);
      this.ws.send(text);
    }
    _request(frame, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const p = { resolve, reject, timer: setTimeout(() => { this.pending = this.pending.filter(x => x !== p); reject(new Error("No acknowledgment from the server within " + timeout / 1000 + " s.")); }, timeout) };
        this.pending.push(p);
        try { this._send(frame); } catch (e) { clearTimeout(p.timer); this.pending = this.pending.filter(x => x !== p); reject(e); }
      });
    }
    async subscribe(messageName, topic, group) {
      if (!MSGNAME.test(messageName)) throw new Error("Message name must be a global element name, or {namespace}name.");
      if (!TOKEN.test(topic)) throw new Error("Topic may only contain A-Z a-z 0-9 _ - .");
      if (group && !TOKEN.test(group)) throw new Error("Group may only contain A-Z a-z 0-9 _ - .");
      const id = "s" + (++this.seq), sub = { id, messageName, topic, group: group || "" };
      this.subs.set(id, sub);                                                            // a MSG can arrive before the +OK
      try { await this._request(lib.owpSub(id, messageName, topic, group)); } catch (e) { this.subs.delete(id); throw e; }
      return sub;
    }
    async unsubscribe(id) { await this._request(lib.owpUnsub(id)); this.subs.delete(id); }
    publish(topic, jsonText) {
      if (!TOKEN.test(topic)) return Promise.reject(new Error("Topic may only contain A-Z a-z 0-9 _ - ."));
      let frame; try { frame = lib.owpPub(topic, jsonText); } catch (e) { return Promise.reject(e); }
      return this._request(frame);
    }
    close() {
      const ws = this.ws; this.ws = null; this.connected = false; this.subs.clear();
      for (const p of this.pending) { clearTimeout(p.timer); p.reject(new Error("Connection closed.")); }
      this.pending = [];
      try { if (ws) ws.close(); } catch (_) { /* already closed */ }
    }
  };
})();
