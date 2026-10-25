const test = require("node:test"), assert = require("node:assert/strict"), nodeCrypto = require("node:crypto");
const { lib } = require("./harness");
const enc = s => new TextEncoder().encode(s);

test("base64 round trips and variants", () => {
  assert.equal(lib.b64encode("héllo ✓"), Buffer.from("héllo ✓").toString("base64"));
  assert.equal(lib.b64decode(lib.b64encode("héllo ✓")), "héllo ✓");
  assert.equal(lib.b64encode("??>>", true, false), "Pz8-Pg");
  assert.equal(lib.b64decode("Pz8-Pg"), "??>>");           // url-safe, no padding
  assert.equal(lib.b64decode("aGk=\n"), "hi");             // whitespace tolerated
  assert.throws(() => lib.b64decode("a$b"), /Not valid Base64/);
  assert.throws(() => lib.b64decode("a"), /impossible/);
  const big = new Uint8Array(100000).map((_, i) => i % 251);
  assert.deepEqual(lib.b64ToBytes(lib.bytesToB64(big)), big);
});

test("url encode/decode/parse", () => {
  assert.equal(lib.urlEncode.component("a b&c/é"), "a%20b%26c%2F%C3%A9");
  assert.equal(lib.urlEncode.form("a b"), "a+b");
  assert.equal(lib.urlDecode.form("a+b%21"), "a b!");
  assert.equal(lib.urlEncode.uri("http://x/a b?q=1"), "http://x/a%20b?q=1");
  const p = lib.parseUrl("https://u:p@example.com:8443/a/b?x=1&y=two%20words&x=3#frag");
  assert.equal(p.hostname, "example.com"); assert.equal(p.port, "8443"); assert.equal(p.hash, "#frag"); assert.equal(p.username, "u");
  assert.deepEqual(p.params, [["x", "1"], ["y", "two words"], ["x", "3"]]);
  assert.throws(() => lib.parseUrl("not a url"));
});

test("escapers round trip", () => {
  const s = `He said "hi" & <b>'bye'</b>\tnew\nline \\ end`;
  for (const k of ["html", "xml", "json", "js", "sql", "shell", "csv", "unicode", "regex"]) {
    const e = lib.escapers[k];
    const t = k === "regex" ? "a.b*c(d)[e]{f}|g\\h^$+?/-" : k === "sql" || k === "shell" ? "it's a 'test'" : s;
    assert.equal(e.dec(e.enc(t)), t, k);
  }
  assert.equal(lib.escapers.html.enc("<a href=\"x\">&</a>"), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(lib.escapers.html.dec("&lt;&#65;&#x42;&copy;&nbsp;&bogus;"), "<AB© &bogus;");
  assert.equal(lib.escapers.unicode.enc("é✓"), "\\u00e9\\u2713");
  assert.equal(lib.escapers.unicode.dec("\\u00e9\\u{1F600}"), "é😀");
  assert.equal(lib.escapers.shell.enc("it's"), `'it'\\''s'`);
});

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
test("jwt decode and verify", async () => {
  const t = lib.jwtDecode("Bearer " + JWT);
  assert.deepEqual(t.header, { alg: "HS256", typ: "JWT" });
  assert.deepEqual(t.payload, { sub: "1234567890", name: "John Doe", iat: 1516239022 });
  assert.equal(await lib.jwtVerifyHS(JWT, enc("your-256-bit-secret")), true);
  assert.equal(await lib.jwtVerifyHS(JWT, enc("wrong")), false);
  assert.throws(() => lib.jwtDecode("a.b"), /3 dot-separated/);
  assert.throws(() => lib.jwtDecode("a.b.c"), /not valid/);
  assert.match(lib.relTime(-3 * 36e5), /3 hours ago/);
  assert.match(lib.relTime(2 * 864e5), /2 days from now/);

  // RS256 public key verification test
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: "spki", format: "pem" });
  const sign = nodeCrypto.createSign("RSA-SHA256");
  const hdr = lib.bytesToB64(enc(JSON.stringify({ alg: "RS256", typ: "JWT" })), true, false);
  const pay = lib.bytesToB64(enc(JSON.stringify({ sub: "user1" })), true, false);
  const signing = hdr + "." + pay;
  sign.update(signing);
  const sig = sign.sign(privateKey);
  const rsJwt = signing + "." + lib.bytesToB64(new Uint8Array(sig), true, false);
  assert.equal(await lib.jwtVerifyPublic(rsJwt, pubPem), true);
  assert.equal(await lib.jwtVerifyPublic(rsJwt.slice(0, -2) + "==", pubPem), false);
});

test("md5 matches node crypto across sizes", () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 100000]) {
    const b = nodeCrypto.randomBytes(n);
    assert.equal(lib.md5(new Uint8Array(b)), nodeCrypto.createHash("md5").update(b).digest("hex"), "len " + n);
  }
  assert.equal(lib.md5(enc("hello")), "5d41402abc4b2a76b9719d911017c592");
});

test("digest + hmac match node crypto", async () => {
  for (const a of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
    const node = a.replace("-", "").toLowerCase();
    assert.equal(await lib.digest(a, enc("hello")), nodeCrypto.createHash(node).update("hello").digest("hex"), a);
    assert.equal(await lib.hmac(a, enc("key"), enc("msg")), nodeCrypto.createHmac(node, "key").update("msg").digest("hex"), a);
  }
  assert.equal(lib.hexToB64("68656c6c6f"), "aGVsbG8=");
});

test("generators", () => {
  assert.match(lib.uuid4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const a = lib.uuid7(1700000000000), b = lib.uuid7(1700000000001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(parseInt(a.replace(/-/g, "").slice(0, 12), 16), 1700000000000);
  assert.ok(a.slice(0, 15) <= b.slice(0, 15));
  const u = lib.ulid(1700000000000);
  assert.match(u, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(u.slice(0, 10), "01HF7YAT00");                 // known ULID time prefix for 1700000000000
  const p = lib.password({ length: 16, symbols: false });
  assert.equal(p.value.length, 16);
  assert.match(p.value, /[a-z]/); assert.match(p.value, /[A-Z]/); assert.match(p.value, /\d/); assert.doesNotMatch(p.value, /[^A-Za-z0-9]/);
  assert.doesNotMatch(lib.password({ length: 200, noAmbiguous: true }).value, /[Il1O0o]/);
  assert.throws(() => lib.password({ lower: false, upper: false, digits: false, symbols: false }), /at least one/);
  const counts = new Array(6).fill(0);
  for (let i = 0; i < 60000; i++) counts[lib.randInt(6)]++;
  counts.forEach(c => assert.ok(c > 9000 && c < 11000, "roughly uniform " + counts));
});
