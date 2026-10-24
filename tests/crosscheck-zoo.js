// Cross-check the XSD validator against .NET on tests/fixtures/zoo.xsd, which exercises XSD features the UCI schema does not.
//   node tests/crosscheck-zoo.js
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const { lib } = require("./harness");

const dir = path.join(__dirname, "fixtures");
const model = lib.xsdModel([{ name: "zoo.xsd", text: fs.readFileSync(path.join(dir, "zoo.xsd"), "utf8") }]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zoo-"));
const cases = new Map();
const NS = 'xmlns="urn:zoo"';
const add = (name, xml, what) => { fs.writeFileSync(path.join(tmp, name + ".xml"), xml); cases.set(name + ".xml", { what, mine: lib.xsdValidate(model, xml, { maxErrors: 3 }) }); };
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// 1. every leaf type x a pool of lexical values
const VALUES = ["", " ", "0", "1", "2", "3", "5", "9", "10", "11", "-1", "00", "007", "+5", " 7 ", "255", "256", "65535", "2147483647", "2147483648", "-2147483648", "-2147483649",
  "9223372036854775807", "9223372036854775808", "18446744073709551615", "18446744073709551616", "abc", "ABC", "AB12", "AB129", "ab12", "A1", "1.5", "1.50", "1.", ".5", "0.5", "0.0", "1.0", "123.45", "123.456", "1234.5", "12345", "123456", "-123.45", "1e3", "1E-2", "1e", "INF", "-INF", "NaN", "inf",
  "true", "false", "TRUE", "yes", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00", "2026-01-01T24:00:00Z", "2026-01-01T24:00:01Z", "2026-02-29T00:00:00Z", "2024-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-32T00:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z",
  "2026-01-01T00:00:00.123+05:30", "2026-01-01T00:00:00+14:00", "2026-01-01", "2026-01-01Z", "2026-4-1", "10:30:00", "10:30:00Z", "10:30", "24:00:00", "25:00:00", "10:30:00.5",
  "P1Y", "P1Y2M3DT4H5M6S", "PT0S", "P", "PT", "-P1D", "P1D1Y", "P1.5D", "PT1.5S", "0F", "0f1", "0G", "0", "SGk=", "SGk", "SGk==", "S", "AB", "A B", "ABCD", "abcd", "abcde", "abcdef", "A", "B", "C", "D", "a",
  "1 2 3", "1 2", "1 2 3 4", "1 x 3", " 1  2   3 ", "hello world", "  hello   world  ", "hello  world", "Hello", "a\tb", "a\nb", "2026", "-0001", "12345", "en", "en-US", "e", "toolonglang1", "x-y"];
const leaves = [...model.types.get("RootType").parts].map(p => p.name);
let n = 0;
for (const leaf of leaves) for (const v of VALUES) add(`leaf_${String(n++).padStart(5, "0")}_${leaf}`, `<Root ${NS}><${leaf}>${esc(v)}</${leaf}></Root>`, `<${leaf}> = ${JSON.stringify(v)}`);

// 2. structure, hand-written
const S = [
  ["SeqMsg", "<a>1</a>", 1], ["SeqMsg", "", 1], ["SeqMsg", "<a/><b>1</b>", 1], ["SeqMsg", "<b>1</b><a>x</a>", 1], ["SeqMsg", "<a>x</a><c>1</c><c>2</c><c>3</c>", 1], ["SeqMsg", "<a>x</a><b>1</b><b>2</b>", 1], ["SeqMsg", "<a>x</a><c>1</c><b>1</b>", 1], ["SeqMsg", "<a>x</a><zzz/>", 1], ["SeqMsg", "<a>x<b/></a>", 1], ["SeqMsg", "text<a>x</a>", 1], ["SeqMsg", "<a>x</a><b>x</b>", 1],
  ["ChoiceMsg", "", 1], ["ChoiceMsg", "<x>1</x>", 1], ["ChoiceMsg", "<y>1</y>", 1], ["ChoiceMsg", "<x>1</x><y>1</y><x>2</x>", 1], ["ChoiceMsg", "<x>1</x><x>2</x><x>3</x><x>4</x>", 1], ["ChoiceMsg", "<y>z</y>", 1],
  ["NestedMsg", "<a>1</a>", 1], ["NestedMsg", "<a>1</a><b>1</b>", 1], ["NestedMsg", "<a>1</a><b>1</b><c>1</c><b>2</b>", 1], ["NestedMsg", "<a>1</a><b>1</b><b>2</b><b>3</b>", 1], ["NestedMsg", "<a>1</a><c>1</c>", 1], ["NestedMsg", "<a>1</a><b>1</b><d>1</d>", 1], ["NestedMsg", "<a>1</a><d>1</d><e>1</e>", 1], ["NestedMsg", "<a>1</a><e>1</e>", 1], ["NestedMsg", "<a>1</a><b>1</b><c>1</c><d>1</d><b>2</b>", 1],
  ["AllMsg", "<p>1</p>", 1], ["AllMsg", "<q>1</q><p>1</p>", 1], ["AllMsg", "<q>1</q>", 1], ["AllMsg", "<p>1</p><p>2</p>", 1], ["AllMsg", "<p>1</p><q>1</q><q>2</q>", 1], ["AllMsg", "", 1],
  ["MixedMsg", "hello <i>1</i> world <i>2</i>", 1], ["MixedMsg", "", 1], ["MixedMsg", "<j/>", 1],
  ["AttrMsg", "<v>1</v>", 0, ' id="1"'], ["AttrMsg", "<v>1</v>", 0, ""], ["AttrMsg", "<v>1</v>", 0, ' id="x"'], ["AttrMsg", "<v>1</v>", 0, ' id="1" opt="A"'], ["AttrMsg", "<v>1</v>", 0, ' id="1" opt="Z"'], ["AttrMsg", "<v>1</v>", 0, ' id="1" fx="F"'], ["AttrMsg", "<v>1</v>", 0, ' id="1" fx="G"'], ["AttrMsg", "<v>1</v>", 0, ' id="1" bogus="1"'], ["AttrMsg", "<v>1</v>", 0, ' id=" 5 "'],
  ["ExtMsg", "<a>1</a><d>1</d>", 1], ["ExtMsg", "<a>1</a><b>1</b><c>1</c><d>1</d><e>1</e>", 1], ["ExtMsg", "<a>1</a>", 1], ["ExtMsg", "<d>1</d><a>1</a>", 1], ["ExtMsg", "<a>1</a><d>1</d><c>1</c>", 1], ["ExtMsg", "<a>1</a><c>1</c><d>1</d><e>x</e>", 1],
  ["AbstractMsg", "<name>n</name>", 1], ["AbstractMsg", "<name>n</name><x>1</x>", 1],
  ["SubstMsg", "<Head>1</Head>", 1], ["SubstMsg", "<MemberA>1</MemberA>", 1], ["SubstMsg", "<MemberB>1</MemberB>", 1], ["SubstMsg", "<MemberB>x</MemberB>", 1], ["SubstMsg", "<MemberA>a</MemberA><MemberB>2</MemberB><Head>h</Head>", 1], ["SubstMsg", "", 1], ["SubstMsg", "<Head>1</Head><Head>1</Head><Head>1</Head><Head>1</Head>", 1], ["SubstMsg", "<Other/>", 1],
  ["NilMsg", '<n xsi:nil="true"/>', 1], ["NilMsg", '<n xsi:nil="true">x</n>', 1], ["NilMsg", '<n xsi:nil="false">x</n>', 1], ["NilMsg", '<m xsi:nil="true"/>', 1], ["NilMsg", "<n/>", 1], ["NilMsg", '<n xsi:nil="1"/>', 1],
  ["SCMsg", "5", 0, ' unit="m"'], ["SCMsg", "5", 0, ""], ["SCMsg", "x", 0, ' unit="m"'], ["SCMsg", "<a/>", 0, ' unit="m"'], ["SCMsg", "", 0, ' unit="m"'],
  ["EmptyMsg", "", 1], ["EmptyMsg", "<a/>", 1], ["EmptyMsg", "text", 1], ["EmptyMsg", "  ", 1],
  ["BoundedMsg", "<i>1</i>", 1], ["BoundedMsg", "<i>1</i><i>2</i>", 1], ["BoundedMsg", "<i>1</i><i>2</i><i>3</i>", 1], ["BoundedMsg", "<i>1</i><i>2</i><i>3</i><i>4</i>", 1],
  ["GroupMsg", "<g1>a</g1>", 1], ["GroupMsg", "<g1>a</g1><g2>1</g2><g2>2</g2>", 1], ["GroupMsg", "<g1>a</g1><g2>1</g2><g2>2</g2><g2>3</g2>", 1], ["GroupMsg", "<g2>1</g2>", 1], ["GroupMsg", "<g1>a</g1><z>q</z>", 1],
];
S.forEach(([root, inner, , attrs = ""], i) => add(`struct_${String(i).padStart(3, "0")}_${root}`, `<${root} ${NS} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"${attrs}>${inner}</${root}>`, `${root}: ${inner || "(empty)"}${attrs}`));
// xsi:type, namespaces, odd roots
add("xt_1", `<AbstractMsg ${NS} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="urn:zoo" xsi:type="z:DerA"><name>n</name><x>1</x></AbstractMsg>`, "xsi:type DerA valid");
add("xt_2", `<AbstractMsg ${NS} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="urn:zoo" xsi:type="z:DerB"><name>n</name><y>1</y></AbstractMsg>`, "xsi:type DerB valid");
add("xt_3", `<AbstractMsg ${NS} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="urn:zoo" xsi:type="z:DerA"><name>n</name><y>1</y></AbstractMsg>`, "xsi:type DerA with DerB content");
add("xt_4", `<AbstractMsg ${NS} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="urn:zoo" xsi:type="z:SeqT"><a>1</a></AbstractMsg>`, "xsi:type unrelated type");
add("xt_5", `<AbstractMsg ${NS} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="urn:zoo" xsi:type="z:Nope"><name>n</name></AbstractMsg>`, "xsi:type unknown type");
add("ns_1", `<SeqMsg><a>1</a></SeqMsg>`, "no namespace");
add("ns_2", `<SeqMsg xmlns="urn:other"><a>1</a></SeqMsg>`, "wrong namespace");
add("ns_3", `<z:SeqMsg xmlns:z="urn:zoo"><z:a>1</z:a></z:SeqMsg>`, "prefixed, valid");
add("ns_4", `<z:SeqMsg xmlns:z="urn:zoo"><a>1</a></z:SeqMsg>`, "child unqualified (no default ns)");
add("ns_5", `<SeqMsg ${NS}><a>1</a><b xmlns="">1</b></SeqMsg>`, "child reset to no namespace");
add("root_1", `<Unknown ${NS}/>`, "unknown root element");
add("root_2", `<SeqT ${NS}><a>1</a></SeqT>`, "type name used as element");

// 3. ground truth
const ps = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "dotnet-validate.ps1"), "-SchemaDir", dir, "-XmlDir", tmp, "-Main", "zoo.xsd"], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 900000 });
if (ps.status !== 0) { console.error("PowerShell failed:", ps.stderr || ps.stdout); process.exit(2); }
const net = new Map(ps.stdout.split(/\r?\n/).filter(Boolean).map(l => { const [f, v, ...m] = l.split("\t"); return [f, { ok: v === "OK", msg: m.join("\t") }]; }));

