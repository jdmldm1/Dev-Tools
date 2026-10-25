const test = require("node:test"), assert = require("node:assert/strict");
const { lib, DT } = require("./harness");

test("share-link state round-trips (unicode, large, empty)", async () => {
  for (const state of [{}, { in: "héllo ✓ \u{1F600}\nline2", opt: true }, { in: "x".repeat(20000) }]) {
    const packed = await lib.packState(state);
    assert.match(packed, /^[zj][A-Za-z0-9_-]*$/);          // URL-safe, no padding
    assert.deepEqual(await lib.unpackState(packed), state);
  }
  assert.ok((await lib.packState({ in: "x".repeat(20000) })).length < 400, "repetitive input compresses");
});

test("share-link state rejects junk", async () => {
  await assert.rejects(() => lib.unpackState("qAAAA"), /Unsupported/);
  await assert.rejects(() => lib.unpackState("z!!!"));
});

test("hash route parsing", () => {
  globalThis.location = { hash: "#json?s=zabc&x=1" };
  const r = DT.route();
  assert.equal(r.id, "json");
  assert.equal(r.params.get("s"), "zabc");
  globalThis.location = { hash: "#xsd" };
  assert.equal(DT.route().id, "xsd");
  assert.equal(DT.route().params.get("s"), null);
  globalThis.location = { hash: "" };
  assert.equal(DT.route().id, "");
});

test("palette ranking: prefix > substring > keywords", () => {
  const it = (name, hay = name.toLowerCase()) => ({ kind: "Tool", name, hay });
  const q = "jwt";
  const a = lib.paletteScore(it("JWT Decoder"), q), b = lib.paletteScore(it("Decode JWT"), q), c = lib.paletteScore(it("Token Tool", "token tool jwt bearer"), q);
  assert.ok(a > b && b > c && c > 0);
  assert.equal(lib.paletteScore(it("Base64"), "zzz"), 0);
  assert.equal(lib.paletteScore({ kind: "Action", name: "x", hay: "x" }, ""), 0);
});
