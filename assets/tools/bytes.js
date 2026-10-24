(function () {
  const lib = DT.lib;

  /* Tolerant byte parsers. fmt: "hex" | "b64" | "text" | "dec" */
  lib.parseBytes = function (text, fmt) {
    if (fmt === "text") return new TextEncoder().encode(text);
    if (fmt === "b64") return lib.b64ToBytes(text);
    if (fmt === "dec") {
      const parts = text.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("Decimal bytes must be integers 0-255.");
      return Uint8Array.from(parts);
    }
    let h = text.replace(/0x/gi, "").replace(/[\s,:;-]+/g, "");
    if (/[^0-9a-f]/i.test(h)) throw new Error("Hex contains a non-hex character.");
    if (h.length % 2) throw new Error(`Odd number of hex digits (${h.length}); every byte needs two.`);
    return Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
  };
  lib.bytesToHex = (b, sep = " ") => Array.from(b, x => x.toString(16).padStart(2, "0")).join(sep);

  lib.hexdump = function (b, width = 16) {
    const lines = [];
    for (let o = 0; o < b.length; o += width) {
      const row = b.subarray(o, o + width);
      const hex = Array.from(row, x => x.toString(16).padStart(2, "0")).join(" ").padEnd(width * 3 - 1);
      lines.push(`${o.toString(16).padStart(8, "0")}  ${hex}  |${Array.from(row, x => x >= 32 && x < 127 ? String.fromCharCode(x) : ".").join("")}|`);
    }
    return lines.join("\n");
  };

  /* ---- Checksums ---- */
  const T32 = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  lib.crc32 = b => { let c = 0xffffffff; for (const x of b) c = T32[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  lib.adler32 = b => { let a = 1, s = 0; for (const x of b) { a = (a + x) % 65521; s = (s + a) % 65521; } return ((s << 16) | a) >>> 0; };
  const rev = (v, bits) => { let r = 0; for (let i = 0; i < bits; i++) if (v & (1 << i)) r |= 1 << (bits - 1 - i); return r >>> 0; };
  lib.crc16 = function (b, { poly, init, refin, refout, xorout }) {
    let crc = init;
    for (let x of b) {
      if (refin) x = rev(x, 8);
      crc ^= x << 8;
      for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
    }
    if (refout) crc = rev(crc, 16);
    return (crc ^ xorout) & 0xffff;
  };
  lib.CRC16 = {
    "CRC-16/CCITT-FALSE": { poly: 0x1021, init: 0xffff, refin: false, refout: false, xorout: 0 },
    "CRC-16/XMODEM": { poly: 0x1021, init: 0, refin: false, refout: false, xorout: 0 },
    "CRC-16/ARC": { poly: 0x8005, init: 0, refin: true, refout: true, xorout: 0 },
    "CRC-16/MODBUS": { poly: 0x8005, init: 0xffff, refin: true, refout: true, xorout: 0 },
    "CRC-16/KERMIT": { poly: 0x1021, init: 0, refin: true, refout: true, xorout: 0 },
  };
  lib.sum8 = b => b.reduce((a, x) => (a + x) & 0xff, 0);
  lib.xor8 = b => b.reduce((a, x) => a ^ x, 0);

  /* How the bytes read as integers and floats (up to 8 bytes). */
  lib.interpret = function (b) {
    const n = b.length, out = [];
    if (!n || n > 8) return out;
    const dv = new DataView(b.buffer, b.byteOffset, n);
    const big = le => { let v = 0n; for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(b[le ? n - 1 - i : i]); return v; };
    for (const [label, le] of [["big-endian", false], ["little-endian", true]]) {
      const u = big(le), s = BigInt.asIntN(n * 8, u);
      out.push([`uint${n * 8} ${label}`, u.toString()], [`int${n * 8} ${label}`, s.toString()]);
      if (n === 4) out.push([`float32 ${label}`, String(dv.getFloat32(0, le))]);
      if (n === 8) out.push([`float64 ${label}`, String(dv.getFloat64(0, le))]);
    }
    return out;
  };

  DT.register({
    id: "bytes", name: "Bytes: Hex, Base64, Checksums", group: "XML & Mission Systems",
    desc: "Paste bytes as hex, Base64, decimal or text and see every representation, a hex dump, integer and float interpretations, and CRC-32, CRC-16, Adler-32 and simple checksums. For debugging binary framing and transport.",
    keywords: "hex dump xxd bytes binary crc crc16 crc32 checksum endian float base64 frame packet",
    render(root) {
      root.innerHTML = `
        <div class="opts"><label>Input is <select id="fmt"><option value="hex">Hex</option><option value="b64">Base64 / Base64URL</option><option value="dec">Decimal bytes</option><option value="text">Text (UTF-8)</option></select></label></div>
        <div class="col"><textarea id="in" class="md" spellcheck="false" placeholder="de ad be ef   or   0xDE,0xAD   or a hex dump"></textarea></div>
        <div class="status" id="st"></div><div id="res"></div>
        <div class="panel"><div class="lbl" style="margin-bottom:6px">Hex dump</div><pre class="out" id="dump" style="max-height:340px"></pre></div>`;
      const $ = s => root.querySelector(s);
      function run() {
        const v = $("#in").value;
        if (!v.trim()) { $("#res").innerHTML = ""; $("#dump").textContent = ""; DT.status($("#st"), "", ""); return; }
        try {
          let text = v;
          if ($("#fmt").value === "hex") text = v.split("\n").map(l => l.replace(/^\s*[0-9a-f]{6,8}\s{2,}/i, "").replace(/\|.*\|\s*$/, "")).join(" ");   // tolerate xxd / hexdump -C output
          const b = lib.parseBytes(text, $("#fmt").value);
          DT.status($("#st"), "ok", `${b.length} byte${b.length === 1 ? "" : "s"}`);
          let asText = "(not valid UTF-8)"; try { asText = new TextDecoder("utf-8", { fatal: true }).decode(b); } catch (_) { /* leave placeholder */ }
          const hx = n => "0x" + n.toString(16).toUpperCase().padStart(n > 0xffff ? 8 : 4, "0");
          const rows = [["Hex", lib.bytesToHex(b)], ["Hex (0x, comma)", Array.from(b, x => "0x" + x.toString(16).padStart(2, "0")).join(", ")], ["Base64", lib.bytesToB64(b)], ["Base64URL", lib.bytesToB64(b, true, false)], ["Decimal", Array.from(b).join(" ")], ["UTF-8 text", asText]];
          const sums = [["CRC-32", hx(lib.crc32(b))], ["Adler-32", hx(lib.adler32(b))], ...Object.entries(lib.CRC16).map(([k, p]) => [k, hx(lib.crc16(b, p))]), ["Sum-8", "0x" + lib.sum8(b).toString(16).toUpperCase().padStart(2, "0")], ["XOR-8", "0x" + lib.xor8(b).toString(16).toUpperCase().padStart(2, "0")]];
          const it = lib.interpret(b);
          $("#res").innerHTML = DT.kv(rows) + `<div class="lbl" style="margin:16px 0 4px">Checksums</div>` + DT.kv(sums) + (it.length ? `<div class="lbl" style="margin:16px 0 4px">As numbers</div>` + DT.kv(it) : "");
          $("#dump").textContent = lib.hexdump(b);
        } catch (e) { $("#res").innerHTML = ""; $("#dump").textContent = ""; DT.status($("#st"), "err", e.message); }
      }
      $("#in").addEventListener("input", DT.debounce(run, 150)); $("#fmt").onchange = run;
    },
  });
})();