// Documented differences where .NET is more lenient than the XSD spec (this validator follows the spec) - not treated as failures.
const KNOWN = [
  [/^<Hex> = ".*( |\\t|\\n).*"/, "hexBinary with internal whitespace: invalid per XSD, accepted by .NET"],
  [/^<B64> = "SGk=="/, "base64Binary with malformed padding: invalid per XSD, accepted by .NET"],
  [/^<Tok> = " "$/, "token that is only whitespace: valid per XSD (collapses to empty), rejected by .NET"],
  [/^<Year> = "(-|\d{5,})/, "gYear beyond 4 digits or negative: valid per XSD, rejected by .NET (DateTime range)"],
];
const bad = [], known = new Map(); let agree = 0, netInvalid = 0;
for (const [f, c] of cases) {
  const n = net.get(f); if (!n) { bad.push([f, c.what, "no .NET result", ""]); continue; }
  if (!n.ok) netInvalid++;
  if (n.ok === c.mine.ok) { agree++; continue; }
  const k = KNOWN.find(([re]) => re.test(c.what));
  if (k) { known.set(k[1], (known.get(k[1]) || 0) + 1); continue; }
  bad.push([f, c.what, c.mine.ok ? "mine: OK" : `mine: ${c.mine.errors[0].message.slice(0, 150)}`, n.ok ? ".NET: OK" : `.NET: ${n.msg.slice(0, 170)}`]);
}
const knownN = [...known.values()].reduce((a, b) => a + b, 0);
console.log(`zoo cases: ${cases.size} (${n} leaf values + ${S.length + 11} structural)  .NET invalid: ${netInvalid}  agreement: ${agree}/${cases.size}  documented differences: ${knownN}  unexpected disagreements: ${bad.length}`);
for (const [why, c] of known) console.log(`  (known, x${c}) ${why}`);
for (const [f, what, a, b] of bad.slice(0, 60)) console.log(`  ${what}
     ${a}
     ${b}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
