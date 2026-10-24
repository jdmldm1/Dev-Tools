const test = require("node:test"), assert = require("node:assert/strict");
const { lib } = require("./harness");
const TE = new TextEncoder(), TD = new TextDecoder();
const str = b => TD.decode(b);

function parse(bytes, chunk = bytes.length) {
  const ops = [], p = lib.natsParser(o => ops.push(o));
  for (let i = 0; i < bytes.length; i += chunk) p.push(bytes.slice(i, i + chunk));
  return ops;
}

test("headers round-trip, including a status line", () => {
  const enc = lib.natsEncodeHeaders([["Nats-Msg-Id", "42"], ["A", "x: y"]]);
  assert.equal(str(enc), "NATS/1.0\r\nNats-Msg-Id: 42\r\nA: x: y\r\n\r\n");
  assert.deepEqual(lib.natsParseHeaders(enc), { status: 0, description: "", headers: [["Nats-Msg-Id", "42"], ["A", "x: y"]] });
  const idle = lib.natsParseHeaders(TE.encode("NATS/1.0 100 Idle Heartbeat\r\n\r\n"));
  assert.equal(idle.status, 100); assert.equal(idle.description, "Idle Heartbeat");
  assert.equal(lib.natsParseHeaders(TE.encode("NATS/1.0 503\r\n\r\n")).status, 503);
  assert.throws(() => lib.natsParseHeaders(TE.encode("HTTP/1.1 200\r\n")), /bad header/);
});

test("PUB and HPUB frames have exact lengths", () => {
  assert.equal(str(lib.natsPub("a.b", "", [], TE.encode("hello"))), "PUB a.b 5\r\nhello\r\n");
  assert.equal(str(lib.natsPub("a.b", "r.1", [], TE.encode(""))), "PUB a.b r.1 0\r\n\r\n");
  const f = str(lib.natsPub("a", "r", [["K", "v"]], TE.encode("xy")));
  const hdr = "NATS/1.0\r\nK: v\r\n\r\n";
  assert.equal(f, `HPUB a r ${hdr.length} ${hdr.length + 2}\r\n${hdr}xy\r\n`);
});

test("parser handles every op, byte-at-a-time and in one go", () => {
  const hdr = "NATS/1.0\r\nK: v\r\n\r\n";
  const wire = "INFO {\"server_id\":\"X\",\"headers\":true}\r\nPING\r\nPONG\r\n+OK\r\n-ERR 'Authorization Violation'\r\n"
    + "MSG foo 1 5\r\nhe\r\no\r\n"                                   // payload that contains CRLF
    + "MSG foo.bar 2 reply.to 0\r\n\r\n"
    + `HMSG s 3 ${hdr.length} ${hdr.length + 3}\r\n${hdr}abc\r\n`
    + "HMSG s 4 rr 22 22\r\nNATS/1.0 503\r\n\r\n\r\n".replace("22 22", "16 16");
  for (const chunk of [1, 3, 7, 1000]) {
    const o = parse(TE.encode(wire), chunk);
    assert.deepEqual(o.map(x => x.op), ["INFO", "PING", "PONG", "+OK", "-ERR", "MSG", "MSG", "HMSG", "HMSG"], "chunk " + chunk);
    assert.equal(o[0].info.server_id, "X");
    assert.equal(o[4].message, "Authorization Violation");
    assert.equal(str(o[5].payload), "he\r\no"); assert.equal(o[5].sid, "1"); assert.equal(o[5].reply, "");
    assert.equal(o[6].reply, "reply.to"); assert.equal(o[6].payload.length, 0);
    assert.deepEqual(o[7].headers, [["K", "v"]]); assert.equal(str(o[7].payload), "abc");
    assert.equal(o[8].status, 503); assert.equal(o[8].reply, "rr"); assert.equal(o[8].payload.length, 0);
  }
});

