(function () {
  const lib = DT.lib;
  const rnd = n => crypto.getRandomValues(new Uint8Array(n));

  /* Uniform random integer in [0, max) using rejection sampling (no modulo bias). */
  lib.randInt = function (max) {
    const lim = Math.floor(0x100000000 / max) * max, a = new Uint32Array(1);
    do crypto.getRandomValues(a); while (a[0] >= lim);
    return a[0] % max;
  };
  lib.randomString = (alphabet, len) => Array.from({ length: len }, () => alphabet[lib.randInt(alphabet.length)]).join("");

  const h = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  lib.uuid4 = () => { const b = rnd(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const s = h(b); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`; };
  lib.uuid7 = (now = Date.now()) => {
    const b = rnd(16);
    b[0] = (now / 2 ** 40) & 0xff; b[1] = (now / 2 ** 32) & 0xff; b[2] = (now / 2 ** 24) & 0xff; b[3] = (now / 2 ** 16) & 0xff; b[4] = (now / 2 ** 8) & 0xff; b[5] = now & 0xff;
    b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
    const s = h(b); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  lib.ulid = (now = Date.now()) => {
    let t = "", n = now;
    for (let i = 0; i < 10; i++) { t = CROCKFORD[n % 32] + t; n = Math.floor(n / 32); }
    return t + lib.randomString(CROCKFORD, 16);
  };

  const SETS = { lower: "abcdefghijklmnopqrstuvwxyz", upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", digits: "0123456789", symbols: "!@#$%^&*()-_=+[]{};:,.<>?/~" };
  const AMBIG = /[Il1O0o|`'"]/g;
  lib.password = function ({ length = 20, lower = true, upper = true, digits = true, symbols = true, noAmbiguous = false } = {}) {
    const sets = Object.entries({ lower, upper, digits, symbols }).filter(([, on]) => on).map(([k]) => noAmbiguous ? SETS[k].replace(AMBIG, "") : SETS[k]);
    if (!sets.length) throw new Error("Select at least one character set.");
    if (length < sets.length) throw new Error(`Length must be at least ${sets.length}.`);
    const all = sets.join("");
    const chars = sets.map(s => s[lib.randInt(s.length)]);          // one from each chosen set
    while (chars.length < length) chars.push(all[lib.randInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) { const j = lib.randInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }  // Fisher-Yates
    return { value: chars.join(""), bits: Math.round(length * Math.log2(all.length)) };
  };

  const KINDS = {
    uuid4: { name: "UUID v4 (random)", make: () => crypto.randomUUID ? crypto.randomUUID() : lib.uuid4() },
    uuid7: { name: "UUID v7 (time-ordered)", make: () => lib.uuid7() },
    ulid: { name: "ULID (sortable, 26 chars)", make: () => lib.ulid() },
    nano: { name: "Random string (URL-safe, 21 chars)", make: () => lib.randomString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", 21) },
    hex16: { name: "Random hex (16 bytes)", make: () => h(rnd(16)) },
    hex32: { name: "Random hex (32 bytes) · API key", make: () => h(rnd(32)) },
    b64: { name: "Random Base64URL (32 bytes)", make: () => lib.bytesToB64(rnd(32), true, false) },
  };
  lib.generators = KINDS;

  DT.register({
    id: "generate", name: "UUID, ULID & Password Generator", group: "Generate",
    desc: "Cryptographically random identifiers, keys and passwords from your browser's secure random source. Nothing leaves the page.",
    keywords: "uuid guid ulid nanoid random key token secret password api key",
    render(root) {
      root.innerHTML = `
        <div class="panel">
          <div class="opts"><label>Type <select id="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${DT.esc(v.name)}</option>`).join("")}</select></label>
            <label>Count <input type="number" id="count" value="5" min="1" max="500" style="width:80px"></label>
            <button class="btn primary" id="gen" type="button">Generate</button><button class="btn" data-copy="#out" type="button">Copy all</button></div>
          <textarea id="out" aria-label="Generated values" class="md" readonly spellcheck="false"></textarea>
        </div>
        <div class="panel">
          <div class="lbl" style="margin-bottom:8px">Password</div>
          <div class="opts">
            <label>Length <input type="number" id="len" value="20" min="4" max="256" style="width:80px"></label>
            <label><input type="checkbox" id="pl" checked> a-z</label><label><input type="checkbox" id="pu" checked> A-Z</label>
            <label><input type="checkbox" id="pd" checked> 0-9</label><label><input type="checkbox" id="ps" checked> symbols</label>
            <label><input type="checkbox" id="pa"> avoid look-alikes (Il1O0)</label>
            <button class="btn primary" id="pgen" type="button">Generate</button>
          </div>
          <div class="opts"><input type="text" id="pw" aria-label="Generated password" class="mono" readonly style="max-width:520px"><button class="btn" data-copy="#pw" type="button">Copy</button></div>
          <div class="status" id="pst"></div>
        </div>`;
      const $ = s => root.querySelector(s);
      const gen = () => { const k = KINDS[$("#kind").value], n = Math.min(500, Math.max(1, +$("#count").value || 1)); $("#out").value = Array.from({ length: n }, k.make).join("\n"); };
      const pgen = () => {
        try {
          const r = lib.password({ length: +$("#len").value, lower: $("#pl").checked, upper: $("#pu").checked, digits: $("#pd").checked, symbols: $("#ps").checked, noAmbiguous: $("#pa").checked });
          $("#pw").value = r.value;
          DT.status($("#pst"), r.bits >= 80 ? "ok" : r.bits >= 60 ? "warn" : "err", `≈ ${r.bits} bits of entropy` + (r.bits < 60 ? " (weak)" : r.bits < 80 ? " (fine for most accounts)" : " (strong)"));
        } catch (e) { $("#pw").value = ""; DT.status($("#pst"), "err", e.message); }
      };
      $("#gen").onclick = gen; $("#kind").onchange = gen; $("#pgen").onclick = pgen;
      gen(); pgen();
    },
  });
})();
