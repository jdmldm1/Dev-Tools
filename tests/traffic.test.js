const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { lib } = require("./harness");

const FX = fs.readFileSync(path.join(__dirname, "fixtures", "nats-demo.xsd"), "utf8");
const model = lib.xsdModel([{ name: "nats-demo.xsd", text: FX }]);
const NS = "urn:demo:v1", SYS = "123e4567-e89b-12d3-a456-4266141740a1", CMD = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", ENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const msg = ({ name = "Thing", sys = SYS, ts = "2026-01-01T00:00:00Z", body = "" }) => `<?xml version="1.0"?><${name} xmlns="${NS}"><MessageHeader><SystemID><UUID>${sys}</UUID></SystemID><Timestamp>${ts}</Timestamp><SchemaVersion>002.6.0</SchemaVersion><Mode>LIVE</Mode></MessageHeader><MessageData>${body}</MessageData></${name}>`;
const rec = (text, t, topic = "t", n) => ({ t, topic, text, source: "nats", ...(n ? { n } : {}) });
const T0 = Date.parse("2026-01-01T00:00:00Z");

test("capture lines from every producer normalize to records", () => {
  assert.deepEqual(lib.capNormalize({ time: "2026-01-01T00:00:01.500Z", subject: "uci.a.B", reply: "", payload: "<X/>" }), { t: T0 + 1500, topic: "uci.a.B", text: "<X/>", source: "nats" });
  assert.deepEqual(lib.capNormalize({ time: "2026-01-01T00:00:02Z", topic: "t.x", subscription: "s1", message: '{"A":{}}' }), { t: T0 + 2000, topic: "t.x", text: '{"A":{}}', source: "cal" });
  assert.equal(lib.capNormalize({ time: "2026-01-01T00:00:00Z", subject: "b", payload_base64: Buffer.from("héllo").toString("base64") }).text, "héllo");
  assert.equal(lib.capNormalize({ t: 5, topic: "x", payload: "p", source: "cal" }).t, 5);
  assert.equal(lib.capNormalize(null), null); assert.equal(lib.capNormalize({ topic: "x" }), null);
});

test("capture files parse, skip junk, and round-trip", () => {
  const text = '{"time":"2026-01-01T00:00:00Z","subject":"a","payload":"1"}\nnot json\n\n{"time":"2026-01-01T00:00:01Z","topic":"b","message":"2"}\n{"x":1}\n';
  const r = lib.capParse(text);
  assert.equal(r.records.length, 2); assert.equal(r.skipped, 2);
  const again = lib.capParse(lib.capStringify(r.records));
  assert.deepEqual(again.records.map(x => [x.t, x.topic, x.text]), r.records.map(x => [x.t, x.topic, x.text]));
  assert.equal(lib.capStringify([]), "");
});

test("replay schedule honours speed, range and filter", () => {
  const rs = [rec("a", 1000, "x", 1), rec("b", 3000, "y", 2), rec("c", 2000, "x", 3)];
  assert.deepEqual(lib.capSchedule(rs).map(s => [s.rec.text, s.at]), [["a", 0], ["c", 1000], ["b", 2000]]);
  assert.deepEqual(lib.capSchedule(rs, { speed: 2 }).map(s => s.at), [0, 500, 1000]);
  assert.deepEqual(lib.capSchedule(rs, { speed: 0 }).map(s => s.at), [0, 0, 0]);
  assert.deepEqual(lib.capSchedule(rs, { filter: r => r.topic === "x" }).map(s => s.rec.text), ["a", "c"]);
  assert.deepEqual(lib.capSchedule(rs, { from: 1500, to: 2500 }).map(s => s.rec.text), ["c"]);
  assert.deepEqual(lib.capSchedule([]), []);
  assert.equal(lib.capTopic("uci/alpha:Status x"), "uci_alpha_Status_x");
});

