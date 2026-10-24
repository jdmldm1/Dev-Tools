const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "assets", "favs.js"), "utf8");

function load(stored, { failWrites = false } = {}) {
  const store = new Map(stored === undefined ? [] : [["dt.favs", stored]]), listeners = {};
  const window = { addEventListener: (n, f) => { listeners[n] = f; } };
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { if (failWrites) throw new Error("quota"); store.set(k, v); } };
  vm.runInNewContext(src, { window, localStorage });
  return { Favs: window.Favs, store, listeners };
}

test("starring keeps order, toggles, and persists", () => {
  const { Favs, store } = load();
  assert.deepEqual([...Favs.list()], []);
  assert.equal(Favs.toggle("tool:json"), true);
  assert.equal(Favs.toggle("sheet:git"), true);
  assert.deepEqual([...Favs.list()], ["tool:json", "sheet:git"]);
  assert.equal(Favs.has("tool:json"), true);
  assert.equal(Favs.toggle("tool:json"), false);
  assert.deepEqual([...Favs.list()], ["sheet:git"]);
  assert.equal(store.get("dt.favs"), '["sheet:git"]');
  Favs.list().push("x");                                  // list() hands out a copy
  assert.deepEqual([...Favs.list()], ["sheet:git"]);
});

test("saved favorites load, and bad data is ignored", () => {
  assert.deepEqual([...load('["tool:a","sheet:b","tool:a"]').Favs.list()], ["tool:a", "sheet:b"]);
  assert.deepEqual([...load('["ok", 5, null, {"x":1}]').Favs.list()], ["ok"]);
  assert.deepEqual([...load("not json").Favs.list()], []);
  assert.deepEqual([...load('{"a":1}').Favs.list()], []);
});

test("a blocked storage still works for the life of the page", () => {
  const { Favs } = load(undefined, { failWrites: true });
  assert.equal(Favs.toggle("tool:x"), true);
  assert.deepEqual([...Favs.list()], ["tool:x"]);
});

test("changes from another tab are picked up", () => {
  const { Favs, store, listeners } = load('["tool:a"]');
  let fired = 0; Favs.onChange(() => { fired++; });
  store.set("dt.favs", '["tool:b","tool:c"]');
  listeners.storage({ key: "other" }); assert.equal(fired, 0);
  listeners.storage({ key: "dt.favs" });
  assert.equal(fired, 1); assert.deepEqual([...Favs.list()], ["tool:b", "tool:c"]);
});

test("sync marks stars and aria-pressed", () => {
  const { Favs } = load('["tool:a"]');
  const mk = id => { const cls = new Set(); const attrs = {}; return { dataset: { fav: id }, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: c => cls.has(c) }, setAttribute: (k, v) => { attrs[k] = v; }, attrs, title: "" }; };
  const a = mk("tool:a"), b = mk("tool:b");
  Favs.sync({ querySelectorAll: () => [a, b] });
  assert.equal(a.classList.has("on"), true); assert.equal(a.attrs["aria-pressed"], "true"); assert.equal(a.title, "Remove from favorites");
  assert.equal(b.classList.has("on"), false); assert.equal(b.attrs["aria-pressed"], "false"); assert.equal(b.title, "Add to favorites");
});
