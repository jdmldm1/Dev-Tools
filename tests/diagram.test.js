const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { lib } = require("./harness");

const DEMO = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:demo" elementFormDefault="qualified">
  <xs:element name="Mission" type="MissionType"/>
  <xs:complexType name="BaseType"><xs:sequence><xs:element name="ID" type="xs:string"/><xs:element name="Meta" type="MetaType"/></xs:sequence></xs:complexType>
  <xs:complexType name="MetaType"><xs:sequence><xs:element name="Owner" type="xs:string"/></xs:sequence></xs:complexType>
  <xs:complexType name="MissionType"><xs:complexContent><xs:extension base="BaseType"><xs:sequence>
    <xs:element name="Mode" type="ModeType" minOccurs="0"/>
    <xs:element name="Leg" type="LegType" maxOccurs="unbounded"/>
    <xs:choice><xs:element name="ByName" type="xs:string"/><xs:element name="ByID" type="xs:int"/></xs:choice>
    <xs:element name="Note"><xs:complexType><xs:sequence><xs:element name="Text" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
  </xs:sequence></xs:extension></xs:complexContent></xs:complexType>
  <xs:complexType name="LegType"><xs:sequence><xs:element name="Next" type="LegType" minOccurs="0"/></xs:sequence></xs:complexType>
  <xs:simpleType name="ModeType"><xs:restriction base="xs:string"><xs:enumeration value="LIVE"/><xs:enumeration value="SIM"/></xs:restriction></xs:simpleType>