test("records convert between UCI XML and OMS JSON", () => {
  const xml = lib.uciSample(model, "StatusReport");
  const json = lib.capConvert(model, rec(xml, 1), "oms-json");
  assert.match(json, /^\{"StatusReport":/);
  assert.equal(lib.capConvert(model, rec(json, 1), "oms-json"), json);
  const back = lib.capConvert(model, rec(json, 1), "xml");
  assert.equal(lib.uciDecode(model, back, { validate: true }).validation.ok, true);
  assert.equal(lib.capConvert(model, rec(xml, 1), "xml"), xml);
});

test("one message: name, header, identifiers, states and positions", () => {
  const xml = msg({ body: `<CommandID><UUID>${CMD}</UUID></CommandID><CommandState>ACCEPTED</CommandState><Position><Latitude>0.5</Latitude><Longitude>-1.25</Longitude><Altitude>1000</Altitude></Position>` });
  const m = lib.trMeta(null, rec(xml, 1));
  assert.equal(m.name, "Thing"); assert.equal(m.format, "xml"); assert.equal(m.ns, NS);
  assert.equal(m.header.systemId, SYS); assert.equal(m.header.mode, "LIVE"); assert.equal(m.header.schemaVersion, "002.6.0"); assert.equal(m.header.ts, T0);
  assert.deepEqual(m.ids, [{ path: "/MessageData/CommandID/UUID", uuid: CMD }]);
  assert.deepEqual(m.states, [{ path: "/MessageData/CommandState", value: "ACCEPTED" }]);
  assert.equal(m.positions.length, 1); assert.deepEqual([m.positions[0].lat, m.positions[0].lon, m.positions[0].alt], [0.5, -1.25, 1000]);
  assert.equal(m.positions[0].id, CMD);                                                    // the identifier in the body names the entity
  assert.equal(m.known, false);
  const j = lib.trMeta(null, rec('{"Track":{"id":"t7","lat":51.5,"lon":-0.12,"alt":30}}', 1));
  assert.equal(j.format, "json"); assert.equal(j.name, "Track"); assert.deepEqual([j.positions[0].lat, j.positions[0].lon, j.positions[0].degrees, j.positions[0].id], [51.5, -0.12, true, "t7"]);
  const bad = lib.trMeta(null, rec("<a><b></a>", 1)); assert.equal(bad.format, "broken"); assert.equal(bad.valid, false);
  assert.equal(lib.trMeta(null, rec("plain text", 1)).format, "other");
});

test("with a schema: known messages are validated, OMS JSON is converted first", () => {
  const good = lib.trMeta(model, rec(lib.uciSample(model, "StatusReport"), 1), { validate: true });
  assert.equal(good.known, true); assert.equal(good.valid, true); assert.equal(good.nsMatch, true);
  const broken = lib.trMeta(model, rec(lib.uciSample(model, "StatusReport").replace(/<State>[^<]*<\/State>/, "<State>NOPE</State>"), 1), { validate: true });
  assert.equal(broken.valid, false); assert.match(broken.errors[0].message, /allowed values/);
  const json = lib.trMeta(model, rec(lib.owpXmlToJson(model, lib.uciSample(model, "StatusReport")), 1), { validate: true });
  assert.equal(json.known, true); assert.equal(json.valid, true); assert.equal(json.format, "json");
  const unknown = lib.trMeta(model, rec(msg({ name: "Mystery" }), 1), { validate: true });
  assert.equal(unknown.known, false); assert.equal(unknown.valid, undefined);
});

function sampleStore() {
  const s = new lib.TrafficStore(null);
  const other = "123e4567-e89b-12d3-a456-4266141740b2";
  s.addMany([
    rec(msg({ name: "Command", ts: "2026-01-01T00:00:00Z", body: `<CommandID><UUID>${CMD}</UUID></CommandID><CommandState>NEW</CommandState>` }), T0 + 100, "cmd"),
    rec(msg({ name: "CommandStatus", sys: other, ts: "2026-01-01T00:00:01Z", body: `<CommandID><UUID>${CMD}</UUID></CommandID><CommandState>ACCEPTED</CommandState>` }), T0 + 1200, "cmd.status"),
    rec(msg({ name: "CommandStatus", sys: other, ts: "2026-01-01T00:00:05Z", body: `<CommandID><UUID>${CMD}</UUID></CommandID><CommandState>COMPLETED</CommandState>` }), T0 + 5300, "cmd.status"),
    rec(msg({ name: "Entity", ts: "2026-01-01T00:00:02Z", body: `<EntityID><UUID>${ENT}</UUID></EntityID><Position><Latitude>0.5</Latitude><Longitude>0.25</Longitude></Position>` }), T0 + 2100, "ent"),
    rec(msg({ name: "Entity", ts: "2026-01-01T00:00:03Z", body: `<EntityID><UUID>${ENT}</UUID></EntityID><Position><Latitude>0.51</Latitude><Longitude>0.26</Longitude></Position>` }), T0 + 3100, "ent"),
    rec("<a><b></a>", T0 + 3200, "junk"),
  ]);
  while (s.process(50)) { /* decode everything */ }
  return { s, other };
}

test("store: who is on the bus", () => {
  const { s, other } = sampleStore();
  const bus = s.bus(T0 + 6000);
  const a = bus.find(b => b.id === SYS), b = bus.find(b => b.id === other);
  assert.equal(a.count, 3); assert.equal(a.types, 2); assert.equal(b.count, 2); assert.deepEqual(b.messages, [["CommandStatus", 2]]);
  assert.equal(b.ageMs, T0 + 6000 - (T0 + 5300)); assert.ok(bus.find(x => x.id === "(no MessageHeader)"));
});

test("store: a command's transaction", () => {
  const { s } = sampleStore();
  const tx = s.transactions();
  const c = tx.find(t => t.uuid === CMD);
  assert.equal(c.count, 3); assert.deepEqual(c.names, ["Command", "CommandStatus"]); assert.equal(c.span, 5200); assert.deepEqual(c.roles, ["CommandID/UUID"]);
  const tl = s.timeline(CMD);
  assert.deepEqual(tl.map(r => r.name), ["Command", "CommandStatus", "CommandStatus"]);
  assert.deepEqual(tl.map(r => r.delta), [0, 1100, 4100]);
  assert.deepEqual(tl.map(r => r.states[0].value), ["NEW", "ACCEPTED", "COMPLETED"]);
  assert.equal(s.transactions({ min: 4 }).length, 0);
});

test("store: analysis finds latency, gaps, duplicates and failures", () => {
  const s = new lib.TrafficStore(model, { validate: true });
  const base = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < 12; i++) s.add(rec(lib.uciSample(model, "StatusReport").replace(/<Timestamp>[^<]*</, "<Timestamp>" + new Date(base + i * 1000).toISOString().replace(/\.\d+Z/, "Z") + "<"), base + i * 1000 + 40, "demo.status"));
  s.add(rec(lib.uciSample(model, "StatusReport").replace(/<Timestamp>[^<]*</, "<Timestamp>" + new Date(base + 60000).toISOString().replace(/\.\d+Z/, "Z") + "<"), base + 60040, "demo.status"));       // after a long silence
  s.add(rec(lib.uciSample(model, "StatusReport").replace(/<State>[^<]*<\/State>/, "<State>NOPE</State>"), base + 61000, "demo.status"));
  s.add(s.records[0] && { ...s.records[0], meta: undefined });                                    // an exact duplicate
  while (s.process(50)) { /* decode */ }
  const a = s.analysis();
  assert.equal(a.total, 15); assert.equal(a.invalid, 1); assert.equal(a.valid, 14); assert.equal(a.duplicates, 1);
  assert.equal(a.latency.p50, 40); assert.ok(a.latency.max >= 40);
  assert.equal(a.gaps.length, 1); assert.ok(a.gaps[0].gapMs > 40000); assert.equal(a.gaps[0].name, "StatusReport");
  const m = a.messages.find(x => x.name === "StatusReport");
  assert.equal(m.count, 15); assert.match(m.errors[0][0], /allowed values/);
  assert.equal(a.messages.length, 1); assert.equal(a.systems, 1);
});

