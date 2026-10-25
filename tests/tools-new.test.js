const test = require("node:test"), assert = require("node:assert/strict");
const { lib } = require("./harness");

/* ---------- TOTP / HOTP ---------- */
const ascii = s => new TextEncoder().encode(s);

test("HOTP matches RFC 4226 appendix D", async () => {
  const key = ascii("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  for (let i = 0; i < expected.length; i++) assert.equal(await lib.hotp(key, i), expected[i], "counter " + i);
});

test("TOTP matches RFC 6238 appendix B (SHA-1, SHA-256, SHA-512)", async () => {
  const k1 = ascii("12345678901234567890"), k256 = ascii("12345678901234567890123456789012"), k512 = ascii("1234567890123456789012345678901234567890123456789012345678901234");
  const at = s => s * 1000;
  assert.equal(await lib.totp(k1, at(59), 30, 8, "SHA-1"), "94287082");
  assert.equal(await lib.totp(k1, at(1111111109), 30, 8, "SHA-1"), "07081804");
  assert.equal(await lib.totp(k1, at(1234567890), 30, 8, "SHA-1"), "89005924");
  assert.equal(await lib.totp(k1, at(20000000000), 30, 8, "SHA-1"), "65353130");
  assert.equal(await lib.totp(k256, at(59), 30, 8, "SHA-256"), "46119246");
  assert.equal(await lib.totp(k512, at(59), 30, 8, "SHA-512"), "90693936");
});

test("Base32 decoding and otpauth URIs", () => {
  assert.deepEqual(Array.from(lib.base32Decode("MFRGG===")), [97, 98, 99]);
  assert.deepEqual(Array.from(lib.base32Decode("mfr gg")), [97, 98, 99], "case, spaces and padding are forgiven");
  assert.throws(() => lib.base32Decode("AB1"), /Not Base32/);
  const o = lib.parseOtpauth("otpauth://totp/Acme%20Co:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Co&algorithm=SHA256&digits=8&period=60");
  assert.deepEqual({ ...o }, { type: "totp", secret: "JBSWY3DPEHPK3PXP", issuer: "Acme Co", account: "ada@example.com", algo: "SHA-256", digits: 8, period: 60, counter: 0 });
  assert.throws(() => lib.parseOtpauth("https://x.test"), /otpauth/);
});

/* ---------- Unicode ---------- */
test("Unicode: code points, flags, bytes", () => {
  const cps = lib.codepoints("a​b‮ \u{1F600}");
  assert.deepEqual(cps.map(c => c.cp), [0x61, 0x200B, 0x62, 0x202E, 0xA0, 0x1F600]);
  assert.ok(cps[1].flags.includes("invisible") && cps[1].name === "ZERO WIDTH SPACE");
  assert.ok(cps[3].flags.includes("bidi"));
  assert.ok(cps[4].flags.includes("space"));
  assert.equal(cps[5].cat, "So");
  assert.equal(cps[0].cat, "Ll");
  assert.deepEqual(lib.utf8Bytes(0x20AC), [0xE2, 0x82, 0xAC]);
  assert.deepEqual(lib.utf16Units(0x1F600), [0xD83D, 0xDE00]);
});

test("Unicode: reveal, stats and escapes", () => {
  assert.equal(lib.revealInvisible("ab​c"), "ab⟦U+200B⟧c");
  assert.equal(lib.revealInvisible("a b"), "a b", "ordinary spaces stay");
  const s = lib.unicodeStats("é\u{1F468}‍\u{1F469}");
  assert.equal(s.utf16, 7); assert.equal(s.codepoints, 5); assert.equal(s.graphemes, 2); assert.equal(s.utf8, 3 + 4 + 3 + 4);
  const e = lib.escapes("aé\u{1F600}");
  assert.equal(e["JavaScript / Python"], "a\\u00E9\\u{1F600}");
  assert.equal(e["U+ notation"], "U+0061 U+00E9 U+1F600");
  assert.equal(e["HTML entities"], "a&#xE9;&#x1F600;");
});

/* ---------- HTTP request builder ---------- */
test("buildCurl quotes safely and round-trips through the curl parser", () => {
  const req = { method: "POST", url: "https://api.test/items?a=1&b=2", headers: [["Content-Type", "application/json"], ["X-Note", "it's fine"]], body: `{"name":"O'Neil"}`, auth: { type: "bearer", token: "abc" } };
  const cmd = lib.buildCurl(req);
  const r = lib.parseCurl(cmd);
  assert.equal(r.url, req.url);
  assert.equal(r.method, "POST");
  assert.deepEqual(r.headers.map(h => h.join(": ")), ["Content-Type: application/json", "X-Note: it's fine", "Authorization: Bearer abc"]);
  assert.deepEqual(r.data, [req.body]);
  assert.match(lib.curlTo(cmd, "fetch"), /fetch\("https:\/\/api\.test\/items\?a=1&b=2"/);
  assert.equal(lib.buildCurl({ url: "https://x.test" }), "curl https://x.test");
  assert.match(lib.buildCurl({ url: "https://x.test", auth: { type: "basic", user: "u", pass: "p w" } }), /-u 'u:p w'/);
  assert.throws(() => lib.buildCurl({ url: "  " }), /Enter a URL/);
});

test("parseHeaderLines reports lines without a colon", () => {
  const r = lib.parseHeaderLines("Accept: a/b\n\nbroken line\nX-Url: http://x:80/");
  assert.deepEqual(r.headers, [["Accept", "a/b"], ["X-Url", "http://x:80/"]]);
  assert.deepEqual(r.bad, [3]);
});

/* ---------- Protobuf ---------- */
const PROTO = `syntax = "proto3"; package shop.v1;
// comment
enum Status { STATUS_UNSPECIFIED = 0; ACTIVE = 1; }
message Order {
  string id = 1;
  Status status = 2;
  repeated Item items = 3;
  map<string, int32> counts = 4;
  google.protobuf.Timestamp created_at = 5;
  oneof pay { string card = 6; string invoice = 7; }
  int64 total_cents = 8;
  message Item { string sku = 1; int32 qty = 2; Order parent = 3; }
  reserved 20 to 25, "old_field";
}
service Svc { rpc Get(Order) returns (stream Order); }`;

test("proto: parses messages, nesting, maps, oneofs, enums and services", () => {
  const m = lib.parseProto(PROTO);
  assert.equal(m.syntax, "proto3"); assert.equal(m.package, "shop.v1");
  const order = m.messages[0];
  assert.deepEqual(order.fields.map(f => [f.num, f.name]), [[1, "id"], [2, "status"], [3, "items"], [4, "counts"], [5, "created_at"], [6, "card"], [7, "invoice"], [8, "total_cents"]]);
  assert.equal(order.fields[3].map.value, "int32");
  assert.equal(order.fields[5].oneof, "pay");
  assert.equal(order.messages[0].name, "Item");
  assert.deepEqual(m.enums[0].values.map(v => v.name), ["STATUS_UNSPECIFIED", "ACTIVE"]);
  assert.deepEqual(m.services[0].rpcs[0], { name: "Get", req: "Order", res: "Order", clientStream: false, serverStream: true });
  assert.match(lib.protoOutline(m), /message Order[\s\S]*3  repeated Item items[\s\S]*rpc Get\(Order\) returns \(stream Order\)/);
});

test("proto: JSON sample follows the proto3 JSON mapping", () => {
  const m = lib.parseProto(PROTO), s = lib.protoSample(m, "Order");
  assert.equal(s.id, "string");
  assert.equal(s.status, "ACTIVE", "first non-zero enum value");
  assert.deepEqual(s.counts, { key: 1 });
  assert.equal(s.createdAt, "2024-01-01T00:00:00Z");
  assert.equal(s.totalCents, "1", "int64 is a JSON string");
  assert.equal(s.card, "string"); assert.equal(s.invoice, undefined, "only the first member of a oneof");
  assert.equal(s.items[0].sku, "string");
  assert.deepEqual(Object.keys(lib.protoSample(m, "Order", { camel: false })).includes("created_at"), true);
  assert.throws(() => lib.protoSample(m, "Nope"), /not found/);
});

test("proto: recursive messages terminate", () => {
  const m = lib.parseProto("message Node { string v = 1; Node next = 2; repeated Node kids = 3; }");
  const s = lib.protoSample(m, "Node");
  assert.ok(JSON.stringify(s).length < 600);
});

test("proto: lint finds duplicate, reserved and out-of-range numbers, and a bad proto3 enum", () => {
  const m = lib.parseProto(`syntax = "proto3"; enum E { A = 1; } message M { string a = 1; string b = 1; string a = 2; int32 c = 19500; int32 d = 22; reserved 20 to 25; reserved "e"; int32 e = 3; }`);
  const l = lib.protoLint(m).join("\n");
  assert.match(l, /field number 1 is used by both "a" and "b"/);
  assert.match(l, /field name "a" appears twice/);
  assert.match(l, /19500.*outside the allowed range/);
  assert.match(l, /field number 22 of "d" is reserved/);
  assert.match(l, /"e" is also listed as reserved/);
  assert.match(l, /E: a proto3 enum needs a value numbered 0/);
});

test("proto: syntax errors carry line numbers", () => {
  assert.throws(() => lib.parseProto("message M {\n  string a = ;\n}"), /Line 2/);
  assert.throws(() => lib.parseProto("message M {\n string a = 1;"), /missing its closing brace/);
  assert.throws(() => lib.parseProto('message M { string a = 1; } @'), /unexpected character/);
});
