const test = require("node:test"), assert = require("node:assert/strict");
const { lib } = require("./harness");

test("timestamp parsing picks the right unit", () => {
  assert.equal(lib.parseTimestamp("1700000000").date.toISOString(), "2023-11-14T22:13:20.000Z");
  assert.equal(lib.parseTimestamp("1700000000000").unit, "milliseconds");
  assert.equal(lib.parseTimestamp("1700000000000000").unit, "microseconds");
  assert.equal(lib.parseTimestamp("1700000000000000000").unit, "nanoseconds");
  assert.equal(lib.parseTimestamp("2026-10-24T14:30:00Z").date.toISOString(), "2026-10-24T14:30:00.000Z");
  assert.equal(lib.parseTimestamp("-86400").date.toISOString(), "1969-12-31T00:00:00.000Z");
  assert.throws(() => lib.parseTimestamp("garbage"), /Could not parse/);
  assert.equal(lib.parseTimestamp("now").unit, "now");
});

test("time zones, iso week, durations", () => {
  const d = new Date("2026-01-15T12:00:00Z");
  assert.equal(lib.inZone(d, "UTC").text, "2026-01-15 12:00:00");
  assert.equal(lib.inZone(d, "Asia/Tokyo").text, "2026-01-15 21:00:00");
  assert.equal(lib.inZone(d, "Asia/Tokyo").offset, "+09:00");
  assert.equal(lib.inZone(d, "America/New_York").iso, "2026-01-15T07:00:00-05:00");
  assert.equal(lib.inZone(new Date("2026-07-01T12:00:00Z"), "America/Chicago").offset, "-05:00");   // DST
  assert.deepEqual(lib.isoWeek(new Date("2026-01-01T00:00:00Z")), { week: 1, year: 2026 });
  assert.deepEqual(lib.isoWeek(new Date("2021-01-03T00:00:00Z")), { week: 53, year: 2020 });
  assert.equal(lib.humanDuration(93784000), "1d 2h 3m 4s");
  assert.equal(lib.humanDuration(-5000), "-5s");
});

test("cron parse / describe", () => {
  assert.deepEqual(lib.parseCron("*/15 9-11 * * 1-5").fields.minute.set, [0, 15, 30, 45]);
  assert.deepEqual(lib.parseCron("0 0 * * 7").fields.dow.set, [0]);                       // 7 = Sunday
  assert.deepEqual(lib.parseCron("0 0 1 JAN,jul *").fields.month.set, [1, 7]);
  assert.deepEqual(lib.parseCron("5/20 * * * *").fields.minute.set, [5, 25, 45]);
  assert.deepEqual(lib.parseCron("@daily").fields.hour.set, [0]);
  assert.equal(lib.parseCron("*/10 * * * * *").hasSeconds, true);
  assert.throws(() => lib.parseCron("61 * * * *"), /out of range/);
  assert.throws(() => lib.parseCron("* * * *"), /Expected 5 fields/);
  assert.throws(() => lib.parseCron("0 0 L * *"), /Quartz/);
  assert.throws(() => lib.parseCron("*/0 * * * *"), /Bad step/);
  assert.equal(lib.cronDescribe("30 2 * * *"), "At 02:30");
  assert.equal(lib.cronDescribe("* * * * *"), "Every minute");
  assert.match(lib.cronDescribe("*/5 * * * *"), /^Every 5 minutes/);
  assert.match(lib.cronDescribe("0 9 * * 1-5"), /At 09:00 on Monday through Friday/);
  assert.match(lib.cronDescribe("0 0 1 6 *"), /day 1 of the month in June/);
});

