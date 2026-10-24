(function () {
  const lib = DT.lib;

  const decodePart = p => JSON.parse(new TextDecoder().decode(lib.b64ToBytes(p)));

  lib.jwtDecode = function (token) {
    const parts = token.trim().replace(/^Bearer\s+/i, "").split(".");
    if (parts.length !== 3) throw new Error(`A JWT has 3 dot-separated parts; found ${parts.length}.`);
    let header, payload;
    try { header = decodePart(parts[0]); } catch (e) { throw new Error("Header is not valid Base64URL JSON."); }
    try { payload = decodePart(parts[1]); } catch (e) { throw new Error("Payload is not valid Base64URL JSON."); }
    return { header, payload, signature: parts[2], signingInput: parts[0] + "." + parts[1] };
  };

  const HMAC = { HS256: "SHA-256", HS384: "SHA-384", HS512: "SHA-512" };
  lib.jwtVerifyHS = async function (token, secretBytes) {
    const { header, signature, signingInput } = lib.jwtDecode(token);
    const hash = HMAC[header.alg];
    if (!hash) throw new Error(`Only HS256/HS384/HS512 can be checked here (token uses ${header.alg}).`);
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
    return lib.bytesToB64(sig, true, false) === signature;
  };

  lib.relTime = function (ms) {
    const abs = Math.abs(ms), u = [["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1e3]];
    for (const [n, v] of u) if (abs >= v) { const c = Math.floor(abs / v); return `${c} ${n}${c > 1 ? "s" : ""} ${ms < 0 ? "ago" : "from now"}`; }
    return "now";
  };

  DT.register({
    id: "jwt", name: "JWT Decoder", group: "Network & Security",
    desc: "Decode a JSON Web Token's header and payload, read the time claims, and verify HMAC (HS256/384/512) signatures. Everything runs locally in your browser.",
    keywords: "json web token bearer auth claims exp verify hmac",
    render(root) {
      root.innerHTML = `
        <div class="col"><label class="l" for="in">Token</label><textarea id="in" class="md" spellcheck="false" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."></textarea></div>
        <div class="status" id="st"></div>
        <div class="two">
          <div class="col"><label class="l">Header</label><pre class="out" id="hdr"></pre></div>
          <div class="col"><label class="l">Payload</label><pre class="out" id="pay"></pre></div>
        </div>
        <div class="panel"><label class="l">Time claims</label><div id="claims" class="hint">—</div></div>
        <div class="panel">
          <label class="l" for="secret">Verify HMAC signature</label>
          <div class="opts"><input type="text" id="secret" class="mono" placeholder="shared secret" style="max-width:420px"><label><input type="checkbox" id="b64"> secret is Base64URL</label><button class="btn" id="vfy" type="button">Verify</button></div>
          <div class="status" id="vst"></div>
        </div>
        <p class="hint">Decoding is not verification: never trust claims you have not verified with the right key. RS256/ES256 tokens need the issuer's public key and are not checked here.</p>`;
      const $ = s => root.querySelector(s), st = $("#st");
      let current = null;
      function run() {
        const v = $("#in").value;
        $("#hdr").textContent = $("#pay").textContent = ""; $("#claims").innerHTML = "—"; DT.status($("#vst"), "", "");
        current = null;
        if (!v.trim()) { DT.status(st, "", ""); return; }
        try {
          const t = lib.jwtDecode(v); current = t;
          $("#hdr").textContent = JSON.stringify(t.header, null, 2);
          $("#pay").textContent = JSON.stringify(t.payload, null, 2);
          const now = Date.now(), rows = [];
          for (const [k, label] of [["iat", "Issued at"], ["nbf", "Not before"], ["exp", "Expires"]]) {
            const c = t.payload[k];
            if (typeof c === "number") rows.push([`${k} · ${label}`, `${new Date(c * 1000).toISOString()}  (${lib.relTime(c * 1000 - now)})`]);
          }
          if (rows.length) $("#claims").innerHTML = DT.kv(rows); else $("#claims").textContent = "No iat / nbf / exp claims.";
          const exp = t.payload.exp;
          if (typeof exp === "number") DT.status(st, exp * 1000 < now ? "err" : "ok", exp * 1000 < now ? "Expired · " + lib.relTime(exp * 1000 - now) : "Not expired · " + lib.relTime(exp * 1000 - now));
          else DT.status(st, "warn", "Decoded · no exp claim");
        } catch (e) { DT.status(st, "err", e.message); }
      }
      $("#in").addEventListener("input", DT.debounce(run, 150));
      $("#vfy").onclick = async () => {
        const vst = $("#vst");
        if (!current) return DT.status(vst, "err", "Paste a valid token first.");
        try {
          const secret = $("#secret").value;
          const bytes = $("#b64").checked ? lib.b64ToBytes(secret) : new TextEncoder().encode(secret);
          const ok = await lib.jwtVerifyHS($("#in").value.trim().replace(/^Bearer\s+/i, ""), bytes);
          DT.status(vst, ok ? "ok" : "err", ok ? "Signature is valid for this secret." : "Signature does NOT match this secret.");
        } catch (e) { DT.status(vst, "err", e.message); }
      };
    },
  });
})();
