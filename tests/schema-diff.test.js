const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { lib } = require("./harness");

const head = '<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" elementFormDefault="qualified" version="001.0.0">';
const A = head + `
  <xs:element name="Status" type="StatusType"/>
  <xs:element name="Gone" type="StatusType"/>
  <xs:element name="Retyped" type="StatusType"/>
  <xs:element name="Quiet" type="QuietType"/>
  <xs:complexType name="StatusType"><xs:sequence>
    <xs:element name="ID" type="xs:string"/>
    <xs:element name="State" type="StateType"/>
    <xs:element name="Level" type="LevelType"/>
    <xs:element name="Old" type="xs:string" minOccurs="0"/>
    <xs:element name="Count" type="xs:int" minOccurs="0" maxOccurs="5"/>
    <xs:element name="Narrow" type="xs:string" minOccurs="0"/>
    <xs:choice><xs:element name="ByName" type="xs:string"/><xs:element name="ByNum" type="xs:int"/></xs:choice>
  </xs:sequence></xs:complexType>
  <xs:complexType name="QuietType"><xs:sequence><xs:element name="Q" type="xs:string"><xs:annotation><xs:documentation>first words</xs:documentation></xs:annotation></xs:element></xs:sequence></xs:complexType>
  <xs:simpleType name="StateType"><xs:restriction base="xs:string"><xs:enumeration value="ON"/><xs:enumeration value="OFF"/><xs:enumeration value="BROKEN"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="LevelType"><xs:restriction base="xs:int"><xs:minInclusive value="0"/><xs:maxInclusive value="10"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="CodeType"><xs:restriction base="xs:string"><xs:pattern value="[A-Z]{3}"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="Unused"><xs:restriction base="xs:string"/></xs:simpleType>
</xs:schema>`;
const B = head + `
  <xs:element name="Status" type="StatusType"/>
  <xs:element name="Fresh" type="StatusType"/>
  <xs:element name="Retyped" type="QuietType"/>
  <xs:element name="Quiet" type="QuietType"/>
  <xs:complexType name="StatusType"><xs:sequence>
    <xs:element name="State" type="StateType"/>
    <xs:element name="ID" type="xs:string"/>
    <xs:element name="Level" type="LevelType"/>
    <xs:element name="Extra" type="xs:string"/>
    <xs:element name="Optional" type="xs:string" minOccurs="0"/>
    <xs:element name="Count" type="xs:int" minOccurs="0" maxOccurs="3"/>
    <xs:element name="Narrow" type="xs:string" minOccurs="1"/>
    <xs:choice><xs:element name="ByName" type="xs:string"/><xs:element name="ByNum" type="xs:int"/><xs:element name="ByUuid" type="xs:string"/></xs:choice>
  </xs:sequence></xs:complexType>
  <xs:complexType name="QuietType"><xs:sequence><xs:element name="Q" type="xs:string"><xs:annotation><xs:documentation>different words</xs:documentation></xs:annotation></xs:element></xs:sequence></xs:complexType>
  <xs:simpleType name="StateType"><xs:restriction base="xs:string"><xs:enumeration value="ON"/><xs:enumeration value="OFF"/><xs:enumeration value="STANDBY"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="LevelType"><xs:restriction base="xs:int"><xs:minInclusive value="1"/><xs:maxInclusive value="20"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="CodeType"><xs:restriction base="xs:string"><xs:pattern value="[A-Z]{4}"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="Fresh"><xs:restriction base="xs:string"/></xs:simpleType>
</xs:schema>`;
const ma = lib.xsdModel([{ name: "a.xsd", text: A }]), mb = lib.xsdModel([{ name: "b.xsd", text: B }]);
const d = lib.schemaDiff(ma, mb);
const type = n => d.types.find(t => t.name === n), msg = n => d.messages.find(m => m.name === n);
const texts = (x, sev) => x.changes.filter(c => !sev || c.severity === sev).map(c => c.text).join(" | ");