test("parser rejects protocol violations", () => {
  assert.throws(() => parse(TE.encode("BOGUS 1\r\n")), /unknown operation/);
  assert.throws(() => parse(TE.encode("MSG a 1\r\n")), /bad MSG/);
  assert.throws(() => parse(TE.encode("MSG a 1 2\r\nabXX")), /not terminated/);
  assert.throws(() => parse(TE.encode("HMSG a 1 9 4\r\n")), /sizes/);
  assert.throws(() => lib.natsParser(() => {}).push(new Uint8Array(70000).fill(65)), /too long/);
});

test("subject validation and matching", () => {
  const bad = (s, w) => lib.natsSubjectProblem(s, w);
  assert.equal(bad("a.b.c", false), "");
  assert.equal(bad("a.*.>", true), "");
  assert.match(bad("a.*", false), /only valid when subscribing/);
  assert.match(bad("a..b", true), /empty tokens/);
  assert.match(bad("a b", true), /spaces/);
  assert.match(bad("a.>.b", true), /last token/);
  assert.match(bad("a.b*", true), /whole token/);
  assert.match(bad("", true), /empty/);
  const m = lib.natsSubjectMatch;
  assert.ok(m("a.b", "a.b")); assert.ok(m("a.*", "a.b")); assert.ok(m("a.>", "a.b.c")); assert.ok(m(">", "x"));
  assert.ok(!m("a.*", "a.b.c")); assert.ok(!m("a.>", "a")); assert.ok(!m("a.b", "a")); assert.ok(!m("a", "a.b"));
});

test("payload views and inputs", () => {
  assert.deepEqual(lib.natsView(new Uint8Array(0)), { kind: "empty", text: "" });
  assert.deepEqual(lib.natsView(TE.encode('{"a":[1,2]}')), { kind: "json", text: '{\n  "a": [\n    1,\n    2\n  ]\n}' });
  assert.equal(lib.natsView(TE.encode("{not json")).kind, "text");
  assert.equal(lib.natsView(TE.encode("42")).kind, "text");
  assert.equal(lib.natsView(Uint8Array.from([0xff, 0xfe, 0, 1])).kind, "binary");
  assert.equal(lib.natsView(TE.encode("héllo ✓")).text, "héllo ✓");
  assert.deepEqual([...lib.natsPayloadBytes("hex", "de AD 0xbe,ef")], [0xde, 0xad, 0xbe, 0xef]);
  assert.throws(() => lib.natsPayloadBytes("hex", "abc"), /even number/);
  assert.throws(() => lib.natsPayloadBytes("json", "{"), /not valid JSON/);
  assert.equal(str(lib.natsPayloadBytes("text", "{")), "{");
  assert.deepEqual(lib.natsParseHeaderLines("A: 1\n\nB:  two words \r\n"), [["A", "1"], ["B", "two words"]]);
  assert.throws(() => lib.natsParseHeaderLines("nocolon"), /Key: value/);
  assert.throws(() => lib.natsParseHeaderLines("bad name: v"), /Invalid header name/);
});

test("JetStream stream messages decode like delivered ones", () => {
  const b64 = s => Buffer.from(s).toString("base64");
  const m = lib.natsStreamMsg({ subject: "$KV.b.k", seq: 7, time: "2026-01-01T00:00:00Z", hdrs: b64("NATS/1.0\r\nKV-Operation: DEL\r\n\r\n"), data: b64("v") });
  assert.equal(m.seq, 7); assert.deepEqual(m.headers, [["KV-Operation", "DEL"]]); assert.equal(str(m.payload), "v");
  const bare = lib.natsStreamMsg({ subject: "a", seq: 1, data: b64("x") });
  assert.deepEqual(bare.headers, []);
  assert.equal(lib.natsStreamMsg({ subject: "a", seq: 1 }).payload.length, 0);
});