</xs:schema>`;
const demo = () => lib.xsdModel([{ name: "demo.xsd", text: DEMO }]);

/* Structural invariants every layout must satisfy. */
function checkLayout(L, label = "") {
  const byId = new Map(L.nodes.map(n => [n.id, n]));
  assert.equal(byId.size, L.nodes.length, label + " duplicate ids");
  assert.equal(L.edges.length, L.nodes.length - 1, label + " one edge per non-root node");
  const cols = new Map();
  for (const n of L.nodes) { (cols.get(n.depth) || cols.set(n.depth, []).get(n.depth)).push(n); assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= L.width + 0.5 && n.y + n.h <= L.height + 0.5, `${label} ${n.id} inside the canvas`); }
  for (const [d, col] of cols) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) assert.ok(col[i].y >= col[i - 1].y + col[i - 1].h, `${label} overlap in column ${d}: ${col[i - 1].id} / ${col[i].id}`);
    assert.ok(col.every(n => n.x === col[0].x), `${label} column ${d} aligned`);
  }
  for (const e of L.edges) { const p = byId.get(e.from), c = byId.get(e.to); assert.ok(p && c && c.x > p.x + p.w, `${label} edge ${e.from}->${e.to} runs left to right`); }
  for (const n of L.nodes) if (n.vis.length) {
    const a = n.vis[0], b = n.vis[n.vis.length - 1];
    assert.ok(Math.abs((n.y + n.h / 2) - ((a.y + a.h / 2 + b.y + b.h / 2) / 2)) < 0.01, `${label} ${n.id} centred on its children`);
  }
}

test("default expansion: own members open, inherited collapsed, depth counts levels of members", () => {
  const m = demo();
  const names = ids => ids;
  const d1 = lib.xsdDiagramDefaultExpansion(m, "MissionType", "Mission", { depth: 1 });
  assert.deepEqual([...d1], ["0"], "depth 1 shows only the root's direct members");
  const d2 = lib.xsdDiagramDefaultExpansion(m, "MissionType", "Mission");               // default: depth 2
  const L2 = lib.xsdDiagramLayout(m, "MissionType", "Mission", d2);
  const label = n => n.label;
  assert.deepEqual(L2.nodes.filter(n => n.depth === 1).map(label), ["ID", "Meta", "Mode", "Leg", "choice", "Note"]);
  assert.ok(!L2.nodes.some(n => n.label === "Owner"), "inherited Meta stays collapsed by default");
  assert.ok(L2.nodes.some(n => n.label === "LIVE"), "own enumeration opened");
  assert.ok(L2.nodes.some(n => n.label === "Text") && L2.nodes.some(n => n.label === "Next"));
  const all = lib.xsdDiagramDefaultExpansion(m, "MissionType", "Mission", { depth: 3, skipInherited: false });
  assert.ok(lib.xsdDiagramLayout(m, "MissionType", "Mission", all).nodes.some(n => n.label === "Owner"), "skipInherited:false opens inherited members");
  void names;
});

test("layout: nodes, compositors, badges, recursion, enums", () => {
  const m = demo(), exp = lib.xsdDiagramDefaultExpansion(m, "MissionType", "Mission", { depth: 3, skipInherited: false });
  const L = lib.xsdDiagramLayout(m, "MissionType", "Mission", exp);
  checkLayout(L, "demo");
  const by = l => L.nodes.filter(n => n.label === l);
  const root = L.nodes[0];
  assert.equal(root.cls, "root"); assert.equal(root.label, "Mission"); assert.equal(root.sub, "MissionType");
  const choice = by("choice")[0];
  assert.equal(choice.cls, "choice");
  assert.deepEqual(choice.vis.map(n => n.label), ["ByName", "ByID"]);
  assert.equal(choice.vis[0].depth, choice.depth + 1, "alternatives hang off the choice node");
  const leg = by("Leg")[0], mode = by("Mode")[0];
  assert.equal(leg.badge, "1..∞"); assert.equal(mode.badge, "0..1");
  assert.equal(by("ID")[0].badge, "");
  assert.equal(mode.optional, true); assert.equal(leg.optional, false);
  assert.ok(L.edges.find(e => e.to === leg.id).repeat);
  assert.ok(L.edges.find(e => e.to === mode.id).optional);
  const next = by("Next")[0];
  assert.equal(next.recursive, true); assert.equal(next.cls, "rec"); assert.equal(next.hasKids, false);
  assert.deepEqual(mode.vis.map(n => n.label), ["LIVE", "SIM"]);
  assert.ok(mode.vis.every(n => n.cls === "val"));
  assert.equal(by("ID")[0].cls, "builtin");
  assert.equal(by("Note")[0].cls, "complex"); assert.equal(mode.cls, "enum");
  assert.ok(by("ID")[0].inherited && by("ID")[0].from === "BaseType");
  assert.deepEqual(lib.xsdDiagramLayout(m, "MissionType", "Mission", new Set(["0"])).nodes.map(n => n.label), ["Mission", "ID", "Meta", "Mode", "Leg", "choice", "ByName", "ByID", "Note"]);
});

test("layout: expansion state controls what is shown; ids are stable", () => {
  const m = demo();
  const collapsed = lib.xsdDiagramLayout(m, "MissionType", "Mission", new Set(["0"]));
  const leg = collapsed.nodes.find(n => n.label === "Leg");
  assert.equal(leg.open, false); assert.equal(leg.hasKids, true);
  const opened = lib.xsdDiagramLayout(m, "MissionType", "Mission", new Set(["0", leg.id]));
  assert.ok(opened.nodes.some(n => n.label === "Next"));
  assert.equal(opened.nodes.find(n => n.label === "Leg").id, leg.id, "same id before and after expanding");
  assert.ok(opened.nodes.length === collapsed.nodes.length + 1);
  checkLayout(collapsed, "collapsed"); checkLayout(opened, "opened");
  const capped = lib.xsdDiagramLayout(m, "MissionType", "Mission", lib.xsdDiagramDefaultExpansion(m, "MissionType", "Mission", { depth: 3, skipInherited: false }), { maxNodes: 6 });
  assert.equal(capped.stats.truncated, true); assert.ok(capped.nodes.length <= 6);
});

test("find: matches names and types, opens only the branches that lead to them", () => {
  const m = demo();
  const r = lib.xsdDiagramFind(m, "MissionType", "Mission", "text");
  assert.deepEqual(r.hits.map(h => h.name), ["Text"]);
  const L = lib.xsdDiagramLayout(m, "MissionType", "Mission", r.open);
  assert.ok(L.nodes.some(n => n.label === "Text"), "the match is visible");
  assert.ok(!L.nodes.some(n => n.label === "Next" || n.label === "LIVE"), "unrelated branches stay closed");
  assert.deepEqual(lib.xsdDiagramFind(m, "MissionType", "Mission", "ModeType").hits.map(h => h.name), ["Mode"], "matches the type name too");
  assert.deepEqual(lib.xsdDiagramFind(m, "MissionType", "Mission", "owner").hits.map(h => h.id.split(".").length), [3], "finds inherited members several levels down");
  assert.equal(lib.xsdDiagramFind(m, "MissionType", "Mission", "nothing here").hits.length, 0);
  assert.equal(lib.xsdDiagramFind(m, "MissionType", "Mission", "  ").hits.length, 0);
  const next = lib.xsdDiagramFind(m, "MissionType", "Mission", "next").hits;
  assert.equal(next.length, 1, "recursion is not followed forever");
});

test("svg: valid XML, escapes text, carries tooltips and a stylesheet when standalone", () => {
  const m = demo(), L = lib.xsdDiagramLayout(m, "MissionType", "Mission", lib.xsdDiagramDefaultExpansion(m, "MissionType", "Mission"));
  const svg = lib.xsdDiagramSvg(L, { standalone: true, selected: "0.3", hits: new Set(["0.4"]) });
  const tree = lib.xmlParse(svg);                                            // well-formed
  assert.equal(tree.root.name, "svg");
  assert.match(svg, /<style>/); assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.ok((svg.match(/<g class="dg-n /g) || []).length === L.nodes.length);
  assert.match(svg, /<title>Mission/); assert.match(svg, /dg-sel/); assert.match(svg, /dg-hit/);
  const inner = lib.xsdDiagramSvg(L);
  assert.ok(!/<style>|<\?xml/.test(inner), "embedded form has no stylesheet or prolog");
  // hostile names cannot break the markup
  const evil = lib.xsdModel([`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="R" type="T"/><xs:complexType name="T"><xs:sequence><xs:element name="a_b" type="xs:string"/></xs:sequence></xs:complexType></xs:schema>`]);
  const Le = lib.xsdDiagramLayout(evil, "T", "<R&\"x\">", new Set(["0"]));
  assert.doesNotThrow(() => lib.xmlParse(lib.xsdDiagramSvg(Le, { standalone: true })));
  assert.match(lib.xsdDiagramDescribe(m, L.nodes.find(n => n.label === "Leg")), /Member Leg, of type LegType, occurs 1\.\.∞, 1 members/);
  assert.match(lib.xsdDiagramDescribe(m, L.nodes.find(n => n.label === "choice")), /Choice: exactly one of ByName, ByID/);
});

/* ---------------- real UCI schema ---------------- */

const UCI_DIR = process.env.UCI_SCHEMA_DIR || "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL";
const haveUci = fs.existsSync(path.join(UCI_DIR, "UCI_MessageDefinitions_v2_6_0.xsd"));
const skip = !haveUci && "UCI schema folder not found";
let uci; const loadUci = () => uci || (uci = lib.xsdModel(fs.readdirSync(UCI_DIR).filter(f => f.endsWith(".xsd")).map(n => ({ name: n, text: fs.readFileSync(path.join(UCI_DIR, n), "utf8") }))));

test("UCI: the default view of a message is its own payload, not the shared boilerplate", { skip }, () => {
  const m = loadUci(), e = m.elements.get("AccessAssessment");
  const L = lib.xsdDiagramLayout(m, e.type, "AccessAssessment", lib.xsdDiagramDefaultExpansion(m, e.type, "AccessAssessment"));
  checkLayout(L, "AccessAssessment");
  assert.deepEqual(L.nodes.filter(n => n.depth === 1).map(n => n.label), ["SecurityInformation", "MessageHeader", "ObjectState", "MessageData"]);
  const sec = L.nodes.find(n => n.label === "SecurityInformation");
  assert.equal(sec.open, false); assert.equal(sec.inherited, true);
  const payload = L.nodes.find(n => n.label === "MessageData");
  assert.deepEqual(payload.vis.map(n => n.label), ["AccessAssessmentID", "AssessmentName", "AccessAssessmentRequestID", "AssessementSource", "AssociatedAccessAssessmentInfo", "Assessment", "CompletionTime", "AssessmentNarrative"]);
  assert.equal(L.nodes.find(n => n.label === "Assessment").badge, "1..∞");
  assert.equal(L.nodes.find(n => n.label === "AssociatedAccessAssessmentInfo").badge, "0..8");
  assert.ok(L.nodes.length < 80, `a calm default: ${L.nodes.length} boxes`);
  assert.equal(L.stats.truncated, false);
});

test("UCI: choices, enumerations and long names lay out correctly", { skip }, () => {
  const m = loadUci(), e = m.elements.get("AccessAssessment");
  const L = lib.xsdDiagramLayout(m, e.type, "AccessAssessment", lib.xsdDiagramDefaultExpansion(m, e.type, "AccessAssessment", { depth: 4, skipInherited: false }));
  checkLayout(L, "deep");
  assert.ok(L.nodes.some(n => n.cls === "choice" && n.vis.length >= 2));
  assert.ok(L.nodes.some(n => n.cls === "val" && n.label === "NEW"), "ObjectState values are shown");
  assert.ok(L.nodes.every(n => n.label.length <= 41 && n.sub.length <= 46), "labels are clipped");
  const svg = lib.xsdDiagramSvg(L, { standalone: true });
  assert.doesNotThrow(() => lib.xmlParse(svg));
});

test("UCI: find opens the path to a deeply nested member in a big message", { skip }, () => {
  const m = loadUci(), e = m.elements.get("MissionPlan");
  const t0 = Date.now(), r = lib.xsdDiagramFind(m, e.type, "MissionPlan", "latitude");
  assert.ok(r.hits.length > 0, "Latitude occurs somewhere inside MissionPlan");
  const L = lib.xsdDiagramLayout(m, e.type, "MissionPlan", r.open);
  checkLayout(L, "find");
  const shown = new Set(L.nodes.map(n => n.id));
  assert.ok(r.hits.every(h => shown.has(h.id)), "every hit is on screen");
  assert.ok(L.nodes.length < 2500, `only the relevant branches opened (${L.nodes.length} boxes)`);
  assert.ok(Date.now() - t0 < 4000, `find took ${Date.now() - t0} ms`);
});

test("UCI: the node budget keeps even the biggest messages responsive", { skip }, () => {
  const m = loadUci(), e = m.elements.get("PlanningFunction");
  const t0 = Date.now(), open = lib.xsdDiagramDefaultExpansion(m, e.type, "PlanningFunction", { depth: 8, budget: 20000, skipInherited: false });
  const L = lib.xsdDiagramLayout(m, e.type, "PlanningFunction", open, { maxNodes: 2500 });
  assert.equal(L.stats.truncated, true); assert.ok(L.nodes.length <= 2500);
  checkLayout(L, "budget");
  assert.ok(Date.now() - t0 < 3000, `layout took ${Date.now() - t0} ms`);
});

test("UCI: every message lays out without overlap at the default expansion", { skip }, () => {
  const m = loadUci(); let max = 0;
  for (const [name, e] of m.elements) {
    const L = lib.xsdDiagramLayout(m, e.type, name, lib.xsdDiagramDefaultExpansion(m, e.type, name));
    checkLayout(L, name);
    max = Math.max(max, L.nodes.length);
  }
  assert.ok(max < 600, `largest default view has ${max} boxes`);
});