test("store: positions become tracks in degrees (radians in UCI, degrees in plain JSON)", () => {
  const { s } = sampleStore();
  s.add(rec('{"Track":{"id":"t7","lat":51.5,"lon":-0.12}}', T0 + 9000, "json")); while (s.process(50)) { /* decode */ }
  const tracks = s.tracks();
  const ent = tracks.find(t => t.id === ENT), t7 = tracks.find(t => t.id === "t7");
  assert.equal(ent.points.length, 2); assert.ok(Math.abs(ent.points[0].lat - 0.5 * 180 / Math.PI) < 1e-9); assert.ok(ent.points[0].t < ent.points[1].t);
  assert.deepEqual([t7.points[0].lat, t7.points[0].lon], [51.5, -0.12]);
  assert.ok(Math.abs(s.tracks("degrees").find(t => t.id === ENT).points[0].lat - 0.5) < 1e-9);          // forcing degrees reads the numbers as they are
  s.add(rec(msg({ body: `<Position><Latitude>95</Latitude><Longitude>10</Longitude></Position>` }), T0, "x")); while (s.process(50)) { /* decode */ }
  assert.ok(!s.tracks("degrees").some(t => t.points.some(p => Math.abs(p.lat) > 90)));                  // impossible positions are dropped
  s.add(rec(msg({ body: `<EntityID><UUID>${CMD}</UUID></EntityID><Position><Latitude>0</Latitude><Longitude>0</Longitude></Position>` }), T0, "x")); while (s.process(50)) { /* decode */ }
  assert.ok(!s.tracks().some(t => t.id === CMD), "0,0 means no fix and is not plotted");
});

