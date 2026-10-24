// Cross-check the in-browser XSD validator and sample generator against .NET's schema validator on a real schema set.
//   node tests/crosscheck.js [schemaDir] [--mutations N] [--seed S]
// Needs Windows PowerShell (for dotnet-validate.ps1) and the schema folder. Not part of `npm test` because of those requirements.
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const { lib } = require("./harness");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? +args[i + 1] : d; };
const dir = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))) || process.env.UCI_SCHEMA_DIR || "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL";
const MUTATIONS = opt("--mutations", 400), SEED = opt("--seed", 1);
const MAIN = "UCI_MessageDefinitions_v2_6_0.xsd";

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = rng(SEED);
const pick = a => a[Math.floor(rand() * a.length)];

const xsds = fs.readdirSync(dir).filter(f => f.endsWith(".xsd"));
const model = lib.xsdModel(xsds.map(n => ({ name: n, text: fs.readFileSync(path.join(dir, n), "utf8") })));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uci-cross-"));
const manifest = new Map();     // file -> { mine: bool, what }

function add(name, xml, what) { fs.writeFileSync(path.join(tmp, name), xml); manifest.set(name, { mine: lib.xsdValidate(model, xml, { maxErrors: 5 }), what }); }

// 1. generated skeletons: every message, required-only and everything
const names = [...model.elements.keys()];
for (const n of names) {
  add(`gen_req_${n}.xml`, lib.xsdSkeleton(model, n, { hints: false }).xml, "skeleton (required)");
  add(`gen_all_${n}.xml`, lib.xsdSkeleton(model, n, { all: true, maxDepth: 8, hints: false }).xml, "skeleton (all)");
}

// 2. seeded random mutations of small/medium messages
const MUT = {
  drop: (els, root) => { const e = pick(els.filter(x => x !== root)); remove(e); return `drop <${e.name}>`; },
  dup: (els, root) => { const e = pick(els.filter(x => x !== root)); const p = parentOf(e); p.kids.splice(p.kids.indexOf(e), 0, JSON.parse(JSON.stringify(e))); return `duplicate <${e.name}>`; },
  swap: (els) => { const cands = els.filter(x => x.kids.filter(k => k.t === "el").length >= 2); if (!cands.length) return null; const p = pick(cands), ks = p.kids.filter(k => k.t === "el"); const i = Math.floor(rand() * (ks.length - 1)); const a = p.kids.indexOf(ks[i]), b = p.kids.indexOf(ks[i + 1]); [p.kids[a], p.kids[b]] = [p.kids[b], p.kids[a]]; return `swap <${ks[i].name}> and <${ks[i + 1].name}>`; },
  rename: (els, root) => { const e = pick(els.filter(x => x !== root)); e.name += "X"; return `rename <${e.name}>`; },
  text: (els) => { const l = leaves(els); if (!l.length) return null; const e = pick(l); setText(e, "###"); return `<${e.name}> = "###"`; },
  huge: (els) => { const l = leaves(els); if (!l.length) return null; const e = pick(l); setText(e, "99999999999999999999999"); return `<${e.name}> = 9999…`; },
  neg: (els) => { const l = leaves(els); if (!l.length) return null; const e = pick(l); setText(e, "-1"); return `<${e.name}> = -1`; },
  empty: (els) => { const l = leaves(els); if (!l.length) return null; const e = pick(l); setText(e, ""); return `<${e.name}> = ""`; },
  lower: (els) => { const l = leaves(els); if (!l.length) return null; const e = pick(l); setText(e, (text(e) || "x").toLowerCase() + "q"); return `<${e.name}> lowercased+q`; },
  long: (els) => { const l = leaves(els); if (!l.length) return null; const e = pick(l); setText(e, "A".repeat(300)); return `<${e.name}> = 300×A`; },
  childtext: (els) => { const e = pick(els.filter(x => x.kids.some(k => k.t === "el"))); e.kids.unshift({ t: "text", v: "stray" }); return `stray text in <${e.name}>`; },
  ns: (els, root) => { root.attrs = root.attrs.filter(a => a[0] !== "xmlns"); return "remove xmlns"; },
  attr: (els, root) => { const e = pick(els); e.attrs.push(["bogus", "1"]); return `unknown attribute on <${e.name}>`; },
};
let parents, cur;
const parentOf = e => parents.get(e);
const remove = e => { const p = parents.get(e); p.kids.splice(p.kids.indexOf(e), 1); };
const leaves = els => els.filter(e => !e.kids.some(k => k.t === "el"));
const text = e => e.kids.filter(k => k.t === "text").map(k => k.v).join("");
const setText = (e, v) => { e.kids = e.kids.filter(k => k.t !== "text"); e.kids.push({ t: "text", v }); };

