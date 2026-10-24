const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { lib } = require("./harness");

const ZOO = fs.readFileSync(path.join(__dirname, "fixtures", "zoo.xsd"), "utf8");
const NS = "urn:demo";
const DEMO = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:uci="urn:v" targetNamespace="${NS}" elementFormDefault="qualified" version="001.2.3">
  <xs:include schemaLocation="demo-extra.xsd"/>
  <xs:element name="Mission" type="MissionType" uci:version="009.000.001.000"><xs:annotation><xs:documentation>Top
     level   message.

     Second paragraph.</xs:documentation><xs:documentation>Another note.</xs:documentation></xs:annotation></xs:element>
  <xs:complexType name="BaseType" abstract="true" uci:version="001.000.000.000">
    <xs:sequence><xs:element name="ID" type="UUIDType"><xs:annotation><xs:documentation>The unique id.</xs:documentation></xs:annotation></xs:element></xs:sequence>
    <xs:attribute name="rev" type="xs:int" use="required"/>
  </xs:complexType>
  <xs:complexType name="MissionType">
    <xs:complexContent><xs:extension base="BaseType">
      <xs:sequence>
        <xs:element name="Mode" type="ModeType" minOccurs="0"/>
        <xs:element name="Leg" type="LegType" maxOccurs="unbounded"/>
        <xs:choice><xs:element name="ByName" type="xs:string"/><xs:element name="ByID" type="xs:int"/></xs:choice>
        <xs:element name="Note"><xs:complexType><xs:sequence><xs:element name="Text" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
      </xs:sequence>
    </xs:extension></xs:complexContent>
  </xs:complexType>
  <xs:complexType name="LegType"><xs:sequence><xs:element name="Next" type="LegType" minOccurs="0"/></xs:sequence></xs:complexType>
  <xs:simpleType name="ModeType"><xs:restriction base="xs:string">
    <xs:enumeration value="LIVE"/><xs:enumeration value="SIM"><xs:annotation><xs:documentation>simulated</xs:documentation></xs:annotation></xs:enumeration>
  </xs:restriction></xs:simpleType>
  <xs:simpleType name="UUIDType"><xs:restriction base="xs:string"><xs:pattern value="[0-9a-f-]{36}"/><xs:length value="36"/></xs:restriction></xs:simpleType>
</xs:schema>`;
const OTHER = `<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:other"><simpleType name="Extra"><restriction base="int"><minInclusive value="0"/></restriction></simpleType></schema>`;
const demo = () => lib.xsdModel([{ name: "demo.xsd", text: DEMO }]);

/* ---------------- model ---------------- */

test("model: documentation, versions, structure, anonymous types", () => {
  const m = demo();
  assert.deepEqual(lib.xsdSummary(m), { elements: 1, types: 6, complex: 4, simple: 2, enums: 1 });
  const e = m.elements.get("Mission");
  assert.equal(e.doc, "Top\nlevel message.\n\nSecond paragraph.\n\nAnother note.");      // indentation and repeated spaces tidied, line and paragraph breaks kept, multiple <documentation> joined
  assert.equal(e.version, "009.000.001.000");
  assert.equal(m.types.get("BaseType").version, "001.000.000.000");
  assert.equal(m.types.get("BaseType").abstract, true);
  assert.equal(m.files[0].version, "001.2.3");
  assert.equal(m.files[0].targetNamespace, NS);
  const mt = m.types.get("MissionType");
  assert.equal(mt.base, "BaseType"); assert.equal(mt.derivation, "extension");
  assert.deepEqual(mt.parts.map(p => `${p.name}:${p.type}:${lib.xsdFmtOccurs(p.min, p.max)}${p.choice ? "#" + p.choice.alt + "/" + p.choice.of : ""}`),
    ["Mode:ModeType:0..1", "Leg:LegType:1..∞", "ByName:string:1..1#1/2", "ByID:int:1..1#2/2", "Note:MissionType.Note:1..1"]);
  assert.ok(m.types.has("MissionType.Note"));
  assert.equal(m.types.get("BaseType").parts.find(p => p.name === "ID").doc, "The unique id.");     // member documentation captured
  const mode = m.types.get("ModeType");
  assert.deepEqual(mode.facets.enumeration.map(x => x.value), ["LIVE", "SIM"]);
  assert.equal(mode.facets.enumeration[1].doc, "simulated");
  assert.equal(m.types.get("UUIDType").facets.length, "36");
  assert.deepEqual(m.types.get("UUIDType").facets.pattern, ["[0-9a-f-]{36}"]);
});

