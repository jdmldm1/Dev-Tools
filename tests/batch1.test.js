const test = require("node:test"), assert = require("node:assert/strict");
const { lib } = require("./harness");

test("word/case helpers", () => {
  assert.deepEqual(lib.words("parseHTTPResponse_v2"), ["parse", "HTTP", "Response", "v2"]);
  assert.equal(lib.camel("user_id-name"), "userIdName");
  assert.equal(lib.pascal("hello world"), "HelloWorld");
  assert.equal(lib.snake("getUserByID"), "get_user_by_id");
  assert.equal(lib.kebab("HelloWorld"), "hello-world");
});

test("json lenient + error position", () => {
  const src = '{ // c\n "a": [1,2,], /* x */ "b": "//not a comment", }';
  assert.deepEqual(JSON.parse(lib.lenientJson(src)), { a: [1, 2], b: "//not a comment" });
  const bad = '{\n  "a": 1,\n  "b": }';
  try { JSON.parse(bad); } catch (e) { assert.match(lib.jsonError(bad, e), /line 3/); }
  assert.deepEqual(lib.jsonStats({ a: { b: [1] } }), { keys: 2, depth: 3 });
  assert.equal(JSON.stringify(lib.sortKeys({ b: 1, a: { d: 1, c: 2 } })), '{"a":{"c":2,"d":1},"b":1}');
  const sample = { user: { name: "Ada", roles: ["admin", "dev"] }, items: [{ id: 1 }, { id: 2 }] };
  assert.equal(lib.jsonQuery(sample, "user.name"), "Ada");
  assert.equal(lib.jsonQuery(sample, "user.roles[1]"), "dev");
  assert.deepEqual(lib.jsonQuery(sample, "items.*.id"), [1, 2]);
  assert.equal(lib.jsonQuery(sample, "missing.prop"), undefined);
});

test("csv parse/serialize round trip", () => {
  const text = 'name,note\nAda,"hello, ""world"""\nLin,"multi\nline"\n';
  const rows = lib.parseCSV(text);
  assert.deepEqual(rows, [["name", "note"], ["Ada", 'hello, "world"'], ["Lin", "multi\nline"]]);
  assert.equal(lib.toCSV(rows), 'name,note\nAda,"hello, ""world"""\nLin,"multi\nline"');
  assert.deepEqual(lib.csvToObjects([["a", "b", "c"], ["1", "true", ""]]), [{ a: 1, b: true, c: null }]);
  assert.deepEqual(lib.objectsToRows([{ a: 1 }, { b: 2 }]), [["a", "b"], [1, ""], ["", 2]]);
  assert.deepEqual(lib.parseCSV("a;b\n1;2", ";"), [["a", "b"], ["1", "2"]]);
});

const SAMPLE = { id: 1, name: "Ada", score: 1.5, tags: ["a"], address: { city: "X", zip: null }, items: [{ sku: "a", qty: 1 }, { sku: "b", note: "hi" }] };