const small = names.filter(n => lib.xsdSkeleton(model, n, { hints: false }).elements < 60);
const kinds = Object.keys(MUT);
let made = 0, guard = 0;
while (made < MUTATIONS && guard++ < MUTATIONS * 20) {
  const n = pick(small), base = lib.xsdSkeleton(model, n, { all: rand() < 0.5, maxDepth: 5, hints: false }).xml;
  const tree = lib.xmlParse(base);
  const els = []; parents = new Map();
  (function walk(e) { els.push(e); for (const k of e.kids) if (k.t === "el") { parents.set(k, e); walk(k); } })(tree.root);
  const kind = pick(kinds), what = MUT[kind](els, tree.root);
  if (!what) continue;
  add(`mut_${String(made).padStart(4, "0")}_${kind}.xml`, lib.xmlSerialize(tree, { indent: "  " }), `${kind}: ${n}: ${what}`);
  made++;
}

// 3. ground truth from .NET
const ps = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "dotnet-validate.ps1"), "-SchemaDir", dir, "-XmlDir", tmp, "-Main", MAIN], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 900000 });
if (ps.status !== 0) { console.error("PowerShell failed:", ps.stderr || ps.stdout); process.exit(2); }
const net = new Map(ps.stdout.split(/\r?\n/).filter(Boolean).map(l => { const [f, v, ...m] = l.split("\t"); return [f, { ok: v === "OK", msg: m.join("\t") }]; }));

let agree = 0, falseAccept = [], falseReject = [], missing = 0, netInvalid = 0, mineInvalid = 0;
for (const [f, m] of manifest) {
  const n = net.get(f); if (!n) { missing++; continue; }
  if (!n.ok) netInvalid++; if (!m.mine.ok) mineInvalid++;
  if (n.ok === m.mine.ok) agree++;
  else if (m.mine.ok && !n.ok) falseAccept.push([f, m.what, n.msg, m.mine]);     // I said valid, .NET says invalid
  else falseReject.push([f, m.what, m.mine.errors[0], n.msg]);                    // I said invalid, .NET says valid
}
const total = manifest.size - missing;
console.log(`schema: ${dir}\nfiles checked: ${total} (${names.length * 2} generated skeletons, ${made} mutations)  |  .NET invalid: ${netInvalid}  mine invalid: ${mineInvalid}`);
console.log(`agreement: ${agree}/${total}   false accepts (mine OK, .NET ERR): ${falseAccept.length}   false rejects (mine ERR, .NET OK): ${falseReject.length}`);
for (const [f, what, msg] of falseAccept.slice(0, 15)) console.log(`  FALSE ACCEPT ${f}\n    ${what}\n    .NET: ${msg.slice(0, 260)}`);
for (const [f, what, mine, msg] of falseReject.slice(0, 15)) console.log(`  FALSE REJECT ${f}\n    ${what}\n    mine: ${mine.path}: ${mine.message.slice(0, 220)}`);
if (!process.argv.includes("--keep")) fs.rmSync(tmp, { recursive: true, force: true }); else console.log("kept", tmp);
process.exit(falseAccept.length || falseReject.length ? 1 : 0);
