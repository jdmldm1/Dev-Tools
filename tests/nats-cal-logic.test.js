const test = require("node:test"), assert = require("node:assert/strict");
const { lib } = require("./harness");
const enc = s => new TextEncoder().encode(s);

/* ---------- payload fields, diff, query ---------- */
const XML = `<Msg xmlns="urn:x"><Header><SystemID><UUID>aaa</UUID></SystemID></Header><Pos><Latitude>0.6</Latitude><Longitude>-1.2</Longitude></Pos><Item id="1"><N>a</N></Item><Item id="2"><N>b</N></Item></Msg>`;

test("payloadFields flattens JSON, XML and reports plain text", () => {
  const j = lib.payloadFields(`{"a":{"b":[1,{"c":"x"}]},"n":null,"t":true,"e":{}}`);
  assert.equal(j.kind, "json");
  assert.deepEqual([...j.fields], [["a.b[0]", 1], ["a.b[1].c", "x"], ["n", null], ["t", true], ["e", "{}"]]);
  const x = lib.payloadFields(XML);
  assert.equal(x.kind, "xml");
  assert.equal(x.fields.get("Msg.Pos.Latitude"), "0.6");
  assert.equal(x.fields.get("Msg.Item[1].N"), "b");
  assert.equal(x.fields.get("Msg.Item[0].@id"), "1");
  assert.equal(lib.payloadFields("hello").kind, "text");
  assert.equal(lib.payloadFields(enc(`{"z":1}`)).fields.get("z"), 1, "bytes work too");
  assert.equal(lib.payloadFields("<broken").kind, "text");
});

test("payloadDiff reports added, removed and changed fields", () => {
  const d = lib.payloadDiff(`{"a":1,"b":2,"c":3}`, `{"a":1,"b":9,"d":4}`);
  assert.equal(d.structured, true); assert.equal(d.same, false);
  assert.deepEqual(d.changes.map(c => c.type + ":" + c.path), ["changed:b", "removed:c", "added:d"]);
  assert.equal(lib.payloadDiff(`{"a":1}`, `{ "a": 1 }`).same, true, "whitespace does not matter in JSON");
  const x = lib.payloadDiff(XML, XML.replace("<N>b</N>", "<N>z</N>"));
  assert.deepEqual(x.changes.map(c => c.path), ["Msg.Item[1].N"]);
  const t = lib.payloadDiff("one", "two");
  assert.equal(t.structured, false); assert.equal(t.same, false);
  assert.equal(lib.payloadDiff("same", "same").same, true);
  assert.equal(lib.payloadDiff(`{"a":1}`, "<a/>").kind, "mixed");
});

test("fieldQuery: comparisons, trailing paths, and/or, text and topic", () => {
  const f = lib.payloadFields(XML).fields, q = text => lib.fieldQuery(text);
  assert.ok(q("Latitude > 0.5").test(f));
  assert.ok(!q("Latitude > 0.7").test(f));
  assert.ok(q("Pos.Longitude < -1").test(f));
  assert.ok(q("latitude >= 0.6 and SystemID.UUID = AAA").test(f), "case-insensitive names and values");
  assert.ok(q("Item.N = b").test(f), "indexes are ignored");
  assert.ok(q("Item.N = z or Latitude > 0").test(f));
  assert.ok(!q("Item.N = z and Latitude > 0").test(f));
  assert.ok(q("Item.@id = 2").test(f));
  assert.ok(q("Longitude exists").test(f)); assert.ok(!q("Altitude exists").test(f));
  assert.ok(q("Altitude != 5").test(f), "a missing field is not equal to anything");
  assert.ok(q("N ~ /^B$/").test(f)); assert.ok(q("N ~ a").test(f));
  assert.ok(q("uuid").test(f, { raw: XML }), "a bare word searches the payload text");
  assert.ok(q("topic = uci.alpha").test(f, { topic: "uci.alpha" }));
  assert.ok(q("topic ~ alpha").test(f, { topic: "uci.alpha" }));
  assert.equal(q("").ok, false);
  assert.match(q("temp >").error, /Missing a value/);
  assert.equal(q("x ~ /(/").ok, false);
  assert.ok(lib.fieldQuery(`{"x":"a b"}`.length ? "x = 1" : "").ok);
  assert.ok(lib.fieldQuery("count > 3").test(lib.payloadFields(`{"count":5}`).fields));
  assert.ok(!lib.fieldQuery("count > 3").test(lib.payloadFields(`{"count":"abc"}`).fields), "non-numeric never satisfies a numeric comparison");
});