test("cron next runs", () => {
  const from = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));   // Thu 2026-01-01 00:00 UTC
  const iso = a => a.map(d => d.toISOString());
  assert.deepEqual(iso(lib.cronNext("*/30 * * * *", from, 3, true)), ["2026-01-01T00:30:00.000Z", "2026-01-01T01:00:00.000Z", "2026-01-01T01:30:00.000Z"]);
  assert.deepEqual(iso(lib.cronNext("0 9 * * 1-5", from, 3, true)), ["2026-01-01T09:00:00.000Z", "2026-01-02T09:00:00.000Z", "2026-01-05T09:00:00.000Z"]);
  assert.deepEqual(iso(lib.cronNext("0 0 29 2 *", from, 2, true)), ["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]);
  // both dom and dow restricted => OR semantics: 15th OR any Friday
  const r = iso(lib.cronNext("0 0 15 * 5", from, 4, true));
  assert.deepEqual(r, ["2026-01-02T00:00:00.000Z", "2026-01-09T00:00:00.000Z", "2026-01-15T00:00:00.000Z", "2026-01-16T00:00:00.000Z"]);
  assert.deepEqual(iso(lib.cronNext("*/20 * * * * *", from, 2, true)), ["2026-01-01T00:00:20.000Z", "2026-01-01T00:00:40.000Z"]);
});

test("number bases and two's complement", () => {
  assert.equal(lib.parseBig("ff", 16), 255n);
  assert.equal(lib.parseBig("0xFF", 16), 255n);
  assert.equal(lib.parseBig("0b1010_1010", 2), 170n);
  assert.equal(lib.parseBig("-17", 10), -17n);
  assert.equal(lib.parseBig("ffffffffffffffffffff", 16), 1208925819614629174706175n);   // beyond 2^53
  assert.throws(() => lib.parseBig("12", 2), /not a base-2 digit/);
  assert.equal(lib.toBase(255n, 2), "11111111");
  const t = lib.twosComplement(-1n, 8);
  assert.deepEqual([t.unsigned, t.signed, t.hex, t.bin], [255n, -1n, "ff", "11111111"]);
  assert.equal(lib.twosComplement(200n, 8).signed, -56n);
  assert.equal(lib.twosComplement(256n, 8), null);
  assert.equal(lib.twosComplement(-129n, 8), null);
  assert.deepEqual(lib.formatBytes(1536), { decimal: "1.54 KB", binary: "1.5 KiB" });
  assert.equal(lib.byteUnits.GiB, 1073741824);
});

