// Load generator: publishes to a NATS server over plain TCP as fast as asked, to see how the NATS Explorer copes.
//   node scripts/nats-blast.js <msgs-per-second | max> <seconds> [json|json1k|xml|many] [port] [host]
// json: ~45 B on 5 subjects, json1k: ~1 KB, xml: a ~900 B UCI SystemStatus on uci.*, many: ~45 B spread over 50,000 subjects.
const net = require("net");
const [rateArg, secArg, kindArg, portArg, hostArg] = process.argv.slice(2);
if (!rateArg || !secArg) { console.error("usage: node scripts/nats-blast.js <msgs/s | max> <seconds> [json|json1k|xml|many] [port] [host]"); process.exit(2); }
const kind = kindArg || "json", rate = rateArg === "max" ? Infinity : +rateArg, seconds = +secArg, port = +(portArg || 4222), host = hostArg || "127.0.0.1";
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<SystemStatus xmlns="https://www.vdl.afrl.af.mil/programs/oam">\n  <SecurityInformation><Classification>U</Classification><OwnerProducer><GovernmentIdentifier>USA</GovernmentIdentifier></OwnerProducer></SecurityInformation>\n  <MessageHeader><SystemID><UUID>123e4567-e89b-12d3-a456-426614174000</UUID></SystemID><Timestamp>2026-01-01T00:00:00Z</Timestamp><SchemaVersion>002.6.0</SchemaVersion><Mode>LIVE</Mode></MessageHeader>\n  <MessageData><SystemID><UUID>123e4567-e89b-12d3-a456-426614174000</UUID></SystemID><SystemState>OPERATIONAL</SystemState><Source>ACTUAL</Source></MessageData>\n</SystemStatus>`;
const body = kind === "xml" ? xml : kind === "json1k" ? JSON.stringify({ sensor: "s1", pad: "x".repeat(950), c: 21.5 }) : JSON.stringify({ sensor: "s1", c: 23.45, t: Date.now() });
const many = kind === "many";
const subjects = many ? Array.from({ length: 50000 }, (_, i) => `fleet.v${i % 500}.unit${i}.telemetry`)
  : kind === "xml" ? ["uci.alpha.SystemStatus", "uci.bravo.SystemStatus", "uci.charlie.SystemStatus"] : ["sensors.s1.temp", "sensors.s2.temp", "sensors.s3.temp", "orders.created.eu", "orders.created.us"];
const frames = subjects.map(s => Buffer.from(`PUB ${s} ${Buffer.byteLength(body)}\r\n${body}\r\n`));
const BATCH = 500;
const batches = Array.from({ length: many ? 100 : 1 }, (_, b) => Buffer.concat(Array.from({ length: BATCH }, (_, i) => frames[(b * BATCH + i) % frames.length])));
let sent = 0, bi = 0;
const sock = net.connect(port, host);
sock.on("error", e => { console.error("cannot connect to " + host + ":" + port + " (the NATS TCP port, usually 4222): " + e.message); process.exit(1); });
sock.on("data", () => {});
sock.on("connect", () => {
  sock.write('CONNECT {"verbose":false,"pedantic":false,"headers":false}\r\n');
  const t0 = Date.now();
  const pump = () => {
    const elapsed = (Date.now() - t0) / 1000;
    if (elapsed >= seconds) { sock.write("PING\r\n"); setTimeout(() => { console.log(`sent ${sent.toLocaleString()} messages in ${seconds}s = ${Math.round(sent / seconds).toLocaleString()} msg/s, ${(sent * frames[0].length / seconds / 1048576).toFixed(1)} MiB/s`); process.exit(0); }, 300); return; }
    const target = rate === Infinity ? Infinity : Math.floor(rate * elapsed);
    let ok = true;
    while (sent < target && ok) { ok = sock.write(batches[bi++ % batches.length]); sent += BATCH; if (rate === Infinity && !ok) break; }
    if (rate === Infinity && ok) setImmediate(pump); else if (!ok) sock.once("drain", pump); else setTimeout(pump, 5);
  };
  pump();
});
