const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { lib } = require("./harness");
const TE = new TextEncoder();

const NS = "urn:demo:v1", NS2 = "urn:demo:v2";
const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="${NS}" elementFormDefault="qualified" version="1.0">
  <xs:element name="StatusReport" type="StatusReportType"><xs:annotation><xs:documentation>Reports the status of a system.

  More detail in a second paragraph.</xs:documentation></xs:annotation></xs:element>
  <xs:element name="Command" type="CommandType"/>
  <xs:complexType name="StatusReportType"><xs:sequence>
    <xs:element name="MessageHeader" type="HeaderType"/>
    <xs:element name="MessageData"><xs:complexType><xs:sequence>
      <xs:element name="State" type="StateType"><xs:annotation><xs:documentation>Current state.</xs:documentation></xs:annotation></xs:element>
      <xs:element name="Altitude" type="xs:double" minOccurs="0"/>
      <xs:element name="Track" type="TrackType" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence></xs:complexType></xs:element>
  </xs:sequence></xs:complexType>
  <xs:complexType name="CommandType"><xs:sequence><xs:element name="Verb" type="xs:string"/></xs:sequence></xs:complexType>
  <xs:complexType name="HeaderType"><xs:sequence><xs:element name="SystemID" type="xs:string"/><xs:element name="Timestamp" type="xs:dateTime"/></xs:sequence></xs:complexType>
  <xs:complexType name="TrackType"><xs:sequence><xs:element name="Speed" type="xs:double"/></xs:sequence><xs:attribute name="id" type="xs:int"/></xs:complexType>
  <xs:simpleType name="StateType"><xs:restriction base="xs:string">
    <xs:enumeration value="ACTIVE"><xs:annotation><xs:documentation>Up and running.</xs:documentation></xs:annotation></xs:enumeration>
    <xs:enumeration value="FAILED"/></xs:restriction></xs:simpleType>
</xs:schema>`;
const model = lib.xsdModel([{ name: "demo.xsd", text: XSD }]);

const msg = (ns, state = "ACTIVE", extra = "") => `<?xml version="1.0"?>
<StatusReport xmlns="${ns}">
  <MessageHeader><SystemID>S1</SystemID><Timestamp>2026-01-01T00:00:00Z</Timestamp></MessageHeader>
  <MessageData><State>${state}</State><Altitude>1500.5</Altitude><Track id="4"><Speed>200</Speed></Track><Track id="5"><Speed>210</Speed></Track>${extra}</MessageData>
