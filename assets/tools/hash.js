(function () {
  const lib = DT.lib;

  /* MD5 (RFC 1321) over a Uint8Array, returns lowercase hex. WebCrypto does not offer MD5. */
  lib.md5 = function (bytes) {
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const len = bytes.length, total = (((len + 8) >>> 6) + 1) * 64;
    const buf = new Uint8Array(total); buf.set(bytes); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, (len << 3) >>> 0, true);
    dv.setUint32(total - 4, Math.floor(len / 0x20000000), true);
    for (let off = 0; off < total; off += 64) {
      const M = new Uint32Array(16);
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
    return Array.from(new Uint8Array(out.buffer), b => b.toString(16).padStart(2, "0")).join("");
  };

  const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
  const SHA = { "SHA-1": "SHA-1", "SHA-256": "SHA-256", "SHA-384": "SHA-384", "SHA-512": "SHA-512" };

  lib.digest = async function (algo, bytes) {
    if (algo === "MD5") return lib.md5(bytes);
    return hex(await crypto.subtle.digest(SHA[algo], bytes));
  };
  lib.hmac = async function (algo, keyBytes, msgBytes) {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: SHA[algo] }, false, ["sign"]);
    return hex(await crypto.subtle.sign("HMAC", key, msgBytes));
  };
  lib.hexToB64 = h => lib.bytesToB64(Uint8Array.from(h.match(/../g), x => parseInt(x, 16)));

  DT.register({
    id: "hash", name: "Hash & HMAC", group: "Network & Security",
    desc: "MD5, SHA-1, SHA-256, SHA-384 and SHA-512 of text or a file, plus HMAC. Paste an expected checksum to see which algorithm matches.",
    keywords: "md5 sha1 sha256 sha512 checksum digest hmac verify integrity",
    render(root) {
      root.innerHTML = `
        <div class="two">
          <div class="col"><label class="l" for="in">Text</label><textarea id="in" class="md" spellcheck="false" placeholder="Text to hash (UTF-8)"></textarea></div>
          <div class="col"><label class="l" for="file">…or a file</label><input type="file" id="file"><div class="hint" id="fi"></div>
            <label class="l" for="key" style="margin-top:8px">HMAC key (optional)</label><input type="text" id="key" class="mono" placeholder="leave empty for plain hashes"></div>
        </div>
        <div class="opts"><label><input type="checkbox" id="upper"> Uppercase hex</label><label><input type="checkbox" id="b64"> Base64 instead of hex</label></div>
        <div class="panel"><div id="res"></div></div>
        <div class="col"><label class="l" for="cmp">Compare with expected checksum</label><input type="text" id="cmp" class="mono" placeholder="paste a hex digest"><div class="status" id="cst"></div></div>`;
      const $ = s => root.querySelector(s);
      let fileBytes = null, results = {};
      async function run() {
        const bytes = fileBytes || new TextEncoder().encode($("#in").value);
        const key = $("#key").value, algos = ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512"];
        results = {};
        for (const a of algos) {
          if (key && a === "MD5") continue;
          results[a] = key ? await lib.hmac(a, new TextEncoder().encode(key), bytes) : await lib.digest(a, bytes);
        }
        render();
      }
      function show(h) { if ($("#b64").checked) return lib.hexToB64(h); return $("#upper").checked ? h.toUpperCase() : h; }
      function render() {
        const key = $("#key").value;
        $("#res").innerHTML = DT.kv(Object.entries(results).map(([a, h]) => [key ? "HMAC-" + a : a, show(h)]));
        compare();
      }
      function compare() {
        const c = $("#cmp").value.trim().replace(/\s+/g, "").toLowerCase();
        if (!c) return DT.status($("#cst"), "", "");
        const hit = Object.entries(results).find(([, h]) => h === c || lib.hexToB64(h).toLowerCase() === c);
        DT.status($("#cst"), hit ? "ok" : "err", hit ? `Match: ${hit[0]}` : "No algorithm produces this value for the current input.");
      }
      const live = DT.debounce(run, 150);
      $("#in").addEventListener("input", () => { fileBytes = null; $("#fi").textContent = ""; live(); });
      $("#key").addEventListener("input", live);
      $("#upper").onchange = $("#b64").onchange = render;
      $("#cmp").addEventListener("input", compare);
      $("#file").onchange = e => {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => { fileBytes = new Uint8Array(r.result); $("#fi").textContent = `${f.name} · ${f.size.toLocaleString()} bytes (text box ignored)`; run(); };
        r.readAsArrayBuffer(f);
      };
      run();
    },
  });
})();