test("added, removed and retyped messages", () => {
  assert.equal(msg("Fresh").status, "added"); assert.equal(msg("Fresh").severity, "additive");
  assert.equal(msg("Gone").status, "removed"); assert.equal(msg("Gone").severity, "breaking");
  assert.equal(msg("Retyped").severity, "breaking"); assert.match(texts(msg("Retyped")), /type StatusType → QuietType/);
  assert.equal(msg("Quiet"), undefined, "documentation-only changes are not reported unless asked");
});

test("member changes are classified from the point of view of the old schema", () => {
  const t = type("StatusType");
  assert.equal(t.status, "changed"); assert.equal(t.severity, "breaking");
  const b = texts(t, "breaking"), a = texts(t, "additive");
  assert.match(b, /removed member Old/); assert.match(b, /added member Extra .*required/); assert.match(b, /Narrow: minimum occurrences 0 → 1/); assert.match(b, /Count: maximum occurrences 5 → 3/);
  assert.match(a, /added member Optional/); assert.match(a, /added member ByUuid .*choice alternative/);
  assert.match(texts(t, "review"), /member order changed/); assert.match(texts(t, "review"), /choice structure changed/);
  assert.ok(msg("Status").impacts.some(i => i.type === "StatusType" && i.severity === "breaking"));
  assert.equal(msg("Status").severity, "breaking");
});

test("enumeration, range and pattern changes", () => {
  assert.match(texts(type("StateType"), "breaking"), /removed value: BROKEN/); assert.match(texts(type("StateType"), "additive"), /added value: STANDBY/);
  const lv = type("LevelType");
  assert.match(texts(lv, "breaking"), /minInclusive 0 → 1 \(narrower\)/); assert.match(texts(lv, "additive"), /maxInclusive 10 → 20 \(wider\)/);
  assert.equal(type("CodeType").severity, "review"); assert.match(texts(type("CodeType")), /pattern changed/);
});

test("types that appear or disappear", () => {
  assert.equal(type("Fresh").status, "added");
  assert.equal(type("Unused").status, "removed"); assert.equal(type("Unused").severity, "review");           // nothing used it
  assert.equal(lib.schemaDiff(ma, ma).types.length, 0); assert.equal(lib.schemaDiff(ma, ma).messages.length, 0);
});

test("documentation changes are reported on request", () => {
  const dd = lib.schemaDiff(ma, mb, { docs: true });
  assert.ok(dd.types.find(t => t.name === "QuietType").changes.some(c => c.severity === "docs"));
  assert.equal(dd.messages.find(m => m.name === "Quiet").severity, "docs");
});

test("summary and reports", () => {
  assert.equal(d.summary.messages.added, 1); assert.equal(d.summary.messages.removed, 1); assert.ok(d.summary.messages.breaking >= 2);
  assert.deepEqual(d.a.versions, ["001.0.0"]);
  const md = lib.schemaDiffMarkdown(d, { labelA: "A", labelB: "B", min: "breaking" });
  assert.match(md, /^# Schema comparison: A → B/); assert.match(md, /\*\*Gone\*\*/); assert.doesNotMatch(md, /added value: STANDBY/);
  const csv = lib.schemaDiffCsv(d).split("\n");
  assert.equal(csv[0], "scope,name,status,severity,change"); assert.ok(csv.some(l => l.startsWith("type,StateType,changed,breaking,")));
  assert.ok(csv.every(l => !l || /^(scope|message|type),/.test(l)));
});

const OLD = process.env.UCI_SCHEMA_DIR_OLD, NEW = process.env.UCI_SCHEMA_DIR || "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL";
test("real schemas: two UCI versions compared (set UCI_SCHEMA_DIR_OLD to a second version to run)", { skip: !(OLD && fs.existsSync(OLD) && fs.existsSync(NEW)) }, () => {
  const load = dir => lib.xsdModel(fs.readdirSync(dir).filter(f => /\.xsd$/i.test(f)).map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), "utf8") })));
  const r = lib.schemaDiff(load(OLD), load(NEW));
  assert.ok(r.messages.length + r.types.length > 0);
  assert.equal(lib.schemaDiff(load(NEW), load(NEW)).types.length, 0);
});