</StatusReport>`;

test("a known message decodes, validates, and carries schema documentation", () => {
  const d = lib.uciDecode(model, msg(NS), { validate: true });
  assert.equal(d.xml, true); assert.equal(d.known, true); assert.equal(d.msgName, "StatusReport");
  assert.equal(d.nsMatch, true); assert.equal(d.validation.ok, true);
  assert.deepEqual(d.facts.slice(0, 2), [["SystemID", "S1"], ["Timestamp", "2026-01-01T00:00:00Z"]]);
  assert.equal(lib.uciFirstPara(d.decl.doc), "Reports the status of a system.");
  const state = d.node.kids[1].kids[0];
  assert.equal(state.local, "State"); assert.equal(state.type, "StateType"); assert.equal(state.doc, "Current state.");
  assert.equal(state.isEnum, true); assert.equal(state.enumDoc, "Up and running."); assert.equal(state.enumBad, false);
  assert.equal(d.node.kids[1].kids[2].path, "/StatusReport/MessageData/Track[1]");           // repeated siblings are indexed
  assert.equal(d.node.kids[1].kids[3].path, "/StatusReport/MessageData/Track[2]");
  assert.equal(d.node.kids[1].kids[2].occurs, "0..∞");
  assert.deepEqual(d.node.kids[1].kids[2].attrs.map(a => [a.name, a.known]), [["id", true]]);
});

test("errors attach to the element they belong to, and unknown content is flagged", () => {
  const d = lib.uciDecode(model, msg(NS, "BROKEN", "<Mystery>1</Mystery>"), { validate: true });
  assert.equal(d.validation.ok, false);
  const state = d.node.kids[1].kids[0], mystery = d.node.kids[1].kids[4];
  assert.equal(state.enumBad, true);
  assert.ok(state.errors.length >= 1 && /BROKEN/.test(state.errors[0].message), JSON.stringify(state.errors));
  assert.equal(mystery.known, false);
  assert.ok(mystery.errors.length === 1 && /unexpected element <Mystery>/.test(mystery.errors[0].message));
});

test("a different schema version is reported, not rejected", () => {
  const d = lib.uciDecode(model, msg(NS2), { validate: true });
  assert.equal(d.known, true); assert.equal(d.nsMatch, false); assert.equal(d.ns, NS2); assert.equal(d.schemaNs, NS);
  assert.equal(d.node.kids[1].kids[0].doc, "Current state.");                               // still annotated by local name
  assert.equal(d.validation.ok, false);                                                      // the validator does flag the namespace
});

test("unknown roots get suggestions; wrapped messages are found; non-XML is ignored", () => {
  const u = lib.uciDecode(model, `<StatusReprot xmlns="${NS}"><A/></StatusReprot>`);
  assert.equal(u.xml, true); assert.equal(u.known, false); assert.ok(u.suggest.includes("StatusReport"));
  const w = lib.uciDecode(model, `<Envelope><StatusReport xmlns="${NS}"><MessageHeader><SystemID>x</SystemID><Timestamp>2026-01-01T00:00:00Z</Timestamp></MessageHeader><MessageData><State>FAILED</State></MessageData></StatusReport></Envelope>`, { validate: true });
  assert.equal(w.known, true); assert.equal(w.wrapped, "Envelope"); assert.equal(w.validation, undefined);
  assert.equal(lib.uciDecode(model, '{"a":1}'), null);
  assert.equal(lib.uciDecode(model, "plain text"), null);
  const bad = lib.uciDecode(model, "<a><b></a>");
  assert.equal(bad.xml, false); assert.match(bad.error, /Mismatched/);
  const noSchema = lib.uciDecode(null, msg(NS));
  assert.equal(noSchema.xml, true); assert.equal(noSchema.rootName, "StatusReport"); assert.equal(noSchema.known, false);
});

test("generated samples decode as valid messages", () => {
  for (const all of [false, true]) {
    const d = lib.uciDecode(model, lib.uciSample(model, "StatusReport", { all }), { validate: true });
    assert.equal(d.known, true); assert.equal(d.validation.ok, true, JSON.stringify(d.validation.errors));
  }
  assert.throws(() => lib.uciSample(model, "Nope"), /not a global element/);
});

test("numeric fields come out of JSON and XML payloads with stable paths", () => {
  const f = o => Object.fromEntries(lib.natsNumericFields(TE.encode(o)));
  assert.deepEqual(f('{"a":1,"b":{"c":2.5,"d":"x"},"e":[3,4],"ok":true}'), { a: 1, "b.c": 2.5, "e[0]": 3, "e[1]": 4 });
  assert.deepEqual(f(msg(NS)), { "/StatusReport/MessageData/Altitude": 1500.5, "/StatusReport/MessageData/Track[1]/@id": 4, "/StatusReport/MessageData/Track[1]/Speed": 200, "/StatusReport/MessageData/Track[2]/@id": 5, "/StatusReport/MessageData/Track[2]/Speed": 210 });
  assert.deepEqual(f("42.5"), { "(value)": 42.5 });
  assert.deepEqual(f("hello"), {});
  assert.deepEqual(f("<a><b>x</b></a>"), {});
  assert.equal(lib.natsNumericFields(Uint8Array.from([0xff, 0xfe])).size, 0);
});

test("chart builders produce well-formed SVG for edge cases", () => {
  const line = lib.chartLine([{ name: "a", points: [[0, 1], [1, 3], [2, 2]] }, { name: "b", points: [[0, 5], [2, 1]] }], { xFmt: x => "t" + x });
  assert.match(line.svg, /^<svg/); assert.equal(line.plot.series.length, 2);
  assert.equal((line.svg.match(/<path/g) || []).length, 2);                                   // two lines, no area wash when there are two series
  assert.match(lib.chartLine([{ name: "one", points: [[0, 1], [1, 2]] }]).svg, /opacity=".10"/);
  assert.equal(lib.chartLine([{ name: "x", points: [[5, 7]] }]).plot.xmax, 6);                  // a single point still gets an axis
  assert.equal(lib.chartLine([]).plot, null);
  assert.match(lib.chartBars([]), /Nothing to show/);
  const bars = lib.chartBars([{ label: "a<b>", value: 10 }, { label: "long ".repeat(20), value: 0 }]);
  assert.ok(!bars.includes("<b>")); assert.match(bars, /data-i="1"/);                          // labels are escaped, zero-valued rows still render
  assert.match(lib.chartSpark([1, 2, 3]), /<svg/); assert.equal(lib.chartSpark([1]), "");
  assert.equal(lib.chartNum(1500), "1.5K"); assert.equal(lib.chartNum(0.5), "0.50");
});

const UCI = process.env.UCI_SCHEMA_DIR || "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL";
test("real UCI schema: every message type decodes from its own sample", { skip: !fs.existsSync(UCI) }, () => {
  const files = fs.readdirSync(UCI).filter(f => /\.xsd$/i.test(f)).map(f => ({ name: f, text: fs.readFileSync(path.join(UCI, f), "utf8") }));
  const m = lib.xsdModel(files);
  const names = [...m.elements.keys()];
  assert.ok(names.length > 500);
  let n = 0, withFacts = 0, docs = 0;
  for (const name of names.filter((_, i) => i % 7 === 0)) {                                     // a spread of the messages keeps the run short
    const d = lib.uciDecode(m, lib.uciSample(m, name), { validate: true });
    assert.equal(d.known, true, name); assert.equal(d.msgName, name); assert.equal(d.nsMatch, true, name);
    assert.equal(d.validation.ok, true, name + ": " + JSON.stringify(d.validation.errors.slice(0, 2)));
    if (d.facts.length) withFacts++;
    if (lib.uciFirstPara(d.decl.doc)) docs++;
    n++;
  }
  assert.ok(n > 80 && withFacts > n * 0.8 && docs > n * 0.5, `${n} messages, ${withFacts} with header facts, ${docs} documented`);
});