test("store: time-sliced decoding, a size cap, and reset with a new schema", () => {
  const s = new lib.TrafficStore(null, { max: 100 });
  for (let i = 0; i < 300; i++) s.add(rec(msg({ body: `<N>${i}</N>` }), T0 + i, "t"));
  assert.ok(s.records.length <= 110); assert.ok(s.dropped >= 190);
  assert.ok(s.pending > 0); const left = s.process(0.0001); assert.ok(left > 0 || s.pending === 0);
  while (s.process(50)) { /* decode */ }
  assert.equal(s.pending, 0); assert.equal(s.names.get("Thing").count, s.records.length);
  s.reset(model); assert.equal(s.names.size, 0); assert.equal(s.pending, s.records.length);
  while (s.process(50)) { /* decode again */ }
  assert.equal(s.records[0].meta.known, false);
});

const UCI = process.env.UCI_SCHEMA_DIR || "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL";
test("real UCI messages: validated, tracked and correlated", { skip: !fs.existsSync(UCI) }, () => {
  const g = require("../scripts/uci-gen"), { model: m } = g.loadUciSchema(lib);
  const { uciMessage } = g.createUciGenerator(lib, m);
  const s = new lib.TrafficStore(m, { validate: true });
  let t = T0;
  for (const name of m.elements.has("SystemStatus") ? ["SystemStatus", "SubsystemStatus", "MissionPlan", "ActivityPlan", "EntityMetadata"] : []) for (let i = 0; i < 4; i++) s.add(rec(uciMessage(name, g.systems[i % 3][1]), t += 500, `uci.${g.systems[i % 3][0]}.${name}`));
  s.add(rec(uciMessage("SystemStatus", g.systems[0][1], { broken: true }), t += 500, "uci.alpha.SystemStatus"));
  while (s.process(100)) { /* decode */ }
  const a = s.analysis();
  assert.equal(a.total, 21); assert.ok(a.valid >= 20 && a.invalid === 1, JSON.stringify({ v: a.valid, i: a.invalid }));
  assert.equal(s.bus().length, 3); assert.ok(a.messages.every(x => x.unknown === 0));
});

test("playback sends in time order with the right waits, counts failures, stops and loops", async () => {
  const rs = [rec("a", 1000, "x", 1), rec("b", 1500, "x", 2), rec("c", 3000, "x", 3)];
  const waits = [], got = [];
  let clock = 0; const realNow = performance.now.bind(performance);
  const sleep = async ms => { waits.push(Math.round(ms)); };
  const r = await lib.capPlay(rs, async rec => { got.push(rec.text); if (rec.text === "b") throw new Error("refused"); }, { speed: 1, sleep });
  assert.deepEqual(got, ["a", "b", "c"]); assert.equal(r.sent, 2); assert.equal(r.failed, 1); assert.equal(r.lastError, "refused"); assert.equal(r.rounds, 1);
  assert.ok(waits.length >= 1 && waits.every(w => w > 0));
  const fast = []; const r2 = await lib.capPlay(rs, async rec => { fast.push(rec.text); }, { speed: 0, sleep: async ms => fast.push("sleep" + ms) });
  assert.deepEqual(fast, ["a", "b", "c"]); assert.equal(r2.sent, 3);
  let stop = false; const seen = [];
  const r3 = await lib.capPlay(rs, async rec => { seen.push(rec.text); if (rec.text === "a") stop = true; }, { speed: 0, isStopped: () => stop });
  assert.equal(r3.stopped, true); assert.deepEqual(seen, ["a"]);
  let rounds = 0; const progress = [];
  const r4 = await lib.capPlay(rs, async () => { }, { speed: 0, loop: true, isStopped: () => rounds >= 2, onProgress: p => { progress.push(p.i); if (p.i === p.of) rounds++; } });
  assert.equal(r4.sent, 6); assert.equal(r4.rounds, 2); assert.deepEqual(progress, [1, 2, 3, 1, 2, 3]);
  assert.equal((await lib.capPlay([], async () => { }, {})).sent, 0);
  assert.equal((await lib.capPlay(rs, async () => { }, { speed: 0, filter: r => r.text === "c" })).sent, 1);
});

test("restamping sets the header timestamp in XML and OMS JSON", () => {
  const when = new Date("2030-05-06T07:08:09.123Z");
  assert.match(lib.capRestamp(msg({ ts: "2026-01-01T00:00:00Z" }), when), /<Timestamp>2030-05-06T07:08:09Z<\/Timestamp>/);
  assert.equal(lib.capRestamp('{"A":{"MessageHeader":{"Timestamp": "2026-01-01T00:00:00Z","Mode":"LIVE"}}}', when), '{"A":{"MessageHeader":{"Timestamp": "2030-05-06T07:08:09Z","Mode":"LIVE"}}}');
  assert.equal(lib.capRestamp("no timestamp here", when), "no timestamp here");
});