test("types: TypeScript", () => {
  const out = lib.jsonToTypes(SAMPLE, "ts", "Person");
  assert.match(out, /export interface Person \{/);
  assert.match(out, /id: number;/);
  assert.match(out, /tags: string\[\];/);
  assert.match(out, /zip: null;/);
  assert.match(out, /items: Item\[\];/);
  assert.match(out, /qty\?: number;/);
  assert.match(out, /note\?: string;/);
});

test("types: Go / C# / Python / Rust", () => {
  const go = lib.jsonToTypes(SAMPLE, "go", "Person");
  assert.match(go, /type Person struct/);
  assert.match(go, /ID\s+int64\s+`json:"id"`/);
  assert.match(go, /Qty\s+\*int64\s+`json:"qty,omitempty"`/);
  assert.match(go, /Items\s+\[\]Item/);
  const cs = lib.jsonToTypes(SAMPLE, "cs", "Person");
  assert.match(cs, /public class Person/);
  assert.match(cs, /public List<string> Tags/);
  assert.match(cs, /public long\? Qty/);
  const py = lib.jsonToTypes(SAMPLE, "py", "Person");
  assert.match(py, /@dataclass\nclass Person:/);
  assert.ok(py.indexOf("class Item:") < py.indexOf("class Person:"), "children defined first");
  assert.match(py, /qty: int \| None = None/);
  const rs = lib.jsonToTypes(SAMPLE, "rust", "Person");
  assert.match(rs, /pub struct Person/);
  assert.match(rs, /pub qty: Option<i64>/);
  assert.match(rs, /pub tags: Vec<String>/);
});

test("types: array root and mixed", () => {
  assert.match(lib.jsonToTypes([{ a: 1 }, { a: 2 }], "ts", "Rows"), /export type Rows = RowsItem\[\];/);
  assert.match(lib.jsonToTypes({ v: [1, "x"] }, "ts"), /v: unknown\[\];/);
  assert.match(lib.jsonToTypes({ class: 1 }, "py"), /class_: int/);
});

test("curl tokenizer + parser", () => {
  assert.deepEqual(lib.shellSplit(`curl -H "A: b c" 'x y' z\\ w $'a\\nb'`), ["curl", "-H", "A: b c", "x y", "z w", "a\nb"]);
  const r = lib.parseCurl(`curl -X POST https://api.example.com/items \\\n  -H 'Content-Type: application/json' \\\n  -u bob:pw -d '{"name":"x"}'`);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://api.example.com/items");
  assert.deepEqual(r.basic, ["bob", "pw"]);
  assert.deepEqual(r.jsonBody, { name: "x" });
  const g = lib.parseCurl("curl -G -d q=1 -d p=2 example.com/s");
  assert.equal(g.url, "http://example.com/s?q=1&p=2");
  assert.equal(g.method, "GET");
  const j = lib.parseCurl(`curl --json '{"a":1}' https://x.test`);
  assert.equal(j.method, "POST");
  assert.ok(j.headers.some(h => h[0] === "Accept"));
  assert.equal(lib.parseCurl("curl -sSLk https://x.test").insecure, true);
  assert.equal(lib.parseCurl("curl -I https://x.test").method, "HEAD");
  assert.equal(lib.parseCurl("curl -XPUT -HX-A:1 https://x.test").method, "PUT");
});

test("curl generators produce code", () => {
  const cmd = `curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -H 'X-Key: k' -u bob:pw -d '{"name":"x","n":[1,true,null]}'`;
  const f = lib.curlTo(cmd, "fetch");
  assert.match(f, /fetch\("https:\/\/api\.example\.com\/items"/);
  assert.match(f, /btoa\("bob:pw"\)/);
  assert.match(f, /JSON\.stringify\(/);
  new Function("return async function(){" + f + "}")(); // syntactically valid JS
  const py = lib.curlTo(cmd, "python");
  assert.match(py, /payload = \{/);
  assert.match(py, /"n": \[\n\s+1,\n\s+True,\n\s+None,/);
  assert.match(py, /auth=\("bob", "pw"\)/);
  assert.match(lib.curlTo(cmd, "powershell"), /Invoke-RestMethod -Uri 'https:\/\/api\.example\.com\/items' -Method Post/);
  assert.match(lib.curlTo(cmd, "go"), /http\.NewRequest\("POST"/);
  assert.match(lib.curlTo(cmd, "csharp"), /new HttpMethod\("POST"\)/);
});

test("jsonLocate finds error positions", () => {
  const BS = String.fromCharCode(92);
  assert.equal(lib.jsonLocate('{"a":[1,2,{"b":null}]}'), null);
  assert.deepEqual(lib.jsonLocate('{\n  "a": 1,\n  "b": }'), { msg: "Unexpected token '}'", line: 3, col: 8 });
  assert.match(lib.jsonLocate('{"a":1,}').msg, /double-quoted property name/);
  assert.match(lib.jsonLocate("[1,2").msg, /end of JSON/);
  assert.match(lib.jsonLocate('{"a":1} x').msg, /after JSON value/);
  assert.match(lib.jsonLocate('"abc').msg, /Unterminated/);
  assert.match(lib.jsonLocate("{'a':1}").msg, /double-quoted/);
  assert.equal(lib.jsonLocate("01") && lib.jsonLocate("01").msg.includes("after JSON value"), true);
  // agrees with JSON.parse on a spread of inputs
  for (const t of ["1", "-0.5e+3", "true", "null", '"'+BS+'u00e9"', "[]", "{}", "[1,]", '{"a"}', "tru", "-", '"'+BS+'x"', "1.", ".5", "[1 2]"]) {
    let ok = true; try { JSON.parse(t); } catch (_) { ok = false; }
    assert.equal(lib.jsonLocate(t) === null, ok, t);
  }
});
