// A small LA-CAL server speaking the OMS WebSocket Protocol (OWP 1.0, OMSC-SPC-013), with no dependencies. For trying the CAL
// Explorer without a real platform, and for the tests. It enforces the protocol rules (INIT first, token formats, allowed topics,
// message names, schema validation of published messages, subscription groups) and can generate UCI traffic for subscribers.
//
//   node scripts/owp-mock-server.js [--port 9000] [--schema 002.6.0] [--service DemoService] [--interval 1000]
//   node scripts/owp-mock-server.js --nats ws://127.0.0.1:8080       serve the UCI messages found on a NATS server instead of generating them
//
// Topics served by the standalone server (topic -> message): sys.status -> SystemStatus, sys.subsystem -> SubsystemStatus,
// mission.plan -> MissionPlan, mission.plan.status -> MissionPlanStatus, entity.metadata -> EntityMetadata.
// With --nats, every NATS subject uci.<system>.<Message> whose payload is a UCI XML message of the loaded schema becomes an OWP topic
// of the same name (e.g. uci.alpha.SystemStatus carrying SystemStatus), and each message is delivered to subscribers as OMS JSON.
// The bridge is read-only: nothing published by an OWP client reaches NATS, and non-UCI subjects are ignored.
// INFO carries the topic list in a non-standard "x_topics" key (and is re-sent when a topic is added) so the CAL Explorer can subscribe to everything.
const net = require("net"), crypto = require("crypto");

const TOKEN = /^[A-Za-z0-9_\-.]+$/;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text) {
  const p = Buffer.from(text, "utf8"), n = p.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, p]);
}

