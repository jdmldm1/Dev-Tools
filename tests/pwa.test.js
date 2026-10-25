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

test("the precache finds every sheet in catalog.js", () => {
  // Runs sw.js's own sheet-id regex: a control character once slipped into it and silently dropped every sheet from the offline cache.
  const re = new RegExp(/matchAll\(\/(.+?)\/g\)\) urls\.add\("sheets\//.exec(read("sw.js"))[1], "g");
  const cat = read("catalog.js"), ids = [...cat.slice(0, cat.indexOf("tools:")).matchAll(re)].map(m => m[1]);
  assert.ok(ids.length > 0, "no sheet ids matched");
  for (const id of ids) assert.ok(fs.existsSync(path.join(root, "sheets", id + ".html")), id);
});
