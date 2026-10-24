const test = require("node:test"), assert = require("node:assert/strict");
const { lib } = require("./harness");

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- header -->
<Msg xmlns="urn:x" id="7" kind='a&amp;b'>
  <Header><UUID>abc</UUID></Header>
  <Item n="1">one</Item>
  <Item n="2"><![CDATA[<two>]]></Item>
  <Empty/>
</Msg>`;

test("xml parser accepts well-formed input and decodes entities", () => {
  const t = lib.xmlParse(SAMPLE);
  assert.equal(t.decl, 'xml version="1.0" encoding="UTF-8"');
  assert.equal(t.root.name, "Msg");
  assert.deepEqual(t.root.attrs, [["xmlns", "urn:x"], ["id", "7"], ["kind", "a&b"]]);
  const items = t.root.kids.filter(k => k.t === "el" && k.name === "Item");
  assert.equal(items.length, 2);
  assert.equal(items[1].kids[0].t, "cdata");
  assert.equal(lib.xmlParse("<a>&#65;&#x42;&lt;</a>").root.kids[0].v, "AB<");
  assert.equal(lib.xmlParse("﻿<a/>").root.name, "a");
});

test("xml parser reports precise errors", () => {
  const bad = (src, re, line, col) => {
    assert.throws(() => lib.xmlParse(src), e => { assert.match(e.message, re); if (line) { assert.equal(e.line, line); assert.equal(e.col, col); } return true; });
  };
  bad("<a><b></a>", /Mismatched tag: expected <\/b> but found <\/a>/, 1, 7);
  bad("<a>\n  <b>\n</a>", /Mismatched/, 3, 1);
  bad("<a>", /Unclosed element <a>/);
  bad('<a x="1" x="2"/>', /Duplicate attribute "x"/, 1, 10);
  bad("<a x=1/>", /quoted/);
  bad("<a>fish & chips</a>", /Unescaped '&'/, 1, 9);
  bad("<a>&nope;</a>", /Undefined entity &nope;/);
  bad("<a/><b/>", /Multiple root elements/, 1, 5);
  bad("hello<a/>", /Text outside the root/);
  bad("", /No root element/);
  bad("<a x='<'/>", /Malformed attribute/);
  bad("<a><!-- x </a>", /Unterminated comment/);
  bad("</a>", /Unexpected closing tag|Malformed/);
});

test("xml format / minify / json round trips", () => {
  const pretty = lib.xmlFormat("<a x='1'><b>t</b><c><d/></c><e>  </e></a>");
  assert.equal(pretty, '<a x="1">\n  <b>t</b>\n  <c>\n    <d/>\n  </c>\n  <e>  </e>\n</a>');          // blank text in a text-only element is data (fixed-width blank fields), so it is kept
  assert.equal(lib.xmlFormat(pretty, { minify: true }), '<a x="1"><b>t</b><c><d/></c><e>  </e></a>');
  assert.equal(lib.xmlFormat("<a>\n  <b/>\n  <c>   </c>\n</a>"), "<a>\n  <b/>\n  <c>   </c>\n</a>");     // …but blank text between child elements is just layout
  assert.equal(lib.xmlFormat("<a>\n  <b>t</b>\n</a>", { indent: "\t" }), "<a>\n\t<b>t</b>\n</a>");
  assert.equal(lib.xmlFormat("<a b='x\"y'>1 &lt; 2</a>"), '<a b="x&quot;y">1 &lt; 2</a>');
  // formatting is idempotent and re-parses to the same tree
  assert.equal(lib.xmlFormat(lib.xmlFormat(SAMPLE)), lib.xmlFormat(SAMPLE));
  const j = lib.xmlToJson(lib.xmlParse(SAMPLE), { stripPrefix: true });
  assert.deepEqual(j, { Msg: { "@id": "7", "@kind": "a&b", Header: { UUID: "abc" }, Item: [{ "@n": "1", "#text": "one" }, { "@n": "2", "#text": "<two>" }], Empty: "" } });
  const back = lib.xmlToJson(lib.xmlParse(lib.jsonToXml(j)), { stripPrefix: true });
  assert.deepEqual(back, j);
  assert.deepEqual(lib.xmlToJson(lib.xmlParse("<a><n>5</n><b>true</b><s>05</s></a>"), { infer: true }), { a: { n: 5, b: true, s: "05" } });
  assert.deepEqual(lib.xmlToJson(lib.xmlParse('<p:a xmlns:p="u"><p:b/></p:a>'), { stripPrefix: true }), { a: { b: "" } });
  assert.match(lib.jsonToXml({ x: 1, y: [2, 3] }, { rootName: "r" }), /<r>\n {2}<x>1<\/x>\n {2}<y>2<\/y>\n {2}<y>3<\/y>\n<\/r>/);
  assert.throws(() => lib.jsonToXml({ "bad name": 1 }), /not a valid XML element name/);
});

test("xml paths", () => {
  const p = lib.xmlPaths(lib.xmlParse(SAMPLE));
  assert.deepEqual(p.map(x => x.join("=")), ["/Msg/@xmlns=urn:x", "/Msg/@id=7", "/Msg/@kind=a&b", "/Msg/Header/UUID=abc", "/Msg/Item[1]/@n=1", "/Msg/Item[1]=one", "/Msg/Item[2]/@n=2", "/Msg/Item[2]=<two>", "/Msg/Empty="]);
});

test("coordinates", () => {
  const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
  near(lib.parseCoord("34.5"), 34.5);
  near(lib.parseCoord("-118.25", "lon"), -118.25);
  near(lib.parseCoord("34°30′0″N"), 34.5);
  near(lib.parseCoord("34 30 0 S"), -34.5);
  near(lib.parseCoord("N 34 30.5"), 34 + 30.5 / 60);
  near(lib.parseCoord("118 14 37 W", "lon"), -(118 + 14 / 60 + 37 / 3600));
  near(lib.parseCoord("340308N"), 34 + 3 / 60 + 8 / 3600);
  near(lib.parseCoord("1181437W", "lon"), -(118 + 14 / 60 + 37 / 3600));
  near(lib.parseCoord("0.5 rad"), 0.5 * 180 / Math.PI);
  assert.throws(() => lib.parseCoord("91"), /Out of range/);
  assert.throws(() => lib.parseCoord("181", "lon"), /Out of range/);
  assert.throws(() => lib.parseCoord("34 61"), /Minutes/);
  assert.throws(() => lib.parseCoord("34 E", "lat"), /N or S/);
  assert.throws(() => lib.parseCoord("abc"), /No number/);
  const f = lib.formatCoord(-118.243611, "lon");
  assert.equal(f.dms, "118° 14′ 37″ W");
  assert.equal(f.dm.startsWith("118° 14.6"), true);
  assert.equal(lib.formatCoord(34.5, "lat").dd, "34.5");
  assert.equal(lib.formatCoord(34, "lat").dd, "34.0");
  assert.equal(lib.formatCoord(0.5, "lat").rad, (0.5 * Math.PI / 180).toFixed(10));
  assert.equal(lib.formatCoord(33.99999999, "lat").dms, "34° 0′ 0″ N");   // carries instead of printing 60″
  assert.equal(lib.formatCoord(33.99999999, "lat").dm, "34° 0′ N");
  assert.equal(lib.formatCoord(33.9999, "lat").dm, "33° 59.994′ N");
});

test("great-circle math and units", () => {
  const d = lib.haversine(51.5074, -0.1278, 48.8566, 2.3522);          // London - Paris
  assert.ok(Math.abs(d / 1000 - 343.6) < 1.5, d);
  assert.ok(Math.abs(lib.bearing(51.5074, -0.1278, 48.8566, 2.3522) - 148.1) < 0.5);
  assert.equal(Math.round(lib.bearing(0, 0, 10, 0)), 0);
  assert.equal(Math.round(lib.bearing(0, 0, 0, 10)), 90);
  const p = lib.destination(34.05, -118.24, 45, 100000);
  assert.ok(Math.abs(lib.haversine(34.05, -118.24, p.lat, p.lon) - 100000) < 1, "round trip distance");
  assert.ok(Math.abs(lib.bearing(34.05, -118.24, p.lat, p.lon) - 45) < 0.1);
  assert.ok(Math.abs(lib.destination(0, 179, 90, 222000).lon - -178.99) < 0.02, "wraps across the antimeridian");
  const c = lib.convertUnit;
  assert.ok(Math.abs(c("speed", 250, "kt")["m/s"] - 128.611) < 0.001);
  assert.equal(c("length", 350, "FL (100 ft)").m, 10668);
  assert.equal(c("length", 1, "nmi").m, 1852);
  assert.ok(Math.abs(c("angle", 180, "deg").rad - Math.PI) < 1e-12);
  assert.equal(c("temperature", 100, "°C")["°F"], 212);
  assert.ok(Math.abs(c("temperature", 0, "K")["°C"] + 273.15) < 1e-9);
  assert.ok(Math.abs(c("pressure", 29.92, "inHg").hPa - 1013.2) < 0.2);
  assert.throws(() => c("length", 1, "parsec"), /Unknown unit/);
});

test("byte parsing, hexdump, checksums", () => {
  assert.deepEqual([...lib.parseBytes("DE ad:BE-ef", "hex")], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual([...lib.parseBytes("0xDE,0xAD", "hex")], [0xde, 0xad]);
  assert.deepEqual([...lib.parseBytes("1, 2 255", "dec")], [1, 2, 255]);
  assert.deepEqual([...lib.parseBytes("3q2+7w==", "b64")], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual([...lib.parseBytes("é", "text")], [0xc3, 0xa9]);
  assert.throws(() => lib.parseBytes("abc", "hex"), /Odd number/);
  assert.throws(() => lib.parseBytes("zz", "hex"), /non-hex/);
  assert.throws(() => lib.parseBytes("256", "dec"), /0-255/);
  assert.equal(lib.bytesToHex(Uint8Array.from([1, 171])), "01 ab");
  const dump = lib.hexdump(new TextEncoder().encode("Hello, hexdump!\n\x00ok"));
  assert.equal(dump.split("\n")[0], "00000000  48 65 6c 6c 6f 2c 20 68 65 78 64 75 6d 70 21 0a  |Hello, hexdump!.|");
  assert.equal(dump.split("\n")[1].startsWith("00000010  00 6f 6b"), true);
  const v = new TextEncoder().encode("123456789");                       // the standard CRC check string
  assert.equal(lib.crc32(v), 0xcbf43926);
  assert.equal(lib.adler32(v), 0x091e01de);
  const c16 = n => lib.crc16(v, lib.CRC16[n]);
  assert.equal(c16("CRC-16/CCITT-FALSE"), 0x29b1);
  assert.equal(c16("CRC-16/XMODEM"), 0x31c3);
  assert.equal(c16("CRC-16/ARC"), 0xbb3d);
  assert.equal(c16("CRC-16/MODBUS"), 0x4b37);
  assert.equal(c16("CRC-16/KERMIT"), 0x2189);
  assert.equal(lib.crc32(new Uint8Array(0)), 0);
  assert.equal(lib.sum8(Uint8Array.from([200, 100])), 44);
  assert.equal(lib.xor8(Uint8Array.from([0xf0, 0x0f, 0xff])), 0);
});

test("byte interpretation", () => {
  const m = Object.fromEntries(lib.interpret(Uint8Array.from([0x3f, 0x80, 0, 0])));
  assert.equal(m["float32 big-endian"], "1");
  assert.equal(m["uint32 big-endian"], "1065353216");
  assert.equal(m["uint32 little-endian"], "32831");
  const n = Object.fromEntries(lib.interpret(Uint8Array.from([0xff, 0xfe])));
  assert.equal(n["int16 big-endian"], "-2");
  assert.equal(n["uint16 little-endian"], "65279");
  const d = Object.fromEntries(lib.interpret(Uint8Array.from([0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18])));
  assert.ok(Math.abs(+d["float64 big-endian"] - Math.PI) < 1e-12);
  assert.deepEqual(lib.interpret(new Uint8Array(9)), []);
});
