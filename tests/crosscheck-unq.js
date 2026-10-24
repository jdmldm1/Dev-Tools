// Cross-check namespace handling against .NET on tests/fixtures/unq.xsd (elementFormDefault="unqualified", refs, form="qualified").
//   node tests/crosscheck-unq.js
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const { lib } = require("./harness");

const dir = path.join(__dirname, "fixtures");
const model = lib.xsdModel([{ name: "unq.xsd", text: fs.readFileSync(path.join(dir, "unq.xsd"), "utf8") }]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unq-"));
const cases = new Map();
const add = (name, xml, what) => { fs.writeFileSync(path.join(tmp, name + ".xml"), xml); cases.set(name + ".xml", { what, mine: lib.xsdValidate(model, xml, { maxErrors: 3 }) }); };

const U = 'xmlns:u="urn:unq"';
const X = [
  [`<u:Doc ${U}><local>a</local></u:Doc>`, "minimal, valid"],
  [`<u:Doc ${U}><local>a</local><u:qual>1</u:qual><u:Shared>s</u:Shared><nested><deep>x</deep></nested></u:Doc>`, "everything, valid"],
  [`<u:Doc ${U}><u:local>a</u:local></u:Doc>`, "local element wrongly prefixed"],
  [`<u:Doc ${U}><local>a</local><qual>1</qual></u:Doc>`, "form=qualified element left unprefixed"],
  [`<u:Doc ${U}><local>a</local><Shared>s</Shared></u:Doc>`, "global ref left unprefixed"],
  [`<u:Doc ${U}><local>a</local><nested><u:deep>x</u:deep></nested></u:Doc>`, "nested local wrongly prefixed"],
  [`<Doc xmlns="urn:unq"><local>a</local></Doc>`, "default namespace puts locals in the namespace"],
  [`<Doc xmlns="urn:unq"><local xmlns="">a</local></Doc>`, "default namespace reset on the local"],
  [`<Doc xmlns="urn:unq"><local xmlns="">a</local><qual>1</qual><Shared>s</Shared><nested xmlns=""><deep>x</deep></nested></Doc>`, "default ns + resets, all members"],
  [`<u:Doc ${U}></u:Doc>`, "required local missing"],
  [`<Doc><local>a</local></Doc>`, "no namespace at all"],
];
X.forEach(([xml, what], i) => add(`x${String(i).padStart(2, "0")}`, xml, what));
for (const all of [false, true]) add(`gen_${all ? "all" : "req"}`, lib.xsdSkeleton(model, "Doc", { all, hints: false }).xml, `generated skeleton (${all ? "all" : "required"})`);
add("gen_shared", lib.xsdSkeleton(model, "Shared", { hints: false }).xml, "generated global element");

const ps = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "dotnet-validate.ps1"), "-SchemaDir", dir, "-XmlDir", tmp, "-Main", "unq.xsd"], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 300000 });
if (ps.status !== 0) { console.error("PowerShell failed:", ps.stderr || ps.stdout); process.exit(2); }
const net = new Map(ps.stdout.split(/\r?\n/).filter(Boolean).map(l => { const [f, v, ...m] = l.split("\t"); return [f, { ok: v === "OK", msg: m.join("\t") }]; }));
let agree = 0; const bad = [];
for (const [f, c] of cases) { const n = net.get(f); if (n && n.ok === c.mine.ok) agree++; else bad.push([c.what, c.mine.ok ? "mine: OK" : "mine: " + c.mine.errors[0].message.slice(0, 140), n ? (n.ok ? ".NET: OK" : ".NET: " + n.msg.slice(0, 160)) : ".NET: (no result)"]); }
console.log(`unqualified-namespace cases: ${cases.size}  agreement: ${agree}/${cases.size}  disagreements: ${bad.length}`);
for (const b of bad) console.log("  " + b.join("\n     "));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