/* ---------- latency ---------- */
test("percentile uses the nearest rank", () => {
  assert.equal(lib.percentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(lib.percentile([10, 20, 30, 40, 50], 95), 50);
  assert.equal(lib.percentile([5], 99), 5);
  assert.equal(lib.percentile([], 50), 0);
});

test("LatencyTracker pairs requests with replies and counts failures", () => {
  const t = new lib.LatencyTracker({ timeoutMs: 1000 }), t0 = 1_000_000;
  for (let i = 0; i < 10; i++) { t.observe({ subject: "svc.echo", reply: "_INBOX.a." + i }, t0 + i * 100); t.observe({ subject: "_INBOX.a." + i, reply: "" }, t0 + i * 100 + (i + 1) * 10); }
  t.observe({ subject: "svc.echo", reply: "_INBOX.late" }, t0);                         // never answered
  t.observe({ subject: "svc.none", reply: "_INBOX.b" }, t0); t.observe({ subject: "_INBOX.b", reply: "", status: 503 }, t0 + 5);
  t.observe({ subject: "_INBOX.stray", reply: "" }, t0);                                 // a reply with no request: ignored
  const rows = t.snapshot(t0 + 5000), echo = rows.find(r => r.subject === "svc.echo"), none = rows.find(r => r.subject === "svc.none");
  assert.equal(echo.requests, 11); assert.equal(echo.replies, 10); assert.equal(echo.timeouts, 1);
  assert.equal(echo.min, 10); assert.equal(echo.max, 100); assert.equal(echo.p50, 50); assert.equal(echo.p95, 100);
  assert.ok(Math.abs(echo.avg - 55) < 1e-9);
  assert.ok(Math.abs(echo.failRate - 1 / 11) < 1e-9);
  assert.equal(none.noResponders, 1); assert.equal(none.replies, 0);
  assert.equal(rows[0].subject, "svc.echo", "busiest first");
  t.clear(); assert.equal(t.snapshot().length, 0);
});

test("LatencyTracker stays bounded", () => {
  const t = new lib.LatencyTracker({ maxPending: 5, maxSubjects: 2, keep: 3 });
  for (let i = 0; i < 20; i++) t.observe({ subject: "s" + (i % 4), reply: "r" + i }, 1000 + i);
  assert.ok(t.pending.size <= 5); assert.ok(t.stats.size <= 2); assert.ok(t.overflow > 0);
  const u = new lib.LatencyTracker({ keep: 3 });
  for (let i = 0; i < 10; i++) { u.observe({ subject: "q", reply: "r" + i }, i * 10); u.observe({ subject: "r" + i, reply: "" }, i * 10 + i + 1); }
  assert.equal(u.stats.get("q").samples.length, 3);
});

/* ---------- alerts: the new kinds ---------- */
test("match, field and invalid alerts fire on content and keep a history", () => {
  const t0 = 3_000_000_000_000, a = new lib.Alerts([], t0);
  a.add({ subject: "orders.>", kind: "match", value: "/fail(ed|ure)/" }, t0);
  a.add({ subject: "uci.*", kind: "field", value: "Latitude > 0.5" }, t0);
  a.add({ subject: "uci.>", kind: "invalid" }, t0);
  const ctx = (text, extra = {}) => ({ text: () => text, ...extra });
  a.record("orders.new", t0, ctx("all good")); a.record("other", t0, ctx("failed"));
  assert.equal(a.evaluate(t0 + 100).firing.length, 0);
  a.record("orders.new", t0 + 200, ctx("payment FAILURE for 7"));
  a.record("uci.alpha", t0 + 300, ctx(XML, { fields: () => lib.payloadFields(XML).fields }));
  a.record("uci.alpha", t0 + 400, ctx("x", { invalid: () => true, reason: () => "missing Timestamp" }));
  const r = a.evaluate(t0 + 500);
  assert.equal(r.firing.length, 3); assert.equal(r.started.length, 3);
  assert.deepEqual(a.history.map(h => h.kind), ["match", "field", "invalid"]);
  assert.equal(a.history[2].detail, "missing Timestamp");
  assert.equal(a.evaluate(t0 + 600).started.length, 0);
  assert.equal(a.evaluate(t0 + 20000).cleared.length, 3, "event alerts clear after the hold time");
});

test("alerts can be limited to a message type and reject bad rules", () => {
  const t0 = 4_000_000_000_000, a = new lib.Alerts([], t0);
  a.add({ subject: "t", kind: "match", value: "x", type: "SystemStatus" }, t0);
  a.record("t", t0, { type: "Other", text: () => "x" });
  assert.equal(a.evaluate(t0 + 1).firing.length, 0);
  a.record("t", t0 + 2, { type: "SystemStatus", text: () => "x" });
  assert.equal(a.evaluate(t0 + 3).firing.length, 1);
  assert.throws(() => a.add({ kind: "match", value: "" }), /text to look for/);
  assert.throws(() => a.add({ kind: "match", value: "/(/" }), /regular expression/);
  assert.throws(() => a.add({ kind: "field", value: "" }), /Type a query/);
  assert.throws(() => a.add({ kind: "nope", value: 1 }), /Unknown/);
});

/* ---------- templates, scenarios, responders ---------- */
test("template variables", () => {
  const ctx = { counter: 7, vars: { who: "ada" }, topic: "t.x", fields: lib.payloadFields(`{"Req":{"Id":"r-1"}}`).fields, now: new Date("2025-01-02T03:04:05.678Z") };
  assert.equal(lib.template("{{counter}}|{{var:who}}|{{in:Id}}|{{topic}}|{{now}}|{{epoch}}|{{epochMs}}", ctx), "7|ada|r-1|t.x|2025-01-02T03:04:05Z|1735787045|1735787045678");
  assert.match(lib.template("{{uuid}}", ctx), /^[0-9a-f-]{36}$/);
  for (let i = 0; i < 20; i++) { const n = +lib.template("{{rand:3-5}}", ctx); assert.ok(n >= 3 && n <= 5); assert.ok(["a", "b"].includes(lib.template("{{pick:a|b}}", ctx))); }
  assert.throws(() => lib.template("{{var:nope}}", ctx), /not defined/);
  assert.throws(() => lib.template("{{in:Missing}}", ctx), /no field "Missing"/);
  assert.throws(() => lib.template("{{wat}}", ctx), /Unknown variable/);
  assert.throws(() => lib.template("{{rand:x}}", ctx), /rand:MIN-MAX/);
  assert.deepEqual(lib.templateVars("a {{uuid}} b {{ var:x }}"), ["uuid", "var:x"]);
  assert.doesNotThrow(() => lib.templateCheck("{{uuid}} {{rand:1-2}} {{var:a}} {{in:X}}", { vars: { a: 1 }, hasIncoming: true }));
  assert.throws(() => lib.templateCheck("{{var:b}}", { vars: { a: 1 } }), /not defined/);
  assert.throws(() => lib.templateCheck("{{in:X}}", {}), /no incoming/);
});

test("scenarios parse, validate and run in order with delays and counters", async () => {
  const sc = lib.scenarioParse(JSON.stringify({ name: "demo", vars: { v: "V" }, steps: [{ delay: 100, topic: "a.{{counter}}", text: "one {{var:v}}" }, { topic: "b", text: "two", note: "n" }] }));
  assert.equal(sc.steps.length, 2); assert.equal(sc.steps[1].delay, 0);
  assert.deepEqual(lib.scenarioParse(lib.scenarioStringify(sc)).steps, sc.steps, "export then import round-trips");
  assert.throws(() => lib.scenarioParse("{"), /Not valid JSON/);
  assert.throws(() => lib.scenarioParse(`{"steps":[{"text":"x"}]}`), /Step 1 needs a topic/);
  assert.throws(() => lib.scenarioParse(`[{"topic":"t","text":"x","delay":-1}]`), /delay/);
  const sent = [], waits = [];
  const r = await lib.scenarioRun(sc, (t, x) => { sent.push(t + "=" + x); }, { sleep: ms => { waits.push(ms); return Promise.resolve(); }, speed: 2, loop: false });
  assert.deepEqual(sent, ["a.1=one V", "b=two"]); assert.deepEqual(waits, [50]); assert.equal(r.sent, 2);
  let n = 0;
  const r2 = await lib.scenarioRun(sc, () => { if (++n === 2) throw new Error("boom"); }, { sleep: () => Promise.resolve(), loop: false });
  assert.equal(r2.failed, 1); assert.equal(r2.lastError, "boom");
  let rounds = 0;
  const r3 = await lib.scenarioRun(sc, () => {}, { sleep: () => Promise.resolve(), loop: true, isStopped: () => rounds++ >= 9 });
  assert.ok(r3.stopped && r3.sent >= 4);
});

test("responders match on topic, message and fields, and answer from the request", () => {
  const rules = [
    { id: "1", match: { topic: "cmd.>", message: "Command", query: "Kind = Ping" }, reply: { topic: "status.{{in:Id}}", text: `{"Ack":"{{in:Id}}","n":{{counter}}}`, delay: 25 } },
    { id: "2", enabled: false, match: { topic: "cmd.>" }, reply: { topic: "x", text: "y" } },
    { id: "3", match: { topic: "cmd.*" }, reply: { topic: "fallback", text: "f" } },
  ];
  const m = { topic: "cmd.go", message: "Command", text: `{"Command":{"Id":"c-9","Kind":"Ping"}}` };
  assert.equal(lib.responderFind(rules, m).id, "1");
  assert.equal(lib.responderFind(rules, { ...m, text: `{"Command":{"Id":"c-9","Kind":"Other"}}` }).id, "3");
  assert.equal(lib.responderFind(rules, { ...m, topic: "nope" }), null);
  assert.deepEqual(lib.responderBuild(rules[0], m, { counter: 4 }), { topic: "status.c-9", text: `{"Ack":"c-9","n":4}`, delay: 25 });
});

/* ---------- capture tools ---------- */
const seq = n => Array.from({ length: n }, (_, i) => ({ at: i * 100, rec: { n: i } }));
const rngFrom = vals => { let i = 0; return () => vals[i++ % vals.length]; };

test("capFaults drops, duplicates, jitters and reorders deterministically", () => {
  const none = lib.capFaults(seq(5), {}); assert.deepEqual(none.plan.map(p => p.rec.n), [0, 1, 2, 3, 4]); assert.equal(none.stats.dropped, 0);
  const drop = lib.capFaults(seq(4), { drop: 0.5 }, rngFrom([0.1, 0.9, 0.2, 0.8]));
  assert.deepEqual(drop.plan.map(p => p.rec.n), [1, 3]); assert.equal(drop.stats.dropped, 2);
  const dup = lib.capFaults(seq(2), { dup: 1, dupDelay: 30 }, () => 0);
  assert.deepEqual(dup.plan.map(p => [p.rec.n, p.at, !!p.dup]), [[0, 0, false], [0, 30, true], [1, 100, false], [1, 130, true]]); assert.equal(dup.stats.duplicated, 2);
  const j = lib.capFaults(seq(3), { jitter: 20 }, rngFrom([1, 0, 0.5])); assert.deepEqual(j.plan.map(p => Math.round(p.at)), [20, 80, 200]);
  const re = lib.capFaults(seq(6), { reorder: 3 }, rngFrom([0, 0, 0, 0]));
  assert.deepEqual(re.plan.map(p => p.at), [0, 100, 200, 300, 400, 500], "send times are kept");
  assert.notDeepEqual(re.plan.map(p => p.rec.n), [0, 1, 2, 3, 4, 5]); assert.ok(re.stats.reordered > 0);
  assert.deepEqual(re.plan.map(p => p.rec.n).sort(), [0, 1, 2, 3, 4, 5], "nothing lost");
});

test("capPlay: pause, seek, speed changes and faults", async () => {
  const recs = Array.from({ length: 6 }, (_, i) => ({ t: 1000 + i * 1000, topic: "t", text: String(i), n: i }));
  const sent = [], slept = [];
  const ctl = { paused: false, speed: 2 };
  let polls = 0;
  const r = await lib.capPlay(recs, rec => { sent.push(+rec.text); if (rec.text === "1") ctl.seekT = 5000; }, { control: ctl, sleep: ms => { slept.push(ms); return Promise.resolve(); } });
  assert.deepEqual(sent, [0, 1, 4, 5], "seekT jumped past the middle");
  assert.equal(r.sent, 4);
  const sent2 = [];
  await lib.capPlay(recs, rec => { sent2.push(+rec.text); }, { speed: 0, faults: { drop: 1 }, rng: () => 0, sleep: () => Promise.resolve() });
  assert.deepEqual(sent2, [], "faults apply to the plan");
  const p = { paused: true }; let slept2 = 0;
  const res = await lib.capPlay(recs.slice(0, 2), () => {}, { control: p, sleep: () => { if (++slept2 > 3) p.paused = false; return Promise.resolve(); } });
  assert.ok(slept2 > 3 && res.sent === 2, "waits while paused, then plays");
  const old = await lib.capPlay(recs.slice(0, 3), () => {}, { speed: 0 }); assert.equal(old.sent, 3, "the original options still work");
});

function fakeStore(records, model = null) {
  const store = new lib.TrafficStore(model, { validate: false });
  for (const r of records) store.add({ t: r.t, topic: r.topic, text: r.text, source: "x" });
  while (store.process(50) > 0) { /* decode everything */ }
  return store;
}
const uci = (name, sys, svc) => `<${name} xmlns="urn:u"><MessageHeader><SystemID><UUID>${sys}</UUID></SystemID><ServiceID><UUID>${svc}</UUID></ServiceID><Timestamp>2025-01-01T00:00:00Z</Timestamp><Mode>LIVE</Mode></MessageHeader><MessageData><V>1</V></MessageData></${name}>`;
const UA = "11111111-1111-4111-8111-111111111111", UB = "22222222-2222-4222-8222-222222222222", UC = "33333333-3333-4333-8333-333333333333";

test("captureDiff finds new and missing types, systems and topics", () => {
  const A = fakeStore([{ t: 1000, topic: "a", text: uci("Status", UA, UC) }, { t: 2000, topic: "a", text: uci("Status", UA, UC) }, { t: 61000, topic: "old", text: uci("Gone", UB, UC) }]);
  const B = fakeStore([{ t: 1000, topic: "a", text: uci("Status", UA, UC) }, { t: 2000, topic: "b", text: uci("Fresh", UB, UC) }]);
  const d = lib.captureDiff(A, B);
  assert.deepEqual(d.newTypes, ["Fresh"]); assert.deepEqual(d.goneTypes, ["Gone"]);
  assert.deepEqual(d.topicsOnlyA, ["old"]); assert.deepEqual(d.topicsOnlyB, ["b"]);
  assert.equal(d.totals.a, 3); assert.equal(d.totals.b, 2);
  assert.equal(d.systems.find(s => s.id === UB).status, "both");
  const md = lib.captureDiffMarkdown(d, { labelA: "before", labelB: "after" });
  assert.match(md, /# Capture comparison: before vs after/); assert.match(md, /Message types only in after\n\n- Fresh/);
});

test("conformance and report summarize a capture", () => {
  const s = fakeStore([{ t: 1000, topic: "a", text: uci("Status", UA, UC) }, { t: 2000, topic: "a", text: uci("Status", UA, UC) }, { t: 3000, topic: "b", text: uci("Other", UB, UC) }, { t: 4000, topic: "c", text: "plain text" }]);
  const cf = lib.conformance(s);
  assert.equal(cf.length, 2); assert.equal(cf.find(c => c.service === UC).total, 3); assert.equal(cf.find(c => c.service === "(no MessageHeader)").total, 1);
  const rep = lib.captureReport(s, { title: "T <x>", now: new Date("2025-01-01T00:00:00Z") });
  assert.equal(rep.data.total, 4); assert.equal(rep.data.systems, 3);
  assert.match(rep.markdown, /^# T <x>/); assert.match(rep.markdown, /## Conformance by service/); assert.match(rep.markdown, /Status \| 2 \|/);
  assert.match(rep.html, /<h1>T &lt;x&gt;<\/h1>/); assert.match(rep.html, /<table>/); assert.ok(!rep.html.includes("<x>"));
});

/* ---------- NKeys and creds ---------- */
test("NKey seeds: documented vector, round trips, typos", async () => {
  const k = await lib.nkeyFromSeed("SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4");
  assert.equal(k.publicKey, "UAH42UG6PV552P5SWLWTBP3H3S5BHAVCO2IEKEXUANJXR75J63RQ5WM6");
  assert.equal(k.type, "user");
  const g = await lib.nkeyGenerate("user");
  assert.match(g.seed, /^SU[A-Z2-7]{56}$/); assert.match(g.publicKey, /^U[A-Z2-7]{55}$/);
  assert.equal((await lib.nkeyFromSeed(g.seed)).publicKey, g.publicKey);
  const d = lib.nkeyDecodeSeed(g.seed); assert.equal(lib.nkeyEncodeSeed(d.type, d.raw), g.seed);
  const bad = g.seed.slice(0, 10) + (g.seed[10] === "A" ? "B" : "A") + g.seed.slice(11);
  assert.throws(() => lib.nkeyDecodeSeed(bad), /checksum/);
  assert.throws(() => lib.nkeyDecodeSeed("UABC"), /starts with S/);
  assert.throws(() => lib.nkeyDecodeSeed("SUAA"), /wrong length/);
  assert.equal((await lib.nkeyGenerate("account")).seed.slice(0, 2), "SA");
});

test("signing the nonce produces a verifiable Ed25519 signature; .creds parse", async () => {
  const g = await lib.nkeyGenerate("user");
  const r = await lib.natsSignNonce({ seed: g.seed }, "nonce-123");
  assert.equal(r.nkey, g.publicKey); assert.ok(!r.jwt);
  const sig = Uint8Array.from(atob(r.sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  assert.equal(sig.length, 64);
  const d = lib.nkeyDecodeSeed(g.seed), pk8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...d.raw]);
  const priv = await crypto.subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv); delete jwk.d; jwk.key_ops = ["verify"];
  const pub = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["verify"]);
  assert.ok(await crypto.subtle.verify("Ed25519", pub, sig, new TextEncoder().encode("nonce-123")));
  assert.equal((await lib.natsSignNonce({ seed: g.seed, jwt: "a.b.c" }, "n")).jwt, "a.b.c");
  await assert.rejects(() => lib.natsSignNonce({ seed: g.seed }, ""), /no nonce/);
  const creds = `-----BEGIN NATS USER JWT-----\neyJ0.eyJ1.sig_-\n------END NATS USER JWT------\n\n************************* IMPORTANT *************************\n\n-----BEGIN USER NKEY SEED-----\n${g.seed}\n------END USER NKEY SEED------\n`;
  assert.deepEqual(lib.natsParseCreds(creds), { jwt: "eyJ0.eyJ1.sig_-", seed: g.seed });
  assert.throws(() => lib.natsParseCreds("nope"), /does not look like/);
});

/* ---------- JetStream helpers ---------- */
test("stream and consumer configs are validated and shaped", () => {
  const s = lib.jsStreamConfig({ name: "ORDERS", subjects: "orders.> , audit.*", storage: "memory", retention: "workqueue", maxAge: "60", maxMsgs: "1000", replicas: "1" });
  assert.deepEqual(s.subjects, ["orders.>", "audit.*"]); assert.equal(s.storage, "memory"); assert.equal(s.retention, "workqueue"); assert.equal(s.max_age, 60e9); assert.equal(s.max_msgs, 1000); assert.equal(s.max_bytes, -1);
  assert.throws(() => lib.jsStreamConfig({ name: "bad name", subjects: "a" }), /letters, digits/);
  assert.throws(() => lib.jsStreamConfig({ name: "X", subjects: "" }), /at least one subject/);
  assert.throws(() => lib.jsStreamConfig({ name: "X", subjects: "a..b" }), /empty tokens/);
  assert.throws(() => lib.jsStreamConfig({ name: "X", subjects: "a", replicas: "2" }), /1, 3 or 5/);
  assert.throws(() => lib.jsStreamConfig({ name: "X", subjects: "a", maxMsgs: "-3" }), /whole number/);
  const c = lib.jsConsumerConfig({ name: "worker", filter: "orders.new", ack: "explicit", deliver: "last", maxDeliver: "5", ackWait: "30" });
  assert.deepEqual(c, { durable_name: "worker", ack_policy: "explicit", deliver_policy: "last", replay_policy: "instant", max_deliver: 5, filter_subject: "orders.new", ack_wait: 30e9 });
  assert.throws(() => lib.jsConsumerConfig({ name: "w", maxDeliver: "0" }), /positive/);
  assert.throws(() => lib.jsConsumerConfig({ name: "w!" }), /letters, digits/);
});

test("jsOps send the right API calls", async () => {
  const calls = [], api = (s, b) => { calls.push([s, b]); return Promise.resolve({}); };
  await lib.jsOps.streamCreate(api, { name: "S" }); await lib.jsOps.streamPurge(api, "S", { filter: "a.b" }); await lib.jsOps.streamPurge(api, "S");
  await lib.jsOps.consumerCreate(api, "S", { durable_name: "c", ack_policy: "explicit" }); await lib.jsOps.consumerDelete(api, "S", "c"); await lib.jsOps.msgDelete(api, "S", 7); await lib.jsOps.streamDelete(api, "S");
  assert.deepEqual(calls.map(c => c[0]), ["STREAM.CREATE.S", "STREAM.PURGE.S", "STREAM.PURGE.S", "CONSUMER.DURABLE.CREATE.S.c", "CONSUMER.DELETE.S.c", "STREAM.MSG.DELETE.S", "STREAM.DELETE.S"]);
  assert.deepEqual(calls[1][1], { filter: "a.b" }); assert.deepEqual(calls[2][1], {}); assert.equal(calls[3][1].config.durable_name, "c"); assert.equal(calls[5][1].seq, 7);
});

test("republish replays a stored range and counts gaps", async () => {
  const store = { 1: "one", 3: "three" }, published = [];
  const api = (s, b) => store[b.seq] ? Promise.resolve({ message: { subject: "orig", seq: b.seq, time: "", data: Buffer.from(store[b.seq]).toString("base64") } }) : Promise.reject(Object.assign(new Error("no msg"), { errCode: 10037 }));
  const client = { publish: (s, p) => published.push(s + ":" + new TextDecoder().decode(p)) };
  const r = await lib.jsOps.republish(api, client, "S", 1, 4, "replay.x");
  assert.deepEqual(published, ["replay.x:one", "replay.x:three"]); assert.deepEqual(r, { sent: 2, missing: 2 });
  await assert.rejects(() => lib.jsOps.republish(api, client, "S", 1, 2, "bad subject"), /Target subject/);
});

test("LagSeries classifies consumer health", () => {
  const L = new lib.LagSeries(10), cons = (pending, ackPending, redelivered, seq) => [{ name: "c", num_pending: pending, num_ack_pending: ackPending, num_redelivered: redelivered, delivered: { stream_seq: seq } }];
  for (let i = 0; i < 5; i++) L.sample("S", cons(i * 10, 0, 0, i), i * 1000); assert.equal(L.health("S/c"), "growing");
  const M = new lib.LagSeries(); for (let i = 0; i < 4; i++) M.sample("S", cons(50, 3, 0, 100), i * 1000); assert.equal(M.health("S/c"), "stalled");
  const N = new lib.LagSeries(); N.sample("S", cons(0, 1, 0, 5), 0); N.sample("S", cons(0, 1, 2, 6), 1000); assert.equal(N.health("S/c"), "redelivering");
  const O = new lib.LagSeries(); for (let i = 0; i < 4; i++) O.sample("S", cons(0, 0, 0, 100), i); assert.equal(O.health("S/c"), "ok", "idle with nothing waiting is fine");
  assert.equal(L.rows()[0].points.length, 5);
  for (let i = 0; i < 30; i++) L.sample("S", cons(1, 0, 0, i), 9000 + i); assert.equal(L.rows()[0].points.length, 10, "history is bounded");
});

/* ---------- KV and object store against a fake JetStream ---------- */
function fakeJs() {
  const msgs = [];                                               // { seq, subject, data, hdrs }
  const get = (b) => {
    let m;
    if (b.last_by_subj) m = [...msgs].reverse().find(x => x.subject === b.last_by_subj);
    else if (b.next_by_subj) m = msgs.find(x => x.seq >= b.seq && x.subject === b.next_by_subj);
    else m = msgs.find(x => x.seq === b.seq);
    if (!m) return Promise.reject(Object.assign(new Error("no message"), { errCode: 10037 }));
    return Promise.resolve({ message: { subject: m.subject, seq: m.seq, time: "2025-01-01T00:00:00Z", data: Buffer.from(m.data).toString("base64"), hdrs: m.headers.length ? Buffer.from("NATS/1.0\r\n" + m.headers.map(h => h[0] + ": " + h[1] + "\r\n").join("") + "\r\n").toString("base64") : undefined } });
  };
  const api = (subject, body) => subject.startsWith("STREAM.MSG.GET.") ? get(body) : subject.startsWith("STREAM.INFO.") ? Promise.resolve({ state: { first_seq: 1, subjects: Object.fromEntries([...new Set(msgs.map(m => m.subject))].filter(s => !body || !body.subjects_filter || lib.natsSubjectMatch(body.subjects_filter, s)).map(s => [s, 1])) } }) : Promise.reject(new Error("unexpected " + subject));
  const client = { request: (subject, payload, o) => { const seq = msgs.length + 1; const last = [...msgs].reverse().find(x => x.subject === subject); const exp = (o.headers || []).find(h => h[0] === "Nats-Expected-Last-Subject-Sequence");
    if (exp && +exp[1] !== (last ? last.seq : 0)) return Promise.resolve({ payload: new TextEncoder().encode(JSON.stringify({ error: { code: 400, err_code: 10071, description: "wrong last sequence" } })) });
    msgs.push({ seq, subject, data: new TextDecoder().decode(payload), headers: o.headers || [] }); return Promise.resolve({ payload: new TextEncoder().encode(JSON.stringify({ stream: "KV_b", seq })) }); } };
  return { api, client, msgs };
}

test("KV: put, compare-and-set, get, delete, purge and history", async () => {
  const { api, client } = fakeJs();
  assert.deepEqual(await lib.kv.put(client, "b", "cfg.a", "v1"), { revision: 1 });
  assert.deepEqual(await lib.kv.put(client, "b", "cfg.a", "v2", { expected: 1 }), { revision: 2 });
  await assert.rejects(() => lib.kv.put(client, "b", "cfg.a", "v3", { expected: 1 }), /wrong last sequence/);
  await assert.rejects(() => lib.kv.put(client, "b", "bad key", "x"), /A key uses/);
  assert.deepEqual(await lib.kv.put(client, "b", "new", "n", { expected: 0 }), { revision: 3 });
  let e = await lib.kv.entry(api, "b", "cfg.a"); assert.equal(new TextDecoder().decode(e.value), "v2"); assert.equal(e.revision, 2); assert.equal(e.op, "PUT");
  await lib.kv.delete(client, "b", "cfg.a");
  e = await lib.kv.entry(api, "b", "cfg.a"); assert.equal(e.op, "DEL");
  await lib.kv.purge(client, "b", "new"); assert.equal((await lib.kv.entry(api, "b", "new")).op, "PURGE");
  const h = await lib.kv.history(api, "b", "cfg.a"); assert.deepEqual(h.map(x => x.op + x.revision), ["PUT1", "PUT2", "DEL4"]);
  await assert.rejects(() => lib.kv.entry(api, "b", "never"), /no message/);
});

test("object store: names, listing and digest-checked download", async () => {
  const content = new TextEncoder().encode("hello object store!"), nuid = "NUID123";
  const digest = "SHA-256=" + Buffer.from(require("node:crypto").createHash("sha256").update(content).digest()).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const { api, msgs } = fakeJs();
  const meta = { name: "é.txt", size: content.length, chunks: 2, nuid, digest, mtime: "2025-01-01T00:00:00Z" };
  msgs.push({ seq: 1, subject: lib.obj.metaSubject("o", "é.txt"), data: JSON.stringify(meta), headers: [] });
  msgs.push({ seq: 2, subject: "$O.o.C." + nuid, data: "hello obj", headers: [] }, { seq: 3, subject: "$O.o.C." + nuid, data: "ect store!", headers: [] });
  msgs.push({ seq: 4, subject: lib.obj.metaSubject("o", "gone"), data: JSON.stringify({ name: "gone", deleted: true }), headers: [] });
  assert.equal(lib.obj.nameFromSubject("o", lib.obj.metaSubject("o", "é.txt")), "é.txt");
  const list = await lib.obj.list(api, "o");
  assert.deepEqual(list.map(x => x.name), ["é.txt"]);
  const got = await lib.obj.get(api, "o", list[0]);
  assert.equal(new TextDecoder().decode(got.bytes), "hello object store!"); assert.equal(got.sizeOk, true); assert.equal(got.digestOk, true);
  const bad = await lib.obj.get(api, "o", { ...list[0], digest: "SHA-256=AAAA" }); assert.equal(bad.digestOk, false);
});

test("subjectUsage finds orphans and idle subscriptions", () => {
  const connz = { connections: [
    { cid: 1, name: "me", subscriptions_list_detail: [{ subject: ">" }] },
    { cid: 2, name: "svc", subscriptions_list_detail: [{ subject: "orders.*", qgroup: "workers" }, { subject: "audit.>" }] },
    { cid: 3, name: "svc2", subscriptions_list_detail: [{ subject: "orders.*", qgroup: "workers" }] },
  ] };
  const observed = new Map([["orders.new", 10], ["orders.paid", 5], ["telemetry.x", 3]]);
  const u = lib.subjectUsage(connz, observed, 1);
  assert.deepEqual(u.rows.map(r => [r.subject, r.subscribers, r.observed]), [["orders.*", 2, 15], ["audit.>", 1, 0]]);
  assert.deepEqual(u.rows[0].queues, ["workers"]);
  assert.deepEqual(u.orphans, ["telemetry.x"]); assert.deepEqual(u.idle, ["audit.>"]);
});