test("model: problems are reported, not thrown", () => {
  const m = demo();
  const kinds = m.problems.map(p => p.kind);
  assert.ok(kinds.includes("missing-include"), JSON.stringify(m.problems));
  assert.match(m.problems.find(p => p.kind === "missing-include").message, /demo-extra\.xsd/);
  const bad = lib.xsdModel([`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="A" type="Nope"/><xs:complexType name="T"><xs:sequence><xs:element name="x" type="Missing"/></xs:sequence></xs:complexType><xs:complexType name="D"><xs:complexContent><xs:extension base="GoneBase"/></xs:complexContent></xs:complexType></xs:schema>`]);
  const un = bad.problems.filter(p => p.kind === "unresolved").map(p => p.message);
  assert.equal(un.length, 3);
  assert.ok(un.some(x => /"Nope"/.test(x)) && un.some(x => /"Missing"/.test(x)) && un.some(x => /"GoneBase"/.test(x)));
  const dup = lib.xsdModel([`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:simpleType name="S"><xs:restriction base="xs:int"/></xs:simpleType></xs:schema>`, `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:simpleType name="S"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>`]);
  assert.equal(dup.types.get("S").base, "int");                                       // first definition kept
  assert.ok(dup.problems.some(p => p.kind === "duplicate"));
});

test("model: multiple files, prefixes, failures", () => {
  const m = lib.xsdModel([{ name: "a.xsd", text: DEMO }, { name: "b.xsd", text: OTHER }]);
  assert.equal(m.types.get("Extra").base, "int");
  assert.equal(m.types.get("Extra").facets.minInclusive, "0");
  assert.equal(m.namespaces.size, 2);
  assert.ok(!m.problems.some(p => p.kind === "missing-include" && /a\.xsd/.test(p.message) === false));
  assert.throws(() => lib.xsdModel(["<root/>"]), /not an xs:schema/);
  assert.throws(() => lib.xsdModel(["<xs:schema"]), /Unterminated|Invalid|Unclosed|Malformed/);
  const partial = lib.xsdModel([{ name: "good.xsd", text: OTHER }, { name: "broken.xsd", text: "<a>" }]);       // one bad file does not sink the rest
  assert.equal(partial.files.length, 1);
  assert.ok(partial.problems.some(p => p.kind === "parse" && p.file === "broken.xsd"));
});

test("model: groups, attribute groups, refs, list/union, simple content, substitution", () => {
  const m = lib.xsdModel([ZOO]);
  assert.ok(m.groups.has("G"));
  const gm = lib.xsdMembers(m, m.elements.get("GroupMsg").type);
  assert.deepEqual(gm.filter(x => x.kind === "element").map(x => x.name), ["g1", "g2", "z"]);
  assert.deepEqual(gm.filter(x => x.kind === "group").map(x => x.name), ["G"]);
  assert.equal(m.types.get("ListT").simpleKind, "list");
  assert.equal(m.types.get("UnionT").simpleKind, "union");
  assert.deepEqual(m.types.get("UnionT").memberTypes, ["int", "EnumT"]);
  assert.equal(m.types.get("SCT").simpleContent, true);
  assert.deepEqual(lib.xsdMembers(m, "SCT").map(x => `${x.kind}:${x.name}:${x.use}`), ["attribute:unit:required"]);
  assert.deepEqual([...m.substitutes.get("Head")], ["MemberA", "MemberB"]);
  assert.equal(m.problems.filter(p => p.level === "error").length, 0);
});

