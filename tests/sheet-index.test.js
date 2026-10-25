const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
require("../assets/sheet-index.js");
const { SheetIndex } = globalThis, sheets = path.join(__dirname, "..", "sheets");

test("template sheet rows and tables become entries", () => {
  const html = '<script type="text/plain" id="sheet-src">\ntitle: X\n\n== Flags | opts\nnote: ignore me\njq -r \'.a\' f ## Raw strings\nplain row\n|| Name || Meaning\n|| a || first\n</script>';
  const e = SheetIndex.entries("jq", "jq", html);
  assert.deepEqual(e.map(x => [x.sec, x.code, x.d]), [["Flags", "jq -r '.a' f", "Raw strings"], ["Flags", "plain row", ""], ["Flags", "Name", "Meaning"], ["Flags", "a", "first"]]);
});

test("every template sheet yields many entries, all with a section", () => {
  let checked = 0;
  for (const f of fs.readdirSync(sheets)) {
    const html = fs.readFileSync(path.join(sheets, f), "utf8");
    if (!html.includes('id="sheet-src"')) continue;
    const e = SheetIndex.entries(f.replace(".html", ""), f, html);
    assert.ok(e.length > 20, f + " has " + e.length + " entries");
    assert.ok(e.every(x => x.sec && x.code), f);
    checked++;
  }
  assert.ok(checked >= 10);
});

test("older sheets that build rows from a JS array are indexed too", () => {
  const html = fs.readFileSync(path.join(sheets, "git.html"), "utf8");
  const e = SheetIndex.entries("git", "Git", html);
  const row = e.find(x => x.code.startsWith("git rebase --onto"));
  assert.ok(row, "git rebase --onto is indexed");
  assert.equal(row.sec, "Rebase");
  assert.match(row.d, /Move a branch/);
  assert.ok(e.length > 80);
});
