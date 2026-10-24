// Guards against drift between catalog.js, the files on disk, and the tools registered in the toolbox.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const { DT } = require("./harness");

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "catalog.js"), "utf8"), ctx);
const { sheets, tools } = ctx.window.CATALOG;

test("every cataloged sheet exists, and every sheet file is cataloged", () => {
  const files = fs.readdirSync(path.join(root, "sheets")).filter(f => f.endsWith(".html")).map(f => f.replace(/\.html$/, "")).sort();
  assert.deepEqual(Array.from(sheets, s => s.id).sort(), files);
  assert.equal(new Set(Array.from(sheets, s => s.id)).size, sheets.length, "duplicate sheet ids");
});

test("every sheet is dark, linked home, and uses the Cheat Sheet label", () => {
  for (const f of fs.readdirSync(path.join(root, "sheets"))) {
    const html = fs.readFileSync(path.join(root, "sheets", f), "utf8");
    assert.match(html, /<html[^>]*data-theme="dark"/, f);
    assert.match(html, /\.\.\/index\.html|assets\/sheet\.js/, f + " links home (inline or via sheet.js)");
    assert.doesNotMatch(html, /field guide/i, f + " still says Field Guide");
    assert.match(html, /<title>[^<]*Cheat Sheet<\/title>/, f + " title");
  }
});

test("data-driven sheets parse without stray content", () => {
  for (const f of fs.readdirSync(path.join(root, "sheets"))) {
    const html = fs.readFileSync(path.join(root, "sheets", f), "utf8");
    const m = /<script type="text\/plain" id="sheet-src">([\s\S]*?)<\/script>/.exec(html);
    if (!m) continue;
    const src = m[1];
    assert.match(src, /^\s*title: .+/m, f);
    const sections = src.split("\n").filter(l => l.startsWith("== ")).length;
    assert.ok(sections >= 4, f + " has " + sections + " sections");
    // a table row with an empty cell or ragged width usually means a stray " || " inside a cell
    let width = null;
    for (const line of src.split("\n")) {
      if (line.startsWith("== ")) width = null;
      else if (line.startsWith("|| ")) {
        const w = line.slice(3).split(" || ").length;
        if (width === null) width = w;
        assert.equal(w, width, `${f}: ragged table row: ${line}`);
      } else if (width !== null && line.trim()) width = null;
    }
  }
});

test("catalog tools match registered tools exactly", () => {
  const registered = DT.lib; // harness loaded every tool file; registry is internal, so read ids from sources
  const ids = [];
  for (const f of fs.readdirSync(path.join(root, "assets/tools"))) {
    const src = fs.readFileSync(path.join(root, "assets/tools", f), "utf8");
    for (const m of src.matchAll(/DT\.register\(\{\s*id:\s*"([^"]+)"/g)) ids.push(m[1]);
  }
  assert.deepEqual(Array.from(tools, t => t.id).sort(), ids.sort());
  assert.equal(new Set(ids).size, ids.length, "duplicate tool ids");
});

test("toolbox.html includes every tool file", () => {
  const html = fs.readFileSync(path.join(root, "toolbox.html"), "utf8");
  for (const f of fs.readdirSync(path.join(root, "assets/tools"))) assert.ok(html.includes(`assets/tools/${f}`), f + " missing from toolbox.html");
  for (const m of html.matchAll(/src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), "missing " + m[1]);
});
