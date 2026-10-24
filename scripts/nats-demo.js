// Feeds a NATS server with live traffic so the NATS Explorer has something to show:
// UCI XML messages (uci.<system>.<Message>, built from the schema, about 1 in 12 deliberately invalid), pub/sub subjects, request/reply services, JetStream streams with consumers, and KV buckets.
//   node scripts/nats-demo.js [ws://127.0.0.1:8080]     (Ctrl+C to stop; streams are left in place; see DOCS.md, "Running the demo environment")
const { lib } = require("../tests/harness");
const url = process.argv[2] || "ws://127.0.0.1:8080";
const TE = new TextEncoder(), TD = new TextDecoder();
const J = o => TE.encode(JSON.stringify(o));
const pick = a => a[Math.floor(Math.random() * a.length)];

(async () => {
  const c = new lib.NatsClient();
  c.onclose = r => { console.log("connection closed:", r); process.exit(1); };
  const info = await c.connect(url);
  console.log(`connected to ${info.server_name} ${info.version}`);

  const ensure = (name, cfg) => c.jsApi("STREAM.CREATE." + name, { name, ...cfg }).catch(e => { if (e.errCode !== 10058) throw e; });
  await ensure("ORDERS", { subjects: ["orders.>"], storage: "file", max_msgs: 5000 });
  await ensure("EVENTS", { subjects: ["events.>"], storage: "memory", max_age: 600e9, max_msgs: 2000 });
  await ensure("KV_config", { subjects: ["$KV.config.>"], storage: "file", max_msgs_per_subject: 10, allow_direct: true, allow_rollup_hdrs: true });
  await ensure("KV_sessions", { subjects: ["$KV.sessions.>"], storage: "memory", max_msgs_per_subject: 1, max_age: 1800e9, allow_direct: true });
  for (const [s, n, f] of [["ORDERS", "billing", "orders.created.>"], ["ORDERS", "shipping", "orders.shipped.>"], ["EVENTS", "audit", ">"]])
    await c.jsApi(`CONSUMER.CREATE.${s}.${n}`, { stream_name: s, config: { durable_name: n, ack_policy: "explicit", filter_subject: f === ">" ? undefined : f, ack_wait: 30e9 } }).catch(e => { if (e.errCode !== 10148) console.log(n, e.message); });

  // ---- UCI traffic generated from a real schema
  const { loadUciSchema, createUciGenerator, systems } = require("./uci-gen");
  const { model, dir, names: uciNames } = loadUciSchema(lib);
  console.log(`UCI schema: ${dir || "demo fixture"} (${model.elements.size} messages); publishing ${uciNames.join(", ")}`);
  const { uciMessage, positionMessage } = createUciGenerator(lib, model);
  await ensure("UCI", { subjects: ["uci.>"], storage: "file", max_msgs: 2000 });
  await ensure("KV_uci_registry", { subjects: ["$KV.uci_registry.>"], storage: "file", max_msgs_per_subject: 5, allow_direct: true });
  c.subscribe("svc.uci.status", m => { const [, id] = pick(systems); c.publish(m.reply, TE.encode(uciMessage(uciNames.includes("SystemStatus") ? "SystemStatus" : uciNames[0], id))); });

  // request/reply services
  c.subscribe("svc.time", m => c.publish(m.reply, J({ now: new Date().toISOString() })));
  c.subscribe("svc.echo", m => c.publish(m.reply, m.payload, { headers: [["Served-By", "nats-demo"]] }));
  c.subscribe("svc.sum.*", m => c.publish(m.reply, J({ op: m.subject.split(".")[2], result: JSON.parse(TD.decode(m.payload) || "[]").reduce((a, b) => a + b, 0) })));

  // a worker that pulls from the ORDERS consumers and acks most messages (leaves some pending/redelivered)
  async function work(consumer) {
    try {
      const m = await c.request(`$JS.API.CONSUMER.MSG.NEXT.ORDERS.${consumer}`, J({ batch: 1, expires: 1e9 }), { timeout: 3000 });
      if (m.reply && m.status !== 404 && m.status !== 408 && Math.random() < 0.8) c.publish(m.reply, TE.encode("+ACK"));
    } catch (_) { /* nothing to fetch */ }
  }

  const regions = ["us-east", "us-west", "eu", "apac"], users = ["ada", "grace", "linus", "ken", "margaret", "dennis"];
  const sensors = ["s1", "s2", "s3"], levels = ["info", "info", "info", "warn", "error"], svcs = ["api", "auth", "billing"];
  let n = 0;
  const every = (ms, f) => setInterval(() => f().catch(e => console.log(e.message)), ms);

  every(400, async () => { for (const s of sensors) c.publish(`sensors.${s}.temp`, J({ sensor: s, c: +(18 + Math.random() * 8).toFixed(2), t: Date.now() })); });
  every(1500, async () => { const svc = pick(svcs), lv = pick(levels); c.publish(`logs.${lv}.${svc}`, TE.encode(`${new Date().toISOString()} ${lv.toUpperCase()} ${svc}: ${pick(["request handled", "cache miss", "slow query", "retrying upstream", "token refreshed"])}`)); });
  every(2000, async () => {
    const id = ++n, region = pick(regions);
    c.publish(`orders.created.${region}`, J({ id, user: pick(users), total: +(Math.random() * 300).toFixed(2), items: 1 + Math.floor(Math.random() * 5) }), { headers: [["Nats-Msg-Id", "order-" + id], ["Trace-Id", Math.random().toString(16).slice(2, 10)]] });
    if (id > 3 && Math.random() < 0.6) c.publish(`orders.shipped.${region}`, J({ id: id - 3, carrier: pick(["ups", "dhl", "fedex"]) }));
  });
  every(3000, async () => { c.publish(`events.user.${pick(["login", "logout", "signup"])}`, J({ user: pick(users), at: new Date().toISOString() })); });
  every(1000, async () => { await work("billing"); await work("shipping"); });
  every(4000, async () => { await c.request(pick(["svc.time", "svc.echo"]), J({ hello: "world", n }), { timeout: 1000 }); await c.request("svc.sum.add", J([1, 2, 3, n]), { timeout: 1000 }); });

  // KV: config values change, sessions come and go
  const put = (b, k, v) => c.publish(`$KV.${b}.${k}`, typeof v === "string" ? TE.encode(v) : J(v));
  const del = (b, k) => c.publish(`$KV.${b}.${k}`, new Uint8Array(0), { headers: [["KV-Operation", "DEL"]] });
  put("config", "app.name", "dev-tools"); put("config", "feature.flags", { newUi: true, beta: false }); put("config", "db.url", "postgres://db.internal:5432/app");
  every(5000, async () => { put("config", "app.mode", pick(["dev", "staging", "prod"])); put("config", "rate.limit", String(50 + Math.floor(Math.random() * 100))); put("config", "feature.flags", { newUi: Math.random() < 0.5, beta: Math.random() < 0.3 }); });
  every(3500, async () => { const u = pick(users); put("sessions", u, { user: u, token: Math.random().toString(36).slice(2), ip: `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}` }); if (Math.random() < 0.3) del("sessions", pick(users)); });

  every(900, async () => { const [sys, id] = pick(systems), name = pick(uciNames); c.publish(`uci.${sys}.${name}`, TE.encode(uciMessage(name, id, { broken: Math.random() < 0.08 }))); });
  every(6000, async () => { const [sys, id] = pick(systems); put("uci_registry", sys, uciMessage(uciNames[0], id)); });
  every(5000, async () => { await c.request("svc.uci.status", new Uint8Array(0), { timeout: 2000 }); });

  // moving systems for the Traffic Lab map: each publishes a PositionReport every second along a wandering course (angles in radians, as UCI stores them)
  if (model.elements.has("PositionReport")) {
    const fleet = [["alpha", 34.05, -118.24], ["bravo", 40.71, -74.0], ["charlie", 51.5, -0.12], ["delta", 35.68, 139.69], ["echo", -33.87, 151.21], ["foxtrot", 25.2, 55.27]]
      .map(([name, lat, lon], i) => ({ name, lat, lon, hdg: Math.random() * 6.28, id: `123e4567-e89b-12d3-a456-4266141740${(0xd0 + i).toString(16)}`, alt: 3000 + i * 1500 }));
    every(1000, async () => {
      for (const f of fleet) {
        f.hdg += (Math.random() - 0.5) * 0.5; const step = 0.04 + Math.random() * 0.02;
        f.lat = Math.max(-80, Math.min(80, f.lat + Math.cos(f.hdg) * step)); f.lon += Math.sin(f.hdg) * step / Math.max(0.2, Math.cos(f.lat * Math.PI / 180));
        c.publish(`uci.${f.name}.PositionReport`, TE.encode(positionMessage(f.id, f.lat * Math.PI / 180, f.lon * Math.PI / 180, f.alt)));
      }
    });
  }

  console.log("publishing… open toolbox.html#nats and connect to the WebSocket URL; Ctrl+C to stop");
  await new Promise(() => {});
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