/* A scripted stand-in for a NATS WebSocket endpoint. */
function fakeServer(cfg = {}) {
  const log = [];
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; log.length = 0; FakeWS.last = this; this.subs = new Map();
      setTimeout(() => {
        if (cfg.refuse) { this.onerror && this.onerror(); this.onclose && this.onclose({}); return; }
        this.readyState = 1;
        this.reply(`INFO ${JSON.stringify({ server_id: "S1", server_name: "fake", version: "2.10.0", headers: true, max_payload: 1024, auth_required: !!cfg.auth })}\r\n`);
      }, 0);
    }
    reply(s, chunk = 5) { const b = TE.encode(s); for (let i = 0; i < b.length; i += chunk) { const part = b.slice(i, i + chunk); setTimeout(() => this.onmessage && this.onmessage({ data: part.buffer.slice(part.byteOffset, part.byteOffset + part.length) }), 0); } }
    send(bytes) {
      const s = TD.decode(bytes); log.push(s);
      if (s.startsWith("CONNECT")) {
        const c = JSON.parse(s.split("\r\n")[0].slice(8));
        if (cfg.auth && c.user !== "u") return this.reply("-ERR 'Authorization Violation'\r\n");
        return this.reply("PONG\r\n");
      }
      let m;
      if ((m = /^SUB (\S+) (?:\S+ )?(\d+)\r\n$/.exec(s))) this.subs.set(m[2], m[1]);
      else if ((m = /^UNSUB (\d+)/.exec(s))) this.subs.delete(m[1]);
      else if ((m = /^PUB (\S+) (?:(\S+) )?(\d+)\r\n([\s\S]*)\r\n$/.exec(s))) {
        const [, subj, reply, , data] = m;
        for (const [sid, pat] of this.subs) if (lib.natsSubjectMatch(pat, subj)) this.reply(`MSG ${subj} ${sid} ${reply ? reply + " " : ""}${data.length}\r\n${data}\r\n`);
        if (reply && subj === "svc.echo") this.reply(`MSG ${reply} ${[...this.subs].find(([, p]) => lib.natsSubjectMatch(p, reply))[0]} ${data.length}\r\n${data}\r\n`);
        if (reply && subj === "svc.none") this.reply(`HMSG ${reply} ${[...this.subs].find(([, p]) => lib.natsSubjectMatch(p, reply))[0]} 16 16\r\nNATS/1.0 503\r\n\r\n\r\n`);
        if (reply && subj.startsWith("$JS.API.")) {
          const sid = [...this.subs].find(([, p]) => lib.natsSubjectMatch(p, reply))[0];
          const body = subj === "$JS.API.STREAM.INFO.X" ? { error: { code: 404, err_code: 10059, description: "stream not found" } } : { type: "io.nats.jetstream.api.v1.account_info_response", streams: 3 };
          const j = JSON.stringify(body); this.reply(`MSG ${reply} ${sid} ${j.length}\r\n${j}\r\n`);
        }
      }
    }
    close() { this.readyState = 3; }
  }
  return { WebSocket: FakeWS, log, FakeWS };
}

test("client connects, subscribes, publishes and receives (fragmented frames)", async () => {
  const f = fakeServer(), c = new lib.NatsClient({ WebSocket: f.WebSocket });
  const info = await c.connect("ws://x", { user: "u", pass: "p" });
  assert.equal(info.server_name, "fake");
  const connect = JSON.parse(f.log[0].split("\r\n")[0].slice(8));
  assert.equal(connect.user, "u"); assert.equal(connect.pass, "p"); assert.equal(connect.headers, true); assert.equal(connect.no_responders, true);
  assert.ok(f.log[0].endsWith("\r\nPING\r\n"));
  const got = []; const s = c.subscribe("a.>", m => got.push(m), { queue: "q" });
  assert.match(f.log[1], /^SUB a\.> q 1\r\n$/);
  c.publish("a.b", TE.encode("hello"));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(got.length, 1); assert.equal(got[0].subject, "a.b"); assert.equal(str(got[0].payload), "hello");
  s.unsubscribe();
  assert.match(f.log.at(-1), /^UNSUB 1\r\n$/);
  assert.throws(() => c.publish("a.*", TE.encode("")), /only valid when subscribing/);
  assert.throws(() => c.publish("a", new Uint8Array(2000)), /max_payload/);
  assert.throws(() => c.subscribe("a b", () => {}), /spaces/);
  c.close();
  assert.throws(() => c.publish("a", TE.encode("")), /Not connected/);
});

