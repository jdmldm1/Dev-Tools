const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { lib } = require("./harness");

const picture = qr => qr.modules.map(r => r.map(b => (b ? "#" : ".")).join("")).join("\n");

test("QR: output matches a module-for-module reference (cross-checked against the qrcode npm package)", () => {
  const qr = lib.qrEncode("hello, world!", { ecc: "M", mask: 3 });
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  assert.equal(crypto.createHash("sha256").update(picture(qr)).digest("hex"), "96f329f352b8ab5c932c82f79e6528c80c46d6e18d843282d03ec49b9882aeb4");
});

test("QR: structure is valid (finder patterns, timing, dark module)", () => {
  const qr = lib.qrEncode("https://example.com", { ecc: "Q" });
  const m = qr.modules, n = qr.size;
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
      assert.equal(m[oy + i][ox + j], ring !== 2, `finder at ${ox},${oy} (${i},${j})`);
    }
  }
  for (let i = 8; i < n - 8; i++) assert.equal(m[6][i], i % 2 === 0, "timing row");
  assert.equal(m[n - 8][8], true, "dark module");
});

test("QR: picks the smallest version that fits, and capacity grows with version", () => {
  for (const ecc of ["L", "M", "Q", "H"]) {
    let prev = 0;
    for (let v = 1; v <= 40; v++) { const c = lib.qrCapacity(v, ecc); assert.ok(c > prev, `${ecc} v${v} capacity ${c} must exceed ${prev}`); prev = c; }
  }
  assert.equal(lib.qrCapacity(40, "L"), 2953);
  assert.equal(lib.qrCapacity(40, "H"), 1273);
  assert.equal(lib.qrCapacity(10, "M"), 213);
  assert.equal(lib.qrEncode("a".repeat(lib.qrCapacity(5, "M")), { ecc: "M" }).version, 5);
  assert.equal(lib.qrEncode("a".repeat(lib.qrCapacity(5, "M") + 1), { ecc: "M" }).version, 6);
});

test("QR: UTF-8, auto mask, and errors", () => {
  const qr = lib.qrEncode("héllo ✓", { ecc: "L" });
  assert.ok(qr.mask >= 0 && qr.mask < 8);
  assert.throws(() => lib.qrEncode("x".repeat(3000), { ecc: "L" }), /Too long/);
  assert.throws(() => lib.qrEncode("x", { ecc: "Z" }), /Error correction/);
});

test("QR: SVG has one path and a quiet zone", () => {
  const qr = lib.qrEncode("a", { ecc: "L" });
  const svg = lib.qrSvg(qr, { scale: 2 });
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.equal((svg.match(/<path/g) || []).length, 1);
});

test("Wi-Fi string escapes reserved characters", () => {
  assert.equal(lib.wifiString({ ssid: "My;Net", password: "pa:ss\\word" }), "WIFI:T:WPA;S:My\\;Net;P:pa\\:ss\\\\word;;");
  assert.equal(lib.wifiString({ ssid: "open", type: "nopass" }), "WIFI:T:nopass;S:open;;");
  assert.equal(lib.wifiString({ ssid: "h", password: "p", hidden: true }), "WIFI:T:WPA;S:h;P:p;H:true;;");
});
