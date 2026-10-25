const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, ".."), read = f => fs.readFileSync(path.join(root, f), "utf8");

test("service worker version matches package.json", () => {
  const v = /const VERSION = "([^"]+)"/.exec(read("sw.js"))[1];
  assert.equal(v, JSON.parse(read("package.json")).version);
});

test("manifest icons exist", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.ok(m.icons.length);
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(root, i.src)), i.src + " is missing");
  assert.ok(fs.existsSync(path.join(root, m.start_url)));
});

test("every page the precache walks references files that exist", () => {
  for (const page of ["toolbox.html", "all.html"]) {
    for (const m of read(page).matchAll(/(?:src|href)="([^"#?:]+\.(?:js|css|svg|json))"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), `${page} -> ${m[1]}`);
  }
});