test("request resolves, reports no responders, and times out", async () => {
  const f = fakeServer(), c = new lib.NatsClient({ WebSocket: f.WebSocket });
  await c.connect("ws://x");
  const r = await c.request("svc.echo", TE.encode("ping"), { timeout: 500 });
  assert.equal(str(r.payload), "ping");
  await assert.rejects(c.request("svc.none", TE.encode(""), { timeout: 500 }), /No responders/);
  await assert.rejects(c.request("svc.silent", TE.encode(""), { timeout: 60 }), /No reply within 60 ms/);
  await assert.rejects(c.request("bad subject"), /spaces/);
  const pending = c.request("svc.silent", TE.encode(""), { timeout: 5000 });
  c.close();
  await assert.rejects(pending, /Connection closed/);
});

test("JetStream API calls parse replies and surface API errors", async () => {
  const f = fakeServer(), c = new lib.NatsClient({ WebSocket: f.WebSocket });
  await c.connect("ws://x");
  assert.equal((await c.jsApi("INFO")).streams, 3);
  await assert.rejects(c.jsApi("STREAM.INFO.X", { subjects_filter: ">" }), e => { assert.match(e.message, /stream not found \(code 404, err_code 10059\)/); assert.equal(e.errCode, 10059); return true; });
  assert.ok(f.log.some(l => l.startsWith("PUB $JS.API.INFO _INBOX.")));
  c.close();
});

test("connect failures: bad credentials, refused socket, bad URL, timeout", async () => {
  await assert.rejects(new lib.NatsClient({ WebSocket: fakeServer({ auth: true }).WebSocket }).connect("ws://x", { user: "wrong" }), /Authorization Violation/);
  await assert.rejects(new lib.NatsClient({ WebSocket: fakeServer({ refuse: true }).WebSocket }).connect("ws://x"), /Could not open a WebSocket/);
  await assert.rejects(new lib.NatsClient({ WebSocket: class { constructor() { throw new Error("SecurityError: blocked"); } } }).connect("ws://x"), /SecurityError/);
  await assert.rejects(new lib.NatsClient({ WebSocket: class { constructor() { this.readyState = 0; } close() {} } }).connect("ws://x", { timeout: 40 }), /Timed out/);
});

test("server-initiated close reaches onclose, and PING gets a PONG", async () => {
  const f = fakeServer(), c = new lib.NatsClient({ WebSocket: f.WebSocket });
  await c.connect("ws://x");
  const ws = f.FakeWS.last; let reason = null; c.onclose = r => { reason = r; };
  ws.reply("PING\r\n", 100); await new Promise(r => setTimeout(r, 20));
  assert.equal(f.log.at(-1), "PONG\r\n");
  ws.onclose({ reason: "server shutdown" });
  assert.equal(reason, "server shutdown"); assert.equal(c.connected, false);
});

test("the parser sustains well over 100k messages per second (guards against an accidental slowdown)", () => {
  const body = '{"sensor":"s1","c":23.45}', N = 200000;
  const wire = TE.encode(Array.from({ length: N }, (_, i) => `MSG sensors.s${i % 3}.temp 1 ${body.length}\r\n${body}\r\n`).join(""));
  let n = 0; const p = lib.natsParser(() => { n++; });
  const t0 = performance.now();
  for (let i = 0; i < wire.length; i += 16384) p.push(wire.slice(i, i + 16384));
  const ms = performance.now() - t0;
  assert.equal(n, N);
  assert.ok(ms < 2000, `parsing ${N} messages took ${Math.round(ms)} ms`);        // typically ~200 ms; the bound leaves room for slow CI machines
});
