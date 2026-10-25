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
  const RSA_HASH = { RS256: "SHA-256", RS384: "SHA-384", RS512: "SHA-512" };
  const EC_PARAMS = {
    ES256: { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" },
    ES384: { name: "ECDSA", namedCurve: "P-384", hash: "SHA-384" },
    ES512: { name: "ECDSA", namedCurve: "P-521", hash: "SHA-512" },
  };

  lib.jwtVerifyHS = async function (token, secretBytes) {
    const { header, signature, signingInput } = lib.jwtDecode(token);
    const hash = HMAC[header.alg];
    if (!hash) throw new Error(`Only HS256/HS384/HS512 can be checked with a secret (token uses ${header.alg}).`);
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
    return lib.bytesToB64(sig, true, false) === signature;
  };

  lib.jwtVerifyPublic = async function (token, keyPem) {
    const { header, signature, signingInput } = lib.jwtDecode(token);
    const alg = header.alg;
    const b64 = keyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    if (!b64) throw new Error("Enter a valid PEM public key (e.g. -----BEGIN PUBLIC KEY-----).");
    const der = lib.b64ToBytes(b64);
    const sigBytes = lib.b64ToBytes(signature);
    const inputBytes = new TextEncoder().encode(signingInput);

    if (RSA_HASH[alg]) {
      const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: RSA_HASH[alg] }, false, ["verify"]);
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, inputBytes);
    }
    if (EC_PARAMS[alg]) {
      const key = await crypto.subtle.importKey("spki", der, EC_PARAMS[alg], false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: EC_PARAMS[alg].hash }, key, sigBytes, inputBytes);
    }
    throw new Error(`Algorithm ${alg} is not supported for public key verification (supported: RS256/384/512, ES256/384/512).`);
  };

  lib.relTime = function (ms) {
    const abs = Math.abs(ms), u = [["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1e3]];
    for (const [n, v] of u) if (abs >= v) { const c = Math.floor(abs / v); return `${c} ${n}${c > 1 ? "s" : ""} ${ms < 0 ? "ago" : "from now"}`; }
    return "now";
  };

  DT.register({
    id: "jwt", name: "JWT Decoder", group: "Network & Security",
    desc: "Decode a JSON Web Token's header and payload, read the time claims, and verify HMAC (HS256/384/512) or Public Key (RS256/384/512, ES256/384/512) signatures. Everything runs locally in your browser.",
    keywords: "json web token bearer auth claims exp verify hmac rsa ecdsa rs256 es256",
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
          <div class="opts" style="margin-top:0">
            <label><input type="radio" name="vmode" id="vm-hmac" value="hmac" checked> HMAC Secret</label>
            <label><input type="radio" name="vmode" id="vm-pk" value="pk"> Public Key (RSA / ECDSA PEM)</label>
          </div>
          <div id="p-hmac" class="opts"><input type="text" id="secret" class="mono" placeholder="shared secret" style="max-width:420px"><label><input type="checkbox" id="b64"> secret is Base64URL</label><button class="btn" id="vfy" type="button">Verify</button></div>
          <div id="p-pk" class="col" hidden style="margin:10px 0">
            <textarea id="pkpem" class="sm mono" placeholder="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----" spellcheck="false"></textarea>
            <div class="btns"><button class="btn" id="vfypk" type="button">Verify Public Key</button></div>
          </div>
          <div class="status" id="vst"></div>
        </div>
        <p class="hint">Decoding is not verification: never trust claims you have not verified with the right key. Signatures are verified locally via browser Web Crypto.</p>`;
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
      $("#vm-hmac").onchange = () => { $("#p-hmac").hidden = false; $("#p-pk").hidden = true; DT.status($("#vst"), "", ""); };
      $("#vm-pk").onchange = () => { $("#p-hmac").hidden = true; $("#p-pk").hidden = false; DT.status($("#vst"), "", ""); };
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
      $("#vfypk").onclick = async () => {
        const vst = $("#vst");
        if (!current) return DT.status(vst, "err", "Paste a valid token first.");
        try {
          const pem = $("#pkpem").value;
          const ok = await lib.jwtVerifyPublic($("#in").value.trim().replace(/^Bearer\s+/i, ""), pem);
          DT.status(vst, ok ? "ok" : "err", ok ? "Signature is valid for this public key." : "Signature does NOT match this public key.");
        } catch (e) { DT.status(vst, "err", e.message); }
      };
    },
  });
})();
