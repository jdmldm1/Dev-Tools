(function () {
  const lib = DT.lib;

  /* Parse an integer in the given base (2-36) into a BigInt. Accepts 0x/0b/0o prefixes, _ and spaces, and a leading minus. */
  lib.parseBig = function (text, base) {
    let s = String(text).trim().replace(/[_\s]/g, "").toLowerCase();
    if (!s) throw new Error("empty");
    let neg = false;
    if (s[0] === "-") { neg = true; s = s.slice(1); } else if (s[0] === "+") s = s.slice(1);
    const pre = { "0x": 16, "0b": 2, "0o": 8 };
    if (pre[s.slice(0, 2)] && base === pre[s.slice(0, 2)]) s = s.slice(2);
    const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, base);
    let v = 0n; const B = BigInt(base);
    for (const ch of s) {
      const d = digits.indexOf(ch);
      if (d < 0) throw new Error(`"${ch}" is not a base-${base} digit`);
      v = v * B + BigInt(d);
    }
    return neg ? -v : v;
  };
  lib.toBase = (v, base) => v.toString(base);
  lib.twosComplement = function (v, bits) {
    const mod = 1n << BigInt(bits), lo = -(mod >> 1n), hi = (mod >> 1n) - 1n;
    if (v < lo || v >= mod) return null;                 // does not fit
    const u = v < 0n ? v + mod : v;
    const signed = u > hi ? u - mod : u;
    return { unsigned: u, signed, hex: u.toString(16).padStart(bits / 4, "0"), bin: u.toString(2).padStart(bits, "0") };
  };

  lib.formatBytes = function (n) {
    const dec = ["B", "KB", "MB", "GB", "TB", "PB"], bin = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    const f = (x, base, units) => { let i = 0; while (Math.abs(x) >= base && i < units.length - 1) { x /= base; i++; } return `${+x.toFixed(2)} ${units[i]}`; };
    return { decimal: f(n, 1000, dec), binary: f(n, 1024, bin) };
  };
  const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, PiB: 1024 ** 5 };
  lib.byteUnits = UNITS;

  DT.register({
    id: "numbers", name: "Number Bases & Bits", group: "Time & Numbers",
    desc: "Convert between binary, octal, decimal and hexadecimal (arbitrary size), see two's complement for common widths, flip bits, and convert data sizes.",
    keywords: "binary hex octal decimal bitwise twos complement integer bytes kb kib mb size converter",
    render(root) {
      root.innerHTML = `
        <div class="two">
          <div class="col"><label class="l" for="dec">Decimal</label><input type="text" id="dec" class="mono" spellcheck="false" value="255"></div>
          <div class="col"><label class="l" for="hex">Hexadecimal</label><input type="text" id="hex" class="mono" spellcheck="false"></div>
          <div class="col"><label class="l" for="bin">Binary</label><input type="text" id="bin" class="mono" spellcheck="false"></div>
          <div class="col"><label class="l" for="oct">Octal</label><input type="text" id="oct" class="mono" spellcheck="false"></div>
        </div>
        <div class="status" id="st"></div>
        <div class="panel"><div class="opts"><span class="lbl">Bits</span> <label>Width <select id="w"><option>8</option><option>16</option><option selected>32</option><option>64</option></select></label><span class="hint">click a bit to flip it</span></div>
          <div class="bits" id="bits"></div><div id="tc" style="margin-top:12px"></div></div>
        <div class="panel"><div class="lbl" style="margin-bottom:8px">Data size</div>
          <div class="opts"><input type="number" id="sz" value="1.5" step="any" class="mono" style="width:140px"><select id="su" class="mono">${Object.keys(UNITS).map(u => `<option ${u === "GiB" ? "selected" : ""}>${u}</option>`).join("")}</select></div><div id="szo"></div></div>`;
      const $ = s => root.querySelector(s);
      const bases = { dec: 10, hex: 16, bin: 2, oct: 8 };
      let value = 255n;
      function paint(skip) {
        for (const [id, b] of Object.entries(bases)) if (id !== skip) $("#" + id).value = lib.toBase(value, b);
        const w = +$("#w").value, tc = lib.twosComplement(value, w);
        const bitsEl = $("#bits");
        if (!tc) { bitsEl.innerHTML = ""; $("#tc").innerHTML = `<span class="hint">Value does not fit in ${w} bits.</span>`; return; }
        bitsEl.innerHTML = [...tc.bin].map((c, i) => `<span class="${c === "1" ? "on" : ""}" data-i="${w - 1 - i}">${c}</span>`).join("");
        $("#tc").innerHTML = DT.kv([[`Unsigned ${w}-bit`, tc.unsigned.toString()], [`Signed (two's complement)`, tc.signed.toString()], ["Hex", "0x" + tc.hex], ["Binary", tc.bin.replace(/(.{4})(?=.)/g, "$1 ")]]);
      }
      function from(id) {
        try { value = lib.parseBig($("#" + id).value, bases[id]); DT.status($("#st"), "", ""); paint(id); }
        catch (e) { if (e.message !== "empty") DT.status($("#st"), "err", e.message); }
      }
      for (const id of Object.keys(bases)) $("#" + id).addEventListener("input", () => from(id));
      $("#w").onchange = () => paint();
      $("#bits").addEventListener("click", e => {
        const s = e.target.closest("span"); if (!s) return;
        const w = +$("#w").value, tc = lib.twosComplement(value, w); if (!tc) return;
        value = tc.unsigned ^ (1n << BigInt(s.dataset.i)); paint();
      });
      function size() {
        const n = parseFloat($("#sz").value);
        if (!isFinite(n)) { $("#szo").innerHTML = ""; return; }
        const bytes = n * UNITS[$("#su").value];
        $("#szo").innerHTML = DT.kv(Object.keys(UNITS).map(u => [u, String(+(bytes / UNITS[u]).toPrecision(8))]));
      }
      $("#sz").addEventListener("input", size); $("#su").onchange = size;
      paint(); size();
    },
  });
})();