/* options: { port, host, lib, model, schemaVersion, services, versions, topics:[{name,message}], generate(messageName)->jsonText, interval, log } */
function start(o = {}) {
  const lib = o.lib, model = o.model || null;
  const cfg = { schemaVersion: "002.6.0", services: ["DemoService"], versions: ["1.0"], interval: 0, topics: [], ...o };
  const conns = new Set(), stats = { frames: 0, published: 0 };
  let rr = 0;

  function deliver(topic, message, jsonText, except) {
    const groups = new Map();
    for (const c of conns) for (const s of c.subs.values()) {
      if (s.topic !== topic || s.message !== message || c === except) continue;
      if (!s.group) c.send(`MSG ${s.id} ${jsonText}`);
      else { const k = s.group; (groups.get(k) || groups.set(k, []).get(k)).push([c, s]); }
    }
    for (const list of groups.values()) { const [c, s] = list[rr++ % list.length]; c.send(`MSG ${s.id} ${jsonText}`); }
  }

  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0), upgraded = false, open = true;
    const c = {
      subs: new Map(), init: false,
      send: t => { if (open) sock.write(frame(t)); },
      close: () => { if (open) { open = false; sock.write(Buffer.from([0x88, 0])); sock.end(); } },
    };
    conns.add(c);
    sock.on("error", () => {});
    sock.on("close", () => { open = false; conns.delete(c); });
    sock.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n"); if (end < 0) return;
        const head = buf.slice(0, end).toString("latin1"); buf = buf.slice(end + 4);
        const h = Object.fromEntries(head.split("\r\n").slice(1).map(l => { const i = l.indexOf(":"); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; }));
        const protos = (h["sec-websocket-protocol"] || "").split(",").map(x => x.trim());
        if (!/websocket/i.test(h.upgrade || "") || !h["sec-websocket-key"] || !protos.includes("owp")) {
          const why = !protos.includes("owp") ? "Missing or unsupported Sec-WebSocket-Protocol (expected owp)" : "Bad WebSocket handshake";
          sock.end(`HTTP/1.1 400 Bad Request\r\nContent-Length: ${why.length}\r\nConnection: close\r\n\r\n${why}`); return;
        }
        const accept = crypto.createHash("sha1").update(h["sec-websocket-key"] + GUID).digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: owp\r\n\r\n`);
        upgraded = true;
      }
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15, masked = !!(buf[1] & 128); let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + (masked ? 4 : 0) + len) return;
        const mask = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
        const payload = Buffer.from(buf.slice(off, off + len)); buf = buf.slice(off + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        if (op === 8) { c.close(); return; }
        if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
        if (op === 1) { stats.frames++; if (cfg.log) cfg.log("in", payload.toString("utf8")); handle(c, payload.toString("utf8")); }
      }
    });
  });

  /* INFO. The topic list is a non-standard extension ("x_topics"): OWP cannot list topics, but a client that knows the key can subscribe to all of them. */
  const infoText = c => "INFO " + JSON.stringify({ ...c.base, x_topics: cfg.topics });
  const err = (c, code, close) => { c.send("-ERR " + code); if (close) c.close(); };
  const topicDef = name => cfg.topics.find(t => t.name === name);

  function handle(c, text) {
    const m = /^[ \t]*(\S+)(?:[ \t]+([\s\S]*))?$/.exec(text);
    if (!m) return err(c, "Illegal-Operation");
    const op = m[1], rest = m[2] || "";
    if (op === "INIT") {
      if (c.init) return err(c, "Illegal-State", true);
      let j; try { j = JSON.parse(rest); } catch (_) { return err(c, "Illegal-Argument", true); }
      if (!Array.isArray(j.versions) || !j.versions.some(v => cfg.versions.includes(v))) return err(c, "Unsupported-Version", true);
      if (j.schema !== cfg.schemaVersion) return err(c, "Unsupported-Schema", true);
      if (!cfg.services.includes(j.service_id)) return err(c, "Unsupported-Service", true);
      c.init = true; c.verbose = j.verbose !== false;
      if (c.verbose) c.send("+OK");
      c.base = { version: cfg.versions.find(v => j.versions.includes(v)), server_id: "mock-owp-1", uuids: { system: "123e4567-e89b-12d3-a456-4266141740a1", service: crypto.randomUUID(), capabilities: { Demo: crypto.randomUUID() } }, system_label: "MOCK-SYSTEM" };
      c.send(infoText(c));
      return;
    }
    if (!c.init) return err(c, "Illegal-State", true);
    const ok = () => { if (c.verbose) c.send("+OK"); };
    if (op === "SUB") {
      const a = rest.trim().split(/[ \t]+/);
      if (a.length < 3 || a.length > 4 || !TOKEN.test(a[0]) || !TOKEN.test(a[2]) || (a[3] && !TOKEN.test(a[3]))) return err(c, "Illegal-Argument");
      const name = a[1].replace(/^\{[^}]*\}/, "");
      if (model && !model.elements.has(name)) return err(c, "Illegal-Argument");
      const t = topicDef(a[2]);
      if (!t || c.subs.has(a[0])) return err(c, "Illegal-State");
      if (t.message !== name) return err(c, "Illegal-Argument");
      c.subs.set(a[0], { id: a[0], message: name, topic: a[2], group: a[3] || "" });
      return ok();
    }
    if (op === "UNSUB") {
      const id = rest.trim();
      if (!TOKEN.test(id)) return err(c, "Illegal-Argument");
      if (!c.subs.delete(id)) return err(c, "Illegal-State");
      return ok();
    }
    if (op === "PUB") {
      const r = /^(\S+)[ \t]+([\s\S]+)$/.exec(rest.trim());
      if (!r || !TOKEN.test(r[1])) return err(c, "Illegal-Argument");
      const t = topicDef(r[1]);
      if (!t) return err(c, "Illegal-State");
      let name;
      try { const j = JSON.parse(r[2]); const keys = j && typeof j === "object" && !Array.isArray(j) ? Object.keys(j) : []; if (keys.length !== 1) throw 0; name = keys[0].replace(/^\{[^}]*\}/, ""); } catch (_) { return err(c, "Invalid-Message"); }
      if (name !== t.message) return err(c, "Invalid-Message");
      if (model && lib && !lib.owpValidate(model, r[2]).ok) return err(c, "Invalid-Message");
      ok(); stats.published++;
      deliver(r[1], name, r[2], null);
      return;
    }
    err(c, "Illegal-Operation");
  }

  let timer = 0;
  if (cfg.interval && cfg.generate) {
    timer = setInterval(() => {
      for (const t of cfg.topics) {
        const wanted = [...conns].some(c => [...c.subs.values()].some(s => s.topic === t.name));
        if (wanted) { try { deliver(t.name, t.message, cfg.generate(t.message), null); stats.published++; } catch (_) { /* generation failed for this message */ } }
      }
    }, cfg.interval);
  }

  return new Promise(res => server.listen(cfg.port || 0, cfg.host || "127.0.0.1", () => res({
    port: server.address().port, stats, conns,
    topics: cfg.topics,                                                  // mutable: a bridge can add topics as subjects appear
    deliver: (topic, message, jsonText) => deliver(topic, message, jsonText, null),
    addTopic(t) { cfg.topics.push(t); for (const c of conns) if (c.init) c.send(infoText(c)); },          // a changed topic list is announced with another INFO
    close: () => { clearInterval(timer); for (const c of conns) c.close(); server.close(); },
  })));
}

module.exports = { start };

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
  const { lib } = require("../tests/harness");
  const { loadUciSchema, createUciGenerator, systems } = require("./uci-gen");
  const { model, dir, names } = loadUciSchema(lib);
  const natsUrl = arg("nats", "");
  const schemaVersion = arg("schema", lib.schemaVersion(model) || "002.6.0"), service = arg("service", "DemoService");
  let topics, generate = null;
  if (natsUrl) {
    topics = [];                                                         // filled from NATS: seeded with the demo subjects, extended as new ones appear
    for (const [sys] of systems) for (const message of names) topics.push({ name: `uci.${sys}.${message}`, message });
  } else {
    const { uciMessage } = createUciGenerator(lib, model);
    topics = (dir
      ? [["sys.status", "SystemStatus"], ["sys.subsystem", "SubsystemStatus"], ["mission.plan", "MissionPlan"], ["mission.plan.status", "MissionPlanStatus"], ["entity.metadata", "EntityMetadata"]]
      : [["demo.status", "StatusReport"]]).filter(([, m]) => model.elements.has(m)).map(([name, message]) => ({ name, message }));
    generate = message => lib.owpXmlToJson(model, uciMessage(message, systems[Math.floor(Math.random() * systems.length)][1]));
  }
  start({ port: +arg("port", 9000), lib, model, topics, schemaVersion, services: [service], interval: natsUrl ? 0 : +arg("interval", 1000), generate }).then(async server => {
    console.log(`OWP mock server on ws://127.0.0.1:${server.port}  schema "${schemaVersion}"  service "${service}"`);
    if (!natsUrl) return console.log("topics: " + topics.map(t => t.name + " -> " + t.message).join(", "));
    const nc = new lib.NatsClient(), seen = { bridged: 0, skipped: 0, topics: new Set() };
    nc.onclose = r => { console.log("NATS connection closed: " + r); process.exit(1); };
    await nc.connect(natsUrl);
    const rootOf = text => { const m = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?([\w.-]+)/.exec(text); return m ? m[1] : ""; };
    nc.subscribe("uci.>", m => {
      const text = new TextDecoder().decode(m.payload), message = rootOf(text);
      if (!message || !model.elements.has(message) || !lib.owpToken.test(m.subject)) { seen.skipped++; return; }
      let json; try { json = lib.owpXmlToJson(model, text); } catch (_) { seen.skipped++; return; }      // XML that cannot be mapped at all
      let t = server.topics.find(x => x.name === m.subject);
      if (!t) { t = { name: m.subject, message }; server.addTopic(t); }
      if (t.message !== message) { seen.skipped++; return; }
      seen.bridged++; seen.topics.add(m.subject);
      server.deliver(m.subject, message, json);
    });
    console.log(`bridging UCI messages from ${natsUrl} (subject uci.>); topics are the NATS subjects, e.g. ${topics[0].name}`);
    setInterval(() => console.log(`bridged ${seen.bridged} messages on ${seen.topics.size} topics (${seen.skipped} skipped)`), 30000).unref();
  });
}
