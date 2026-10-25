const test = require("node:test"), assert = require("node:assert/strict");
const { lib } = require("./harness");

test("NATS subject matching follows * and > rules", () => {
  const m = lib.natsSubjectMatch;
  assert.ok(m("orders.new", "orders.new"));
  assert.ok(m("orders.*", "orders.new"));
  assert.ok(!m("orders.*", "orders.new.eu"));
  assert.ok(m("orders.>", "orders.new.eu"));
  assert.ok(!m("orders.>", "orders"), "> needs at least one more token");
  assert.ok(m(">", "a.b.c"));
  assert.ok(m("*.b.*", "a.b.c"));
  assert.ok(!m("a.b", "a.b.c"));
  assert.ok(!m("a.b.c", "a.b"));
});

test("NATS subject pattern validation", () => {
  const v = lib.natsSubjectValid;
  for (const ok of ["a", "a.b", "a.*", "*.b", "a.>", ">", "uci.msg.>", "*"]) assert.ok(v(ok), ok);
  for (const bad of ["", "a b", "a..b", "a.>.b", "a>b", ".a", "a."]) assert.ok(!v(bad), JSON.stringify(bad));
});

test("profiles keep only valid entries and never carry credentials", () => {
  const P = lib.natsProfiles;
  const list = P.clean([
    { name: " lab ", url: "ws://localhost:8080", subs: [{ subject: "a.>", queue: "q" }, { subject: "bad subject" }], hide: false, user: "admin", pass: "secret", token: "t" },
    { name: "", url: "ws://x" }, { name: "nourl" }, { name: "http", url: "http://x" }, null,
  ]);
  assert.deepEqual(list, [{ name: "lab", url: "ws://localhost:8080", subs: [{ subject: "a.>", queue: "q" }], hide: false }]);
  assert.ok(!JSON.stringify(list).includes("secret"));
  let l = P.upsert([], { name: "b", url: "wss://b.test" });
  l = P.upsert(l, { name: "a", url: "ws://a.test" });
  l = P.upsert(l, { name: "b", url: "wss://b2.test" });
  assert.deepEqual(l.map(p => p.name + "=" + p.url), ["a=ws://a.test", "b=wss://b2.test"]);
  assert.deepEqual(P.remove(l, "a").map(p => p.name), ["b"]);
  assert.throws(() => P.upsert([], { name: "x", url: "nope" }), /needs a name/);
  assert.deepEqual(P.parse("not json"), []);
  assert.deepEqual(P.parse(JSON.stringify(l)), l, "export then import round-trips");
});

test("rate alerts fire above the limit and clear when traffic drops", () => {
  const t0 = 1_000_000_000_000;
  const a = new lib.NatsAlerts([], t0);
  a.add({ subject: "orders.*", kind: "rate", value: 10 }, t0);
  for (let s = 0; s < 5; s++) for (let i = 0; i < 20; i++) a.record("orders.new", t0 + s * 1000 + i);
  a.record("other.thing", t0);
  let r = a.evaluate(t0 + 5000);
  assert.equal(r.firing.length, 1); assert.equal(r.started.length, 1);
  assert.match(r.firing[0].text, /orders\.\*: 20 msg\/s \(limit 10\)/);
  r = a.evaluate(t0 + 5500);
  assert.equal(r.firing.length, 1); assert.equal(r.started.length, 0, "already firing: not reported as new");
  r = a.evaluate(t0 + 12000);
  assert.equal(r.firing.length, 0); assert.equal(r.cleared.length, 1);
});

test("silence alerts count from when they were armed, and reset on traffic", () => {
  const t0 = 2_000_000_000_000, a = new lib.NatsAlerts([], t0);
  const rule = a.add({ subject: "heartbeat", kind: "silence", value: 30 }, t0);
  assert.equal(a.evaluate(t0 + 20_000).firing.length, 0);
  const r = a.evaluate(t0 + 31_000);
  assert.equal(r.started.length, 1); assert.match(r.firing[0].text, /silent for 31 s/);
  a.record("heartbeat", t0 + 40_000);
  assert.equal(a.evaluate(t0 + 41_000).cleared.length, 1);
  a.remove(rule.id);
  assert.equal(a.evaluate(t0 + 999_000).firing.length, 0);
});

test("alert rules reject nonsense", () => {
  const a = new lib.NatsAlerts();
  assert.throws(() => a.add({ subject: "", kind: "rate", value: 1 }), /subject/);
  assert.throws(() => a.add({ subject: "a", kind: "rate", value: 0 }), /positive/);
  assert.throws(() => a.add({ subject: "a", kind: "bogus", value: 1 }), /Unknown/);
});
