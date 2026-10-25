const test = require("node:test"), assert = require("node:assert/strict");
const { lib } = require("./harness");

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" elementFormDefault="qualified" version="001.0.0">
  <xs:element name="Report" type="ReportType"/>
  <xs:complexType name="HeaderType"><xs:sequence><xs:element name="SystemID" type="IdType"/><xs:element name="Timestamp" type="xs:dateTime"/></xs:sequence></xs:complexType>
  <xs:complexType name="IdType"><xs:sequence><xs:element name="UUID" type="xs:string"/></xs:sequence></xs:complexType>
  <xs:complexType name="ReportType"><xs:sequence>
    <xs:element name="MessageHeader" type="HeaderType"/>
    <xs:element name="ID" type="xs:string"/>
    <xs:element name="Count" type="xs:int"/>
    <xs:element name="Ratio" type="xs:double" minOccurs="0"/>
  </xs:sequence></xs:complexType>
</xs:schema>`;
const model = lib.xsdModel([{ name: "t.xsd", text: XSD }]);
const SYS = "11111111-1111-4111-8111-111111111111";
const xml = (ts, count = 5, id = "x") => `<Report xmlns="urn:t"><MessageHeader><SystemID><UUID>${SYS}</UUID></SystemID><Timestamp>${ts}</Timestamp></MessageHeader><ID>${id}</ID><Count>${count}</Count><Ratio>0.50</Ratio></Report>`;
const asOms = text => lib.owpXmlToJson(model, text, 0);

test("bridgeEvent: same message gets the same key over both transports", () => {
  const x = xml("2025-01-01T00:00:00Z"), a = lib.bridgeEvent("nats", x, 1000, model), b = lib.bridgeEvent("cal", asOms(x), 1040, model);
  assert.equal(a.name, "Report"); assert.equal(b.name, "Report");
  assert.equal(a.key, b.key); assert.equal(a.converted, true); assert.equal(b.converted, false);
  assert.notEqual(a.key, lib.bridgeEvent("nats", xml("2025-01-01T00:00:01Z"), 1000, model).key, "a different timestamp is a different message");
  const noModel = lib.bridgeEvent("nats", x, 1000, null);
  assert.equal(noModel.converted, false); assert.equal(noModel.key, a.key);
  const plain = lib.bridgeEvent("cal", `{"Thing":{"a":1}}`, 5, null); assert.ok(plain.key.startsWith("Thing|#"));
});

test("BridgeMatcher pairs, measures the gap, and finds field mismatches", () => {
  const m = new lib.BridgeMatcher({ windowMs: 1000 });
  const good = xml("2025-01-01T00:00:00Z"), bad = xml("2025-01-01T00:00:02Z", 5);
  assert.equal(m.add(lib.bridgeEvent("nats", good, 1000, model)), null);
  const p1 = m.add(lib.bridgeEvent("cal", asOms(good), 1030, model));
  assert.equal(p1.latencyMs, 30); assert.equal(p1.diff.same, true);
  // the CAL side delivers it first this time, and with a different Count
  m.add(lib.bridgeEvent("cal", asOms(xml("2025-01-01T00:00:02Z", 6)), 2000, model));
  const p2 = m.add(lib.bridgeEvent("nats", bad, 2100, model));
  assert.equal(p2.latencyMs, -100); assert.equal(p2.diff.same, false);
  assert.deepEqual(p2.diff.changes.map(c => [c.path, c.a, c.b]), [["Report.Count", 5, 6]]);
  const s = m.stats(2100);
  assert.equal(s.matched, 2); assert.equal(s.mismatched, 1); assert.equal(s.waiting, 0);
  assert.equal(s.latency.min, -100); assert.equal(s.latency.max, 30);
});

test("BridgeMatcher reports messages seen on only one side after the window", () => {
  const m = new lib.BridgeMatcher({ windowMs: 1000 });
  m.add(lib.bridgeEvent("nats", xml("2025-01-01T00:00:03Z", 1, "a"), 5000, model));
  m.add(lib.bridgeEvent("cal", asOms(xml("2025-01-01T00:00:04Z", 1, "b")), 5100, model));
  assert.equal(m.stats(5500).waiting, 2);
  const s = m.stats(7000);
  assert.equal(s.onlyNats, 1); assert.equal(s.onlyCal, 1); assert.equal(s.waiting, 0);
  assert.deepEqual(m.unmatched.map(u => u.side).sort(), ["cal", "nats"]);
  const late = m.add(lib.bridgeEvent("cal", asOms(xml("2025-01-01T00:00:03Z", 1, "a")), 9000, model));
  assert.equal(late, null, "a partner that arrives after the window is not paired");
  m.clear(); assert.equal(m.stats().matched, 0);
});

test("duplicates of one message pair up in order", () => {
  const m = new lib.BridgeMatcher(), x = xml("2025-01-01T00:00:00Z");
  m.add(lib.bridgeEvent("nats", x, 100, model)); m.add(lib.bridgeEvent("nats", x, 200, model));
  const a = m.add(lib.bridgeEvent("cal", asOms(x), 150, model)), b = m.add(lib.bridgeEvent("cal", asOms(x), 260, model));
  assert.deepEqual([a.latencyMs, b.latencyMs], [50, 60]);
});