test("chain, members, outline tree, paths", () => {
  const m = demo();
  assert.deepEqual(lib.xsdChain(m, "MissionType").map(t => t.name), ["BaseType", "MissionType"]);
  const mem = lib.xsdMembers(m, "MissionType");
  assert.deepEqual(mem.map(x => `${x.inherited ? "^" : ""}${x.name}`), ["^ID", "^rev", "Mode", "Leg", "ByName", "ByID", "Note"]);
  assert.equal(mem[0].from, "BaseType");
  const tree = lib.xsdTree(m, "MissionType", 3);
  assert.equal(tree[0], "⤷ extends BaseType");
  assert.ok(tree.includes("ID  : UUIDType"));
  assert.ok(tree.includes("@rev  : int  (required)"));
  assert.ok(tree.includes("Mode [0..1]  : ModeType"));
  assert.ok(tree.includes("  enum: LIVE | SIM"));
  assert.ok(tree.includes("Leg [1..∞]  : LegType"));
  assert.ok(tree.some(l => /^│ ByName/.test(l)));
  assert.ok(tree.some(l => /↺ recursive/.test(l)));
  assert.ok(!lib.xsdTree(m, "MissionType", 0).some(l => l.startsWith("  ")));
  assert.deepEqual(lib.xsdTree(m, "NoSuchType"), []);
  assert.ok(lib.xsdTree(m, "MissionType", 1, { docs: true }).some(l => l.endsWith("— The unique id.")));
  const paths = lib.xsdPaths(m, "MissionType", "Mission");
  assert.ok(paths.some(p => p.path === "/Mission/Note/Text" && p.leaf));
  assert.ok(paths.some(p => p.path === "/Mission/Leg/Next" && p.recursive));
  assert.ok(paths.some(p => p.path === "/Mission/@rev" && p.kind === "attribute"));
  assert.ok(!paths.some(p => p.path.startsWith("/Mission/Leg/Next/")), "does not recurse into a recursive type");
});

test("complexContent restriction replaces inherited content", () => {
  const m = lib.xsdModel([`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:complexType name="B"><xs:sequence><xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType><xs:complexType name="R"><xs:complexContent><xs:restriction base="B"><xs:sequence><xs:element name="a" type="xs:string"/></xs:sequence></xs:restriction></xs:complexContent></xs:complexType></xs:schema>`]);
  assert.deepEqual(lib.xsdMembers(m, "R").map(x => x.name), ["a"]);
});

test("reverse lookups: used by, derived, messages, dependencies", () => {
  const m = lib.xsdModel([{ name: "demo.xsd", text: DEMO }]);
  assert.deepEqual((m.usedBy.get("ModeType") || []).map(u => `${u.owner}.${u.member}`), ["MissionType.Mode"]);
  assert.deepEqual(m.derived.get("BaseType"), ["MissionType"]);
  assert.deepEqual(lib.xsdMessagesUsing(m, "ModeType"), ["Mission"]);             // enum -> MissionType -> element
  assert.deepEqual(lib.xsdMessagesUsing(m, "UUIDType"), ["Mission"]);             // via the base type's member, reached through derivation
  assert.deepEqual(lib.xsdMessagesUsing(m, "BaseType"), ["Mission"]);
  assert.deepEqual(lib.xsdDependencies(m, "MissionType").sort(), ["BaseType", "LegType", "MissionType.Note", "ModeType", "UUIDType"]);
  assert.equal(lib.xsdFamily("AccessAssessmentRequestStatus"), "Status");
  assert.equal(lib.xsdFamily("AO_CapabilityStatus"), "Status");
  const cats = Object.fromEntries([...m.types.values()].map(t => [t.name, lib.xsdCategory(m, t)]));
  assert.equal(cats.ModeType, "enum"); assert.equal(cats.MissionType, "msgtype"); assert.equal(cats.BaseType, "base"); assert.equal(cats.UUIDType, "simple");
});

test("search: ranking, scope, kinds, category, filter", () => {
  const m = lib.xsdModel([{ name: "demo.xsd", text: DEMO }]), idx = lib.xsdIndex(m);
  const names = (q, o) => lib.xsdSearch(idx, q, o).results.map(e => `${e.kind}:${e.owner ? e.owner + "." : ""}${e.name}`);
  assert.equal(names("mission")[0], "element:Mission");                       // exact beats prefix
  assert.deepEqual(names("mode").slice(0, 2), ["member:MissionType.Mode", "type:ModeType"]);          // an exact name beats a prefix match
  assert.deepEqual(names("sim", { kinds: new Set(["value"]) }), ["value:ModeType.SIM"]);
  assert.deepEqual(names("unique"), []);                                      // doc-only text not matched by default
  assert.ok(names("unique", { docs: true }).includes("member:BaseType.ID"));
  assert.deepEqual(names("zzz", { kinds: new Set(["type"]), cat: "enum" }), []);
  assert.deepEqual(names("type", { kinds: new Set(["type"]), cat: "enum" }), ["type:ModeType"]);          // category filter keeps only enumerations
  assert.deepEqual(names("", { kinds: new Set(["type"]), cat: "enum" }), ["type:ModeType"]);
  assert.deepEqual(names("leg next", { kinds: new Set(["member", "type"]) }), []);                 // all terms must match one entry's name
  assert.ok(names("note text").length === 0);
  assert.equal(lib.xsdSearch(idx, "e", { limit: 2 }).results.length, 2);
  assert.ok(lib.xsdSearch(idx, "e", { limit: 2 }).total > 2);
  assert.deepEqual(names("", { filter: e => e.kind === "element" }), ["element:Mission"]);
  assert.ok(names("regime").length === 0);
});

