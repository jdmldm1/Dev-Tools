(function () {
  const lib = DT.lib;

  /* QR Code encoder (ISO/IEC 18004), byte mode, versions 1-40, error correction L/M/Q/H.
     lib.qrEncode(text, { ecc: "M", minVersion, mask }) -> { version, size, mask, modules: boolean[][] } (true = dark). */
  const ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };
  const NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };
  const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  const rawModules = v => {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  };
  const dataCodewords = (v, ecc) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[ecc][v] * NUM_BLOCKS[ecc][v];
  lib.qrCapacity = (v, ecc) => { const cc = v < 10 ? 8 : 16; return Math.floor((dataCodewords(v, ecc) * 8 - 4 - cc) / 8); };   // bytes

  function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
  function rsDivisor(degree) {
    const r = new Array(degree).fill(0); r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) { r[j] = gfMul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; }
      root = gfMul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, divisor) {
    const r = new Array(divisor.length).fill(0);
    for (const b of data) {
      const factor = b ^ r.shift(); r.push(0);
      divisor.forEach((c, i) => { r[i] ^= gfMul(c, factor); });
    }
    return r;
  }
  function addEccAndInterleave(data, v, ecc) {
    const nb = NUM_BLOCKS[ecc][v], eccLen = ECC_PER_BLOCK[ecc][v], raw = Math.floor(rawModules(v) / 8);
    const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(eccLen), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length;
      const e = rsRemainder(dat, div);
      if (i < nShort) dat.push(0);
      blocks.push(dat.concat(e));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]); });
    return out;
  }

  function alignPositions(v) {
    if (v === 1) return [];
    const n = Math.floor(v / 7) + 2, size = v * 4 + 17, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, r = [6];
    for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
    return r;
  }

  function penalty(m, size) {
    let total = 0;
    const runs = line => {                          // rules 1 and 3 on one row or column
      let score = 0, run = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === line[i - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      const s = line.map(b => (b ? "1" : "0")).join("");
      for (const pat of ["10111010000", "00001011101"]) for (let i = s.indexOf(pat); i >= 0; i = s.indexOf(pat, i + 1)) score += 40;
      return score;
    };
    for (let y = 0; y < size; y++) total += runs(m[y]);
    for (let x = 0; x < size; x++) total += runs(m.map(r => r[x]));
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) total += 3;
    let dark = 0; for (const r of m) for (const b of r) if (b) dark++;
    total += Math.floor(Math.abs(dark * 20 - size * size * 10 + size * size - 1) / (size * size)) * 10;   // rule 4
    return total;
  }

  lib.qrEncode = function (text, opts = {}) {
    const ecc = opts.ecc || "M", bytes = Array.from(new TextEncoder().encode(String(text)));
    if (!ECC_PER_BLOCK[ecc]) throw new Error("Error correction must be L, M, Q or H.");
    let ver = opts.minVersion || 1;
    for (; ver <= 40; ver++) if (bytes.length <= lib.qrCapacity(ver, ecc)) break;
    if (ver > 40) throw new Error(`Too long for a QR code at level ${ecc}: ${bytes.length} bytes (the maximum is ${lib.qrCapacity(40, ecc)}).`);
    const size = ver * 4 + 17;

    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
    const cap = dataCodewords(ver, ecc) * 8;
    put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    const codewords = addEccAndInterleave(data, ver, ecc);

    const modules = Array.from({ length: size }, () => new Array(size).fill(false)), isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = alignPositions(ver);
    al.forEach((ay, i) => al.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = mask => {
      const d = (FORMAT_BITS[ecc] << 3) | mask; let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const f = ((d << 10) | rem) ^ 0x5412, bit = i => ((f >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
      setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
      setFn(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const v = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) { const c = ((v >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3); setFn(a, b, c); setFn(b, a, c); }
    }
    for (let i = 0, right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!isFn[y][x] && i < codewords.length * 8) { modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
    }
    const applyMask = mask => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const inv = [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          x * y % 2 + x * y % 3 === 0, (x * y % 2 + x * y % 3) % 2 === 0, ((x + y) % 2 + x * y % 3) % 2 === 0][mask];
        if (!isFn[y][x] && inv) modules[y][x] = !modules[y][x];
      }
    };
    let mask = opts.mask;
    if (mask == null) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m); drawFormat(m);
        const p = penalty(modules, size);
        if (p < best) { best = p; mask = m; }
        applyMask(m);                                            // undo (XOR is its own inverse)
      }
    }
    applyMask(mask); drawFormat(mask);
    return { version: ver, size, mask, ecc, modules };
  };

  lib.qrSvg = function (qr, { scale = 8, quiet = 4, dark = "#000000", light = "#ffffff" } = {}) {
    const n = qr.size + quiet * 2;
    let d = "";
    qr.modules.forEach((row, y) => { for (let x = 0; x < qr.size; x++) if (row[x]) d += `M${x + quiet},${y + quiet}h1v1h-1z`; });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  };

  /* Wi-Fi join string, escaping the characters the format reserves. */
  lib.wifiString = ({ ssid, password, type = "WPA", hidden = false }) => {
    const esc = s => String(s).replace(/([\\;,:"])/g, "\\$1");
    return `WIFI:T:${type};S:${esc(ssid)};${type === "nopass" ? "" : `P:${esc(password)};`}${hidden ? "H:true;" : ""};`;
  };

  DT.register({
    id: "qr", name: "QR Code Generator", group: "Generate",
    desc: "Make a QR code from text, a URL or Wi-Fi details. Runs offline; download as SVG or PNG.",
    keywords: "qrcode barcode wifi url scan",
    render(root) {
      root.innerHTML = `
        <div class="opts">
          <label>Content <select id="kind"><option value="text">Text or URL</option><option value="wifi">Wi-Fi network</option></select></label>
          <label>Error correction <select id="ecc"><option value="L">L (7%)</option><option value="M" selected>M (15%)</option><option value="Q">Q (25%)</option><option value="H">H (30%)</option></select></label>
          <label>Size <select id="scale"><option value="4">small</option><option value="8" selected>medium</option><option value="12">large</option></select></label>
        </div>
        <div id="textrow" class="col"><label class="l" for="in">Text or URL</label><textarea id="in" spellcheck="false" placeholder="https://example.com"></textarea></div>
        <div id="wifirow" class="opts" hidden>
          <label>Network name <input type="text" id="ssid" class="mono"></label>
          <label>Password <input type="text" id="pw" class="mono" data-noshare></label>
          <label>Security <select id="sec"><option value="WPA">WPA/WPA2/WPA3</option><option value="WEP">WEP</option><option value="nopass">None</option></select></label>
          <label><input type="checkbox" id="hid"> Hidden network</label>
        </div>
        <div class="status" id="st"></div>
        <div class="panel" style="text-align:center"><div id="qr" style="display:inline-block;background:#fff;padding:0;line-height:0"></div></div>
        <div class="btns"><button class="btn" id="svg" type="button">Download SVG</button><button class="btn" id="png" type="button">Download PNG</button><button class="btn" id="csvg" type="button">Copy SVG</button></div>`;
      const $ = s => root.querySelector(s);
      let last = null;
      function content() {
        if ($("#kind").value === "wifi") return $("#ssid").value ? lib.wifiString({ ssid: $("#ssid").value, password: $("#pw").value, type: $("#sec").value, hidden: $("#hid").checked }) : "";
        return $("#in").value;
      }
      function draw() {
        $("#textrow").hidden = $("#kind").value === "wifi"; $("#wifirow").hidden = $("#kind").value !== "wifi";
        const text = content();
        if (!text) { $("#qr").innerHTML = ""; last = null; DT.status($("#st"), "", "Type something to generate a code."); return; }
        try {
          const qr = lib.qrEncode(text, { ecc: $("#ecc").value });
          last = qr;
          $("#qr").innerHTML = lib.qrSvg(qr, { scale: +$("#scale").value });
          DT.status($("#st"), "ok", `Version ${qr.version} · ${qr.size}×${qr.size} modules · mask ${qr.mask} · ${new TextEncoder().encode(text).length} bytes`);
        } catch (e) { last = null; $("#qr").innerHTML = ""; DT.status($("#st"), "err", e.message); }
      }
      root.addEventListener("input", DT.debounce(draw, 100)); root.addEventListener("change", draw);
      $("#svg").onclick = () => last && DT.download("qr.svg", lib.qrSvg(last), "image/svg+xml");
      $("#csvg").onclick = e => last && DT.copy(lib.qrSvg(last), e.currentTarget);
      $("#png").onclick = () => {
        if (!last) return;
        const px = 16, n = (last.size + 8) * px, c = document.createElement("canvas"); c.width = c.height = n;
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, n, n); g.fillStyle = "#000";
        last.modules.forEach((row, y) => row.forEach((b, x) => { if (b) g.fillRect((x + 4) * px, (y + 4) * px, px, px); }));
        c.toBlob(b => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "qr.png"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
      };
      draw();
    },
  });
})();