test("colors", () => {
  assert.deepEqual(lib.parseColor("#58a6ff"), { r: 88, g: 166, b: 255, a: 1 });
  assert.deepEqual(lib.parseColor("fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(lib.parseColor("#f008"), { r: 255, g: 0, b: 0, a: 0.533 });
  assert.deepEqual(lib.parseColor("rgb(10, 20, 30)"), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(lib.parseColor("rgba(100%, 0%, 0%, 0.5)"), { r: 255, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(lib.parseColor("hsl(120, 100%, 50%)"), { r: 0, g: 255, b: 0, a: 1 });
  assert.deepEqual(lib.parseColor("hsl(210deg 50% 40%)".replace("deg", "")), { r: 51, g: 102, b: 153, a: 1 });
  assert.equal(lib.parseColor("red").r, 255);
  assert.throws(() => lib.parseColor("not-a-color"));
  assert.deepEqual(lib.rgbToHsl(51, 102, 153), { h: 210, s: 50, l: 40 });
  assert.deepEqual(lib.rgbToHsv(255, 0, 0), { h: 0, s: 100, v: 100 });
  assert.equal(lib.toHex({ r: 255, g: 0, b: 128, a: 1 }), "#ff0080");
  assert.equal(lib.toHex({ r: 255, g: 0, b: 128, a: 0.5 }, true), "#ff008080");
  const bw = lib.contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
  assert.ok(Math.abs(bw - 21) < 1e-9);
  assert.deepEqual(lib.wcag(4.6), { aaNormal: true, aaLarge: true, aaaNormal: false, aaaLarge: true });
});

test("regex runner and highlighter", () => {
  const r = lib.runRegex("(?<k>\\w)(\\d)", "g", "a1 b2 c3", 10);
  assert.equal(r.matches.length, 3);
  assert.deepEqual(r.matches[1], { index: 3, end: 5, text: "b2", groups: ["b", "2"], named: { k: "b" } });
  assert.equal(lib.runRegex("x*", "g", "abc", 100).matches.length, 4);                    // empty matches terminate
  assert.equal(lib.runRegex("a", "", "aaa", 10).matches.length, 1);                       // no g flag => first only
  assert.equal(lib.runRegex("a", "g", "aaaa", 2).truncated, true);
  assert.match(lib.runRegex("(", "g", "x", 10).error, /Invalid regular expression/);
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  assert.equal(lib.highlightMatches("a<b", lib.runRegex("<", "g", "a<b", 5).matches, esc), 'a<mark class="m ">&lt;</mark>b');
});

test("line diff", () => {
  const ops = lib.lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(ops.map(o => o.t + ":" + o.line), ["ctx:a", "del:b", "add:B", "ctx:c", "ctx:d", "add:e"]);
  assert.equal(lib.lineDiff("x\ny", "x\ny").every(o => o.t === "ctx"), true);
  assert.deepEqual(lib.lineDiff("A  b", "a b", { ignoreWs: true, ignoreCase: true }).map(o => o.t), ["ctx"]);
  assert.deepEqual(lib.lineDiff("", "x").map(o => o.t + ":" + o.line), ["del:", "add:x"]);
  const many = Array.from({ length: 100 }, (_, i) => "l" + i).join("\n");
  const folded = lib.foldContext(lib.lineDiff(many, many.replace("l50", "CHANGED")), 2);
  assert.deepEqual(folded.map(o => o.t), ["gap", "ctx", "ctx", "del", "add", "ctx", "ctx", "gap"]);
  assert.equal(folded[0].n, 48);
});

test("case converter", () => {
  const c = (id, s) => lib.convertCase(id, s);
  assert.equal(c("camel", "parseHTTPResponse"), "parseHttpResponse");
  assert.equal(c("snake", "XMLHttpRequest"), "xml_http_request");
  assert.equal(c("constant", "user-account id"), "USER_ACCOUNT_ID");
  assert.equal(c("kebab", "Hello World_foo"), "hello-world-foo");
  assert.equal(c("train", "hello world"), "Hello-World");
  assert.equal(c("title", "the quick-brown fox"), "The Quick-Brown Fox");
  assert.equal(c("sentence", "HELLO there. how ARE you? fine"), "Hello there. How are you? Fine");
  assert.equal(c("swap", "aBc"), "AbC");
  assert.equal(c("snake", "a\nbC"), "a\nb_c");
});

test("text ops and stats", () => {
  const o = lib.textOps;
  assert.equal(o.sortAsc.run("b\na\nc"), "a\nb\nc");
  assert.equal(o.sortNat.run("a10\na2\nA1"), "A1\na2\na10");
  assert.equal(o.sortNum.run("10\n9\n100"), "9\n10\n100");
  assert.equal(o.unique.run("a\nb\na"), "a\nb");
  assert.equal(o.dupes.run("a\nb\na\nb\nc"), "a\nb");
  assert.equal(o.count.run("a\nb\na"), "2\ta\n1\tb");
  assert.equal(o.blank.run("a\n\n \nb"), "a\nb");
  assert.equal(o.number.run("x\ny"), "1  x\n2  y");
  assert.equal(o.unnumber.run("1  x\n2. y\n3) z"), "x\ny\nz");
  assert.equal(o.quote.run("a\nb", "'"), "'a'\n'b'");
  assert.equal(o.join.run("a\nb\n", ", "), "a, b");
  assert.equal(o.join.run("a\nb"), "a,b");
  assert.equal(o.split.run("a, b ,c", ","), "a\nb\nc");
  assert.equal(o.jsonArray.run("a\nb"), '[\n  "a",\n  "b"\n]');
  assert.equal(o.replace.run("a.b.c", ".", "-"), "a-b-c");
  assert.equal(o.regexReplace.run("a1b22", "\\d+", "#"), "a#b#");
  assert.equal(o.filter.run("apple\nbanana", "an"), "banana");
  assert.equal(o.exclude.run("apple\nbanana", "an"), "apple");
  assert.deepEqual(lib.textStats("Hi there. Bye!\nok"), { chars: 17, noSpaces: 14, words: 4, lines: 2, bytes: 17, sentences: 2 });
  assert.equal(lib.textStats("é😀").bytes, 6);
});

test("chmod", () => {
  assert.equal(lib.modeToSymbolic(0o755), "rwxr-xr-x");
  assert.equal(lib.modeToSymbolic(0o644), "rw-r--r--");
  assert.equal(lib.modeToSymbolic(0o4755), "rwsr-xr-x");
  assert.equal(lib.modeToSymbolic(0o4644), "rwSr--r--");
  assert.equal(lib.modeToSymbolic(0o1777), "rwxrwxrwt");
  assert.equal(lib.modeToSymbolic(0o1776), "rwxrwxrwT");
  assert.equal(lib.modeToSymbolic(0o2755), "rwxr-sr-x");
  assert.equal(lib.modeToOctal(0o755), "755");
  assert.equal(lib.modeToOctal(0o4755), "4755");
  assert.equal(lib.octalToMode("0644"), 0o644);
  assert.throws(() => lib.octalToMode("789"), /octal/);
  for (const m of [0o000, 0o644, 0o755, 0o777, 0o4755, 0o2750, 0o1777, 0o6755, 0o7777]) {
    assert.equal(lib.symbolicToMode(lib.modeToSymbolic(m)), m, m.toString(8));
    assert.equal(lib.symbolicToMode("-" + lib.modeToSymbolic(m)), m);
  }
  assert.throws(() => lib.symbolicToMode("rwx"), /nine characters/);
});

test("cidr math", () => {
  const c = lib.parseCidr("192.168.10.37/26");
  assert.deepEqual([c.network, c.broadcast, c.mask, c.wildcard, c.first, c.last, c.hosts], ["192.168.10.0", "192.168.10.63", "255.255.255.192", "0.0.0.63", "192.168.10.1", "192.168.10.62", 62]);
  assert.equal(c.special, "private (RFC 1918)");
  assert.equal(lib.parseCidr("10.0.0.0 255.255.0.0").prefix, 16);
  assert.equal(lib.parseCidr("8.8.8.8").prefix, 32);
  assert.equal(lib.parseCidr("1.2.3.4/31").hosts, 2);
  assert.equal(lib.parseCidr("0.0.0.0/0").size, 4294967296);
  assert.equal(lib.parseCidr("172.31.0.0/12").special, "private (RFC 1918)");
  assert.equal(lib.parseCidr("172.32.0.0/12").special, "public");
  assert.throws(() => lib.parseCidr("10.0.0.0 255.0.255.0"), /contiguous/);
  assert.throws(() => lib.parseCidr("300.1.1.1/8"), /not a valid IPv4/);
  assert.equal(lib.cidrContains("10.0.0.0/8", "10.255.255.255"), true);
  assert.equal(lib.cidrContains("10.0.0.0/8", "11.0.0.0"), false);
  assert.deepEqual(lib.splitCidr("10.0.0.0/24", 26).blocks, ["10.0.0.0/26", "10.0.0.64/26", "10.0.0.128/26", "10.0.0.192/26"]);
  assert.throws(() => lib.splitCidr("10.0.0.0/24", 20), /between/);
  assert.deepEqual(lib.rangeToCidrs("10.0.0.0", "10.0.0.255"), ["10.0.0.0/24"]);
  assert.deepEqual(lib.rangeToCidrs("10.0.0.5", "10.0.0.20"), ["10.0.0.5/32", "10.0.0.6/31", "10.0.0.8/29", "10.0.0.16/30", "10.0.0.20/32"]);
  assert.deepEqual(lib.rangeToCidrs("0.0.0.0", "255.255.255.255"), ["0.0.0.0/0"]);
  assert.equal(lib.intToIp(lib.ipToInt("255.255.255.255")), "255.255.255.255");
});