/* ---------------- validator ---------------- */

const doc = body => `<Mission xmlns="${NS}" rev="1">${body}</Mission>`;
const GOOD = doc(`<ID>123e4567-e89b-12d3-a456-426614174000</ID><Leg><Next><Next/></Next></Leg><ByName>x</ByName><Note><Text>t</Text></Note>`);
const val = (xml, m = demo()) => lib.xsdValidate(m, xml);
const msgs = r => r.errors.map(e => e.message);

test("validate: accepts a good message; nothing is reported", () => {
  const r = val(GOOD);
  assert.deepEqual(msgs(r), []); assert.equal(r.ok, true); assert.equal(r.root, "Mission"); assert.ok(r.elements >= 8);
});

test("validate: structure errors say what was expected", () => {
  let r = val(doc(`<Leg/><ByName>x</ByName><Note><Text>t</Text></Note>`));            // ID missing
  assert.match(msgs(r)[0], /unexpected element <Leg>.*expected <ID>/);
  r = val(doc(`<ID>123e4567-e89b-12d3-a456-426614174000</ID><Leg/><ByName>x</ByName>`));      // Note missing at the end
  assert.match(msgs(r)[0], /incomplete: required element <Note> is missing/);
  assert.equal(r.errors[0].path, "/Mission");
  r = val(doc(`<ID>123e4567-e89b-12d3-a456-426614174000</ID><Leg/><ByName>x</ByName><ByID>1</ByID><Note><Text>t</Text></Note>`));
  assert.match(msgs(r)[0], /unexpected element <ByID> \(<ByID> is allowed, but not at this position/);
  r = val(doc(`<ID>123e4567-e89b-12d3-a456-426614174000</ID><Leg/><Mode>LIVE</Mode><ByName>x</ByName><Note><Text>t</Text></Note>`));    // Mode must come before Leg
  assert.match(msgs(r)[0], /unexpected element <Mode>/);
  r = val(doc(`<ID>123e4567-e89b-12d3-a456-426614174000</ID><Leg/><ByName>x</ByName><Note><Text>t</Text><Text>u</Text></Note>`));
  assert.match(msgs(r)[0], /unexpected element <Text>.*no more elements are allowed here/);
  assert.equal(r.errors[0].path, "/Mission/Note/Text[2]");
  r = val(doc(`<ID>123e4567-e89b-12d3-a456-426614174000</ID><Leg/><ByName>x</ByName><Note><Text>t</Text></Note>stray`));
  assert.match(msgs(r)[0], /has text \("stray"\) but its type "MissionType" only allows child elements/);
});

test("validate: value errors (enum, pattern, length, type, attributes)", () => {
  const ok = `<ID>123e4567-e89b-12d3-a456-426614174000</ID>`, tail = `<ByName>x</ByName><Note><Text>t</Text></Note>`;
  let r = val(doc(`${ok}<Mode>NOPE</Mode><Leg/>${tail}`));
  assert.match(msgs(r)[0], /<Mode> "NOPE" is not one of the 2 allowed values: LIVE, SIM/);
  r = val(doc(`<ID>XYZ</ID><Leg/>${tail}`));
  assert.match(msgs(r)[0], /<ID> "XYZ" does not match the pattern "\[0-9a-f-\]\{36\}"/);
  r = val(doc(`${ok}<Leg/><ByID>12x</ByID><Note><Text>t</Text></Note>`));
  assert.match(msgs(r)[0], /<ByID> "12x" is not a valid xs:int/);
  r = val(`<Mission xmlns="${NS}">${ok}<Leg/>${tail}</Mission>`);
  assert.match(msgs(r)[0], /missing required attribute "rev"/);
  r = val(`<Mission xmlns="${NS}" rev="x">${ok}<Leg/>${tail}</Mission>`);
  assert.match(msgs(r)[0], /attribute "rev" .*not a valid xs:int/);
  r = val(`<Mission xmlns="${NS}" rev="1" extra="1">${ok}<Leg/>${tail}</Mission>`);
  assert.match(msgs(r)[0], /unexpected attribute "extra" on <Mission>; allowed: rev/);
});

test("validate: root, namespace, xml errors", () => {
  assert.match(msgs(val(`<Missio xmlns="${NS}"/>`))[0], /not a global element.*Did you mean: Mission/);
  const ns = val(`<Mission rev="1"><ID>x</ID></Mission>`);
  assert.match(msgs(ns)[0], /has no namespace; the schema expects "urn:demo" \(add xmlns="urn:demo"\)/);
  assert.equal(ns.errors[0].kind, "namespace");
  assert.match(msgs(val(`<Mission xmlns="urn:wrong" rev="1"/>`))[0], /is in namespace "urn:wrong" but the schema expects "urn:demo"/);
  const bad = val("<a><b></a>");
  assert.equal(bad.errors[0].kind, "xml"); assert.equal(bad.errors[0].line, 1); assert.equal(bad.errors[0].col, 7);
  assert.equal(val(GOOD.replace('xmlns="urn:demo"', 'xmlns:d="urn:demo"').replace(/<(\/?)Mission/g, "<$1d:Mission")).errors[0].kind, "namespace", "children left without a namespace are flagged");
  const r = val(GOOD.replace("<ID>", "\n  <ID>").replace("<Note>", "\n<Note>").replace("<Text>t", "<Text>"));
  assert.ok(r.errors.every(e => e.line >= 1), "errors carry line numbers");
});

test("validate: errors report line and column of the offending element", () => {
  const xml = `<Mission xmlns="${NS}" rev="1">\n  <ID>123e4567-e89b-12d3-a456-426614174000</ID>\n  <Leg/>\n  <Mode>BAD</Mode>\n</Mission>`;
  const r = val(xml);
  const modeErr = r.errors.find(e => /<Mode>/.test(e.message) && e.kind === "structure" || /unexpected element <Mode>/.test(e.message));
  assert.ok(modeErr); assert.equal(modeErr.line, 4); assert.equal(modeErr.col, 3);
});

test("validate: zoo features (all, simple content, nil, substitution, abstract, empty, mixed, list, union)", () => {
  const m = lib.xsdModel([ZOO]), z = (root, inner, attrs = "") => lib.xsdValidate(m, `<${root} xmlns="urn:zoo" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="urn:zoo"${attrs}>${inner}</${root}>`);
  const bad = (r, re) => { assert.equal(r.ok, false); assert.match(r.errors[0].message, re); };
  assert.equal(z("AllMsg", "<q>1</q><p>x</p>").ok, true);
  bad(z("AllMsg", "<q>1</q>"), /incomplete.*<p>/); bad(z("AllMsg", "<p>1</p><p>2</p>"), /unexpected element <p>/);
  assert.equal(z("SCMsg", "5", ' unit="m"').ok, true);
  bad(z("SCMsg", "5"), /missing required attribute "unit"/); bad(z("SCMsg", "x", ' unit="m"'), /not a valid xs:int/);
  assert.equal(z("NilMsg", '<n xsi:nil="true"/>').ok, true);
  bad(z("NilMsg", '<m xsi:nil="true"/>'), /not nillable/); bad(z("NilMsg", '<n xsi:nil="true">x</n>'), /must be empty/);
  assert.equal(z("SubstMsg", "<MemberA>a</MemberA><MemberB>2</MemberB><Head>h</Head>").ok, true);
  bad(z("SubstMsg", "<MemberB>x</MemberB>"), /not a valid xs:int/);
  assert.equal(z("AbstractMsg", "<name>n</name><x>1</x>", ' xsi:type="z:DerA"').ok, true);
  bad(z("AbstractMsg", "<name>n</name>"), /abstract type "BaseA".*xsi:type/);
  bad(z("AbstractMsg", "<name>n</name><x>1</x>", ' xsi:type="z:SeqT"'), /not derived from "BaseA"/);
  assert.equal(z("EmptyMsg", "").ok, true); bad(z("EmptyMsg", " "), /must be empty/);
  assert.equal(z("MixedMsg", "hi <i>1</i> there").ok, true);
  assert.equal(z("Root", "<List>1 2  3</List><ListLen>1 2 3</ListLen><Union>7</Union>").ok, true);
  assert.equal(z("Root", "<Union>B</Union>").ok, true);
  bad(z("Root", "<ListLen>1 2</ListLen>"), /list length 2 is not the required length 3/); bad(z("Root", "<Union>Z</Union>"), /matches none of the union/);
  bad(z("Root", "<Dec>1.234</Dec>"), /fractionDigits 2/); bad(z("Root", "<Dec>12345.6</Dec>"), /totalDigits 5/); assert.equal(z("Root", "<Dec>1234.5</Dec>").ok, true);
  bad(z("Root", "<Pat2>AB12</Pat2>"), /does not match the pattern ".\*9"/); bad(z("Root", "<RangeX>1</RangeX>"), /violates maxExclusive 1/);
  bad(z("Root", "<UByte>+5</UByte>"), /leading "\+" is rejected by \.NET/); bad(z("Root", "<DT>2026-01-01T24:00:00Z</DT>"), /24:00:00/);
  bad(z("Root", "<DT>2026-02-30T00:00:00Z</DT>"), /not a real calendar date/);
  assert.equal(z("Root", "<Collapse>  a   b </Collapse>").ok, true, "token whitespace is collapsed before the pattern check");
});

test("validate: error cap and reporting limits", () => {
  const m = lib.xsdModel([ZOO]);
  const r = lib.xsdValidate(m, `<Root xmlns="urn:zoo">${"<Int>x</Int>".repeat(500)}</Root>`, { maxErrors: 10 });
  assert.equal(r.errors.length, 10); assert.equal(r.truncated, true);
});

/* ---------------- sample generation ---------------- */

test("regexSample satisfies realistic XSD patterns", () => {
  const pats = ["[A-Z0-9 ]{8}", "[a-zA-Z0-9 \\-_]{1,20}", "1?[1-7][1-8]{2}", "[A-Z]{2}|[ ]{2}", "[A-Z0-9]{2}-[0-9]{4}[TE]?", "[a-zA-Z0-9_\\-]+\\.[a-zA-Z0-9_\\.\\-]+", "((:|[0-9a-fA-F]{0,4}):)([0-9a-fA-F]{0,4}:){0,5}[0-9a-fA-F]{1,4}",
    "(0{8}(-0{4}){3}-0{12})|([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-5][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12})", ".+Z", "[ -~]{6}", "([A-Z]{2} ){3} {2}", " {11}", "[\\-\\.,\\(\\)\\?A-Z0-9 ]{1,30}",
    "(([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\\.){3}([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])", "[0-9]\\.[0-9]", "\\d{4}-\\d{2}", "[a-z]{0}"];
  for (const p of pats) {
    const s = lib.regexSample(p);
    assert.notEqual(s, null, p);
    assert.ok(new RegExp("^(?:" + p + ")$").test(s), `${p} -> ${JSON.stringify(s)}`);
  }
  const long = lib.regexSample("[a-z]+", { minLen: 12, maxLen: 20 });
  assert.ok(long.length >= 12 && long.length <= 20, long);
  assert.equal(lib.regexSample("[a-z]{3}", { minLen: 5 }), null, "impossible length requirement");
  assert.equal(lib.regexSample("("), null, "bad pattern");
});

test("sample values honour facets", () => {
  const m = lib.xsdModel([ZOO]), v = n => lib.xsdSampleValue(m, lib.xsdSimpleInfo(m, n));
  for (const t of ["Dec52", "Len4", "Str3to5", "PatT", "Pat2T", "EnumT", "EnumIntT", "RangeT", "RangeXT", "ListT", "ListLenT", "UnionT", "CollapseT", "int", "unsignedByte", "positiveInteger", "negativeInteger", "boolean", "dateTime", "date", "time", "duration", "hexBinary", "base64Binary", "gYear", "language", "double", "anyURI", "string", "token"]) {
    const val = v(t), err = lib.xsdCheckValue(m, lib.xsdSimpleInfo(m, t), val);
    assert.equal(err, null, `${t}: ${JSON.stringify(val)} -> ${err}`);
  }
  assert.equal(v("EnumT"), "A"); assert.equal(v("RangeT"), "1"); assert.equal(v("RangeXT"), "0.5"); assert.equal(v("negativeInteger"), "-1"); assert.equal(v("Len4").length, 4);
});

test("skeleton: valid for required-only and everything, with hints, types and abstract handling", () => {
  const m = demo();
  for (const all of [false, true]) {
    const r = lib.xsdSkeleton(m, "Mission", { all, hints: false });
    assert.deepEqual(r.warnings, []);
    assert.equal(lib.xsdValidate(m, r.xml).ok, true, r.xml);
  }
  const req = lib.xsdSkeleton(m, "Mission", { hints: false }).xml, all = lib.xsdSkeleton(m, "Mission", { all: true, hints: false }).xml;
  assert.ok(!/<Mode>/.test(req) && /<Mode>LIVE<\/Mode>/.test(all));
  assert.match(req, /<Mission xmlns="urn:demo" rev="0">/);          // required attributes are included
  const hinted = lib.xsdSkeleton(m, "Mission", { all: true }).xml;
  assert.match(hinted, /<!-- LIVE \| SIM -->/); assert.match(hinted, /<!-- choice: ByName \| ByID -->/);
  assert.equal(lib.xsdValidate(m, hinted).ok, true, "hint comments do not affect validity");
  const t = lib.xsdSkeleton(m, "LegType", { rootName: "Leg" });                          // a bare type becomes a root element
  assert.match(t.xml, /<Leg xmlns="urn:demo"\/>|<Leg xmlns="urn:demo">/);
  assert.throws(() => lib.xsdSkeleton(m, "Nope"), /not a global element or type/);
  const z = lib.xsdModel([ZOO]);
  for (const n of z.elements.keys()) for (const all2 of [false, true]) {
    const r = lib.xsdSkeleton(z, n, { all: all2, hints: false });
    assert.equal(lib.xsdValidate(z, r.xml).ok, true, `${n} (all=${all2}):\n${r.xml}\n${JSON.stringify(lib.xsdValidate(z, r.xml).errors[0])}`);
  }
  assert.match(lib.xsdSkeleton(z, "AbstractMsg", { hints: false }).xml, /xsi:type="DerA"/);
});

test("skeleton: unqualified locals use a prefixed root; recursion and size are bounded", () => {
  const m = lib.xsdModel([`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:u"><xs:element name="R"><xs:complexType><xs:sequence><xs:element name="c" type="xs:int"/></xs:sequence></xs:complexType></xs:element></xs:schema>`]);
  const r = lib.xsdSkeleton(m, "R", { hints: false });
  assert.match(r.xml, /<tns:R xmlns:tns="urn:u">\s*<c>0<\/c>/);
  assert.equal(lib.xsdValidate(m, r.xml).ok, true);
  const rec = lib.xsdModel([`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="N" type="NT"/><xs:complexType name="NT"><xs:sequence><xs:element name="n" type="NT" minOccurs="0"/><xs:element name="v" type="xs:int"/></xs:sequence></xs:complexType></xs:schema>`]);
  assert.equal(lib.xsdValidate(rec, lib.xsdSkeleton(rec, "N", { all: true, hints: false }).xml).ok, true);
});

/* ---------------- real UCI schema (skipped when the folder is not available) ---------------- */

const UCI_DIR = process.env.UCI_SCHEMA_DIR || "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL";
const haveUci = fs.existsSync(path.join(UCI_DIR, "UCI_MessageDefinitions_v2_6_0.xsd"));
let uci;
const loadUci = () => uci || (uci = lib.xsdModel(fs.readdirSync(UCI_DIR).filter(f => f.endsWith(".xsd")).map(n => ({ name: n, text: fs.readFileSync(path.join(UCI_DIR, n), "utf8") }))));

test("UCI 2.6: loads cleanly with the expected shape", { skip: !haveUci && "UCI schema folder not found" }, () => {
  const m = loadUci(), s = lib.xsdSummary(m);
  assert.equal(m.files.length, 3);
  assert.equal(s.elements, 725);
  assert.ok(s.types > 5500 && s.enums > 700);
  assert.deepEqual(m.problems, [], "no unresolved references, duplicates or missing includes");
  assert.equal(m.targetNamespace, "https://www.vdl.afrl.af.mil/programs/oam");
  assert.ok(m.files.every(f => f.version === "002.6.0"));
  assert.equal(m.types.get("MessageType") !== undefined, true);
  assert.equal(m.types.get("AccessAssessmentMT").base, "MessageType");
  assert.ok(m.elements.get("AccessAssessment").doc.length > 20);
  assert.match(m.types.get("DateTimeType").facets.pattern[0], /Z/);
  assert.ok([...m.types.values()].every(t => t.doc !== undefined));
  const om = lib.xsdMembers(m, "AccessAssessmentMT").map(x => x.name);
  assert.deepEqual(om.slice(0, 4), ["SecurityInformation", "MessageHeader", "ObjectState", "MessageData"]);
});

test("UCI 2.6: search finds members, enum values and documentation quickly", { skip: !haveUci && "UCI schema folder not found" }, () => {
  const m = loadUci(), idx = lib.xsdIndex(m), t0 = Date.now();
  const q = (s, o) => lib.xsdSearch(idx, s, o).results.map(e => `${e.kind}:${e.owner ? e.owner + "." : ""}${e.name}`);
  assert.equal(q("OrbitRegimeEnum")[0], "type:OrbitRegimeEnum");
  assert.ok(q("vleo").includes("value:OrbitRegimeEnum.VLEO"));
  assert.ok(q("latitude").some(x => x.startsWith("member:Point2D_Type.Latitude")));
  assert.ok(q("orbit regime").slice(0, 3).includes("type:OrbitRegimeEnum"));
  assert.equal(q("prediction").length, 0);                              // not in any name...
  assert.ok(q("prediction", { docs: true }).length >= 5);               // ...but found in the documentation
  assert.ok(q("confidence", { docs: true }).includes("member:AssociatedEntityIDsType.Confidence") || q("confidence").some(x => /Confidence$/.test(x)));
  assert.ok(Date.now() - t0 < 1500, `search too slow: ${Date.now() - t0} ms`);
  assert.ok(lib.xsdMessagesUsing(m, "OrbitRegimeEnum").length > 20);
  const families = new Set([...m.elements.keys()].map(lib.xsdFamily));
  assert.ok(families.has("Status") && families.has("Command") && families.has("Request"));
});

test("UCI 2.6: every message skeleton (required-only and everything) validates", { skip: !haveUci && "UCI schema folder not found" }, () => {
  const m = loadUci(); let n = 0;
  for (const name of m.elements.keys()) for (const all of [false, true]) {
    const r = lib.xsdSkeleton(m, name, { all, maxDepth: all ? 8 : 14, hints: false });
    const v = lib.xsdValidate(m, r.xml, { maxErrors: 3 });
    assert.equal(v.ok, true, `${name} all=${all}: ${v.errors[0] && v.errors[0].path + " " + v.errors[0].message}`);
    assert.deepEqual(r.warnings, [], `${name}: ${r.warnings[0]}`);
    n++;
  }
  assert.equal(n, 1450);
});

test("UCI 2.6: realistic mistakes are caught with useful messages", { skip: !haveUci && "UCI schema folder not found" }, () => {
  const m = loadUci(), good = lib.xsdSkeleton(m, "AccessAssessment", { hints: false }).xml;
  const first = xml => lib.xsdValidate(m, xml).errors[0];
  assert.match(first(good.replace("<Mode>LIVE</Mode>", "<Mode>LIVEX</Mode>")).message, /"LIVEX" is not one of the 4 allowed values: LIVE, EXERCISE, SIMULATION, NONEXERCISE_SIMULATION/);
  assert.match(first(good.replace(/<Timestamp>.*<\/Timestamp>/, "<Timestamp>2026-01-01T00:00:00</Timestamp>")).message, /does not match the pattern ".\+Z"/);
  assert.match(first(good.replace(/<UUID>[^<]*<\/UUID>/, "<UUID>not-a-uuid</UUID>")).message, /does not match the pattern/);
  assert.match(first(good.replace(/<MessageData>[\s\S]*<\/MessageData>/, "<MessageData/>")).message, /incomplete: .*<AccessAssessmentID>/);
  assert.match(first(good.replace(' xmlns="https://www.vdl.afrl.af.mil/programs/oam"', "")).message, /has no namespace; the schema expects "https:\/\/www\.vdl\.afrl\.af\.mil\/programs\/oam"/);
  const swapped = good.replace(/(<SecurityInformation>[\s\S]*?<\/SecurityInformation>)\s*(<MessageHeader>[\s\S]*?<\/MessageHeader>)/, "$2$1");
  assert.match(first(swapped).message, /unexpected element <MessageHeader>.*expected <SecurityInformation>/);
});
