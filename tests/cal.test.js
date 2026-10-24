const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { lib } = require("./harness");
const mock = require("../scripts/owp-mock-server");

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" elementFormDefault="qualified" version="001.0.0">
  <xs:element name="Report" type="ReportType"/>
  <xs:complexType name="ReportType"><xs:sequence>
    <xs:element name="ID" type="xs:string"/>
    <xs:element name="Count" type="xs:unsignedLong"/>
    <xs:element name="Ratio" type="xs:double" minOccurs="0"/>
    <xs:element name="Flag" type="xs:boolean" minOccurs="0"/>
    <xs:element name="Item" type="ItemBase" minOccurs="0" maxOccurs="unbounded"/>
    <xs:element name="Note" type="xs:string" minOccurs="0" maxOccurs="3"/>
  </xs:sequence></xs:complexType>
  <xs:complexType name="ItemBase" abstract="true"><xs:sequence><xs:element name="Name" type="xs:string"/></xs:sequence></xs:complexType>
  <xs:complexType name="Widget"><xs:complexContent><xs:extension base="ItemBase"><xs:sequence><xs:element name="Size" type="xs:int"/></xs:sequence></xs:extension></xs:complexContent></xs:complexType>
</xs:schema>`;
const model = lib.xsdModel([{ name: "t.xsd", text: XSD }]);
const GOOD = '{"Report":{"Note":["a","b"],"Count":18446744073709551615,"ID":"x","Item":[{"$type":"Widget","Size":3,"Name":"w"}],"Ratio":"Infinity","Flag":true}}';

test("OMS JSON parses without losing number text, and rejects bad JSON with a position", () => {
  const v = lib.owpParseJson('{"a":[1,2.50,-0.0e3,18446744073709551615],"b":"\\u00e9\\n","c":null,"d":true}');
  assert.ok(v instanceof Map);
  assert.deepEqual(v.get("a").map(n => n.raw), ["1", "2.50", "-0.0e3", "18446744073709551615"]);
  assert.equal(v.get("b"), "é\n"); assert.equal(v.get("c"), null); assert.equal(v.get("d"), true);
  assert.equal(lib.owpStringify(v), '{"a":[1,2.50,-0.0e3,18446744073709551615],"b":"é\\n","c":null,"d":true}');
  assert.equal(lib.owpStringify(lib.owpParseJson("[]")), "[]");
  assert.equal(lib.owpStringify(lib.owpParseJson('{"a":{"b":[]}}'), 2), '{\n  "a": {\n    "b": []\n  }\n}');
  for (const bad of ['{"a":1,}', '{"a" 1}', "{'a':1}", '{"a":01}', '{"a":1}{', '{"a":"x', '{"a":1,"a":2}', "[1,]", ""]) assert.throws(() => lib.owpParseJson(bad), /\(line \d+, column \d+\)/, bad);
  assert.throws(() => lib.owpParseJson('{\n "a": tru\n}'), e => e.line === 2);
});

test("OWP frames parse and serialize", () => {
  assert.deepEqual(lib.owpParse("+OK"), { op: "+OK" });
  assert.deepEqual(lib.owpParse("-ERR Illegal-State topic nope"), { op: "-ERR", error: "Illegal-State", details: "topic nope" });
  assert.deepEqual(lib.owpParse("-ERR   Invalid-Message"), { op: "-ERR", error: "Invalid-Message", details: "" });
  assert.equal(lib.owpParse('INFO {"version":"1.0","server_id":"s"}').info.server_id, "s");
  assert.deepEqual(lib.owpParse('MSG s1\t{"A": {"B": 1}}'), { op: "MSG", sid: "s1", text: '{"A": {"B": 1}}' });
  assert.deepEqual(lib.owpParse('MSG s1 {"a":\n1}').text, '{"a":\n1}');          // newlines are allowed inside a field
  assert.throws(() => lib.owpParse("INFO nope"), /not valid JSON/);
  assert.throws(() => lib.owpParse("MSG s1"), /MSG needs/);
  assert.throws(() => lib.owpParse("HELLO x"), /unexpected operation/);
  assert.equal(lib.owpInit({ versions: ["1.0"], schema: "002.6.0", serviceId: "S" }), 'INIT {"versions":["1.0"],"schema":"002.6.0","service_id":"S","verbose":true}');
  assert.equal(lib.owpSub("s1", "Report", "a.b"), "SUB s1 Report a.b");
  assert.equal(lib.owpSub("s1", "Report", "a.b", "g"), "SUB s1 Report a.b g");
  assert.equal(lib.owpUnsub("s1"), "UNSUB s1");
  assert.equal(lib.owpPub("a.b", '{ "Report" : {\n "N": 1.50 } }'), 'PUB a.b {"Report":{"N":1.50}}');       // compact, numbers untouched
  assert.match(lib.owpErrorHelp("Illegal-State"), /topic/); assert.equal(lib.owpErrorHelp("Nope"), "");
});

test("OMS JSON becomes schema-ordered XML and validates", () => {
  const c = lib.owpJsonToXml(model, GOOD);
  assert.equal(c.name, "Report");
  assert.match(c.xml, /xmlns="urn:t"/);
  const order = [...c.xml.matchAll(/<(ID|Count|Ratio|Flag|Item|Note)[ >]/g)].map(m => m[1]);
  assert.deepEqual(order, ["ID", "Count", "Ratio", "Flag", "Item", "Note", "Note"]);       // schema order, one element per array entry
  assert.match(c.xml, /<Item xsi:type="Widget">/); assert.match(c.xml, /<Count>18446744073709551615<\/Count>/); assert.match(c.xml, /<Ratio>INF<\/Ratio>/);
  const v = lib.owpValidate(model, GOOD);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("invalid OMS JSON is reported with schema paths, and unknown messages get suggestions", () => {
  const bad = lib.owpValidate(model, '{"Report":{"ID":"x","Count":-5,"Extra":1}}');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => /Count/.test(e.path || e.message)), JSON.stringify(bad.errors));
  assert.ok(bad.errors.some(e => /Extra/.test(e.message)));
  const noMsg = lib.owpValidate(model, '{"Reprot":{}}');
  assert.equal(noMsg.ok, false); assert.match(noMsg.errors[0].message, /not a message/); assert.ok(noMsg.suggest.includes("Report"));
  assert.equal(lib.owpValidate(model, '{"Report":{},"Other":{}}').ok, false);
  assert.match(lib.owpValidate(model, "[1]").errors[0].message, /exactly one member/);
  assert.match(lib.owpValidate(model, '{"Report":').errors[0].message, /line 1/);
});

test("XML converts back to OMS JSON: arrays, $type, exact numbers, special floats", () => {
  const xml = lib.owpJsonToXml(model, GOOD).xml;
  const j = lib.owpXmlToJson(model, xml);
  assert.equal(j, '{"Report":{"ID":"x","Count":18446744073709551615,"Ratio":"Infinity","Flag":true,"Item":[{"$type":"Widget","Name":"w","Size":3}],"Note":["a","b"]}}');
  assert.equal(lib.owpValidate(model, j).ok, true);
  const single = lib.owpXmlToJson(model, '<Report xmlns="urn:t"><ID>i</ID><Count>1</Count><Note>only</Note></Report>');
  assert.equal(single, '{"Report":{"ID":"i","Count":1,"Note":["only"]}}');            // a repeatable member is an array even with one value
  assert.throws(() => lib.owpXmlToJson(model, "<Nope/>"), /not a message/);
});

test("both directions agree on generated samples", () => {
  for (const all of [false, true]) {
    const json = lib.owpXmlToJson(model, lib.uciSample(model, "Report", { all }));
    const v = lib.owpValidate(model, json);
    assert.equal(v.ok, true, json + " " + JSON.stringify(v.errors));
    assert.equal(lib.owpXmlToJson(model, v.xml), json);                                   // JSON -> XML -> JSON is stable
  }
});

const UCI = process.env.UCI_SCHEMA_DIR || "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL";
test("real UCI schema: sampled messages survive XML -> OMS JSON -> XML and stay valid", { skip: !fs.existsSync(UCI) }, () => {
  const files = fs.readdirSync(UCI).filter(f => /\.xsd$/i.test(f)).map(f => ({ name: f, text: fs.readFileSync(path.join(UCI, f), "utf8") }));
  const m = lib.xsdModel(files);
  let n = 0;
  for (const name of [...m.elements.keys()].filter((_, i) => i % 11 === 0)) {
    const json = lib.owpXmlToJson(m, lib.uciSample(m, name, { all: n % 2 === 0 }));
    const v = lib.owpValidate(m, json);
    assert.equal(v.ok, true, name + ": " + JSON.stringify(v.errors.slice(0, 2)));
    assert.equal(lib.owpXmlToJson(m, v.xml), json, name + " is not stable");
    n++;
  }
  assert.ok(n > 50);
});

/* ---- the client against the mock LA-CAL server ---- */
async function withServer(fn, cfg = {}) {
  const server = await mock.start({ lib, model, schemaVersion: "001.0.0", topics: [{ name: "rep.main", message: "Report" }, { name: "rep.other", message: "Report" }], ...cfg });
  const url = "ws://127.0.0.1:" + server.port;
  try { await fn(url, server); } finally { server.close(); }
}
const INIT = { versions: ["1.0"], schema: "001.0.0", serviceId: "DemoService" };
const wait = ms => new Promise(r => setTimeout(r, ms));

test("client: handshake, INFO, subscribe, publish, receive", () => withServer(async url => {
  const a = new lib.OwpClient(), b = new lib.OwpClient(), frames = [];
  a.onframe = (d, t) => frames.push(d + " " + t.split(" ")[0]);
  const info = await a.connect(url, INIT);
  assert.equal(info.version, "1.0"); assert.equal(info.system_label, "MOCK-SYSTEM"); assert.match(info.uuids.system, /^[0-9a-f-]{36}$/);
  assert.deepEqual(frames.slice(0, 3), ["out INIT", "in +OK", "in INFO"]);
  await b.connect(url, INIT);
  const got = []; b.onmsg = m => got.push(m);
  const sub = await b.subscribe("Report", "rep.main");
  await a.publish("rep.main", GOOD);
  await wait(60);
  assert.equal(got.length, 1); assert.equal(got[0].sub.id, sub.id); assert.equal(lib.owpValidate(model, got[0].text).ok, true);
  await b.unsubscribe(sub.id);
  await a.publish("rep.main", GOOD); await wait(60);
  assert.equal(got.length, 1);
  a.close(); b.close();
}));

test("client: server errors come back with codes and plain-language help", () => withServer(async url => {
  const c = new lib.OwpClient(); await c.connect(url, INIT);
  await assert.rejects(c.subscribe("Report", "no.such.topic"), e => e.code === "Illegal-State" && /topic/.test(e.help));
  await assert.rejects(c.subscribe("NotAMessage", "rep.main"), e => e.code === "Illegal-Argument");
  await assert.rejects(c.publish("rep.main", '{"Report":{"ID":"x"}}'), e => e.code === "Invalid-Message");        // missing required Count
  await assert.rejects(c.publish("nope", GOOD), e => e.code === "Illegal-State");
  await assert.rejects(c.publish("bad topic", GOOD), /Topic may only contain/);
  await assert.rejects(c.subscribe("Report", "rep.main", "bad group!"), /Group may only/);
  await c.subscribe("Report", "rep.main");
  assert.equal(c.subs.size, 1);
  c.close();
}));

test("client: INIT problems are explained", () => withServer(async url => {
  await assert.rejects(new lib.OwpClient().connect(url, { ...INIT, serviceId: "Nope" }), /Unsupported-Service.*service identifier/);
  await assert.rejects(new lib.OwpClient().connect(url, { ...INIT, schema: "9.9.9" }), /Unsupported-Schema/);
  await assert.rejects(new lib.OwpClient().connect(url, { ...INIT, versions: ["7.0"] }), /Unsupported-Version/);
  await assert.rejects(new lib.OwpClient().connect("ws://127.0.0.1:1", INIT, 2000), /Could not open|Timed out/);
}));

test("client: a subscription group gets each message once", () => withServer(async url => {
  const pub = new lib.OwpClient(), c1 = new lib.OwpClient(), c2 = new lib.OwpClient(), solo = new lib.OwpClient();
  for (const c of [pub, c1, c2, solo]) await c.connect(url, INIT);
  const counts = { c1: 0, c2: 0, solo: 0 };
  c1.onmsg = () => counts.c1++; c2.onmsg = () => counts.c2++; solo.onmsg = () => counts.solo++;
  await c1.subscribe("Report", "rep.main", "workers"); await c2.subscribe("Report", "rep.main", "workers"); await solo.subscribe("Report", "rep.main");
  for (let i = 0; i < 6; i++) await pub.publish("rep.main", GOOD);
  await wait(100);
  assert.equal(counts.solo, 6); assert.equal(counts.c1 + counts.c2, 6); assert.ok(counts.c1 > 0 && counts.c2 > 0, JSON.stringify(counts));
  [pub, c1, c2, solo].forEach(c => c.close());
}));

test("client: an unexpected close is reported", () => withServer(async (url, server) => {
  const c = new lib.OwpClient(); await c.connect(url, INIT);
  let reason = null; c.onclose = r => { reason = r; };
  server.close(); await wait(100);
  assert.ok(reason !== null && c.connected === false);
}));

test("server advertises its topics in INFO, and announces new ones with another INFO", () => withServer(async (url, server) => {
  const c = new lib.OwpClient(); let infos = 0; c.oninfo = () => { infos++; };
  const info = await c.connect(url, INIT);
  assert.deepEqual(lib.owpAdvertisedTopics(info).map(t => t.name), ["rep.main", "rep.other"]);
  server.addTopic({ name: "rep.late", message: "Report" });
  await wait(80);
  assert.equal(infos, 1); assert.deepEqual(lib.owpAdvertisedTopics(c.info).map(t => t.name), ["rep.main", "rep.other", "rep.late"]);
  assert.deepEqual(lib.owpAdvertisedTopics({ x_topics: [{ name: "bad topic", message: "A" }, { name: "ok", message: "A" }, null, { name: "x" }] }).map(t => t.name), ["ok"]);
  assert.deepEqual(lib.owpAdvertisedTopics({}), []);
  c.close();
}));

test("discovery finds the accepted (topic, message) pairs by trying them", () => withServer(async url => {
  const c = new lib.OwpClient(); await c.connect(url, INIT);
  const progress = [];
  const r = await lib.owpDiscover(c, ["rep.main", "nope", "rep.other"], ["Nope1", "Nope2", "Report", "Nope3"], { batch: 2, onProgress: p => progress.push(p.topic) });
  assert.deepEqual(r.found.map(s => s.topic + ":" + s.messageName), ["rep.main:Report", "rep.other:Report"]);
  assert.equal(c.subs.size, 2);                                          // refused attempts leave nothing behind
  assert.ok(r.tried >= 4 && r.tried <= 12, String(r.tried));
  assert.ok(progress.includes("nope"));
  // words of the topic put plausible messages first, so a match needs fewer attempts
  const c2 = new lib.OwpClient(); await c2.connect(url, INIT);
  const many = Array.from({ length: 300 }, (_, i) => "Filler" + i).concat("Report");
  const r2 = await lib.owpDiscover(c2, ["rep.main"], many, { batch: 50 });
  assert.equal(r2.tried, 50);
  const cancelled = await lib.owpDiscover(c2, ["rep.main"], many, { batch: 10, isCancelled: () => true });
  assert.equal(cancelled.cancelled, true);
  c.close(); c2.close();
}));
