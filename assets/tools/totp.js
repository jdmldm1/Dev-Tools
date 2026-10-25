(function () {
  const lib = DT.lib, B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  lib.base32Decode = function (s) {
    s = String(s).toUpperCase().replace(/[\s=-]+/g, "");
    let bits = 0, val = 0; const out = [];
    for (const ch of s) {
      const i = B32.indexOf(ch);
      if (i < 0) throw new Error(`Not Base32: "${ch}" (the alphabet is A-Z and 2-7).`);
      val = ((val << 5) | i) & 0xFFFF; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Uint8Array.from(out);
  };

  /* RFC 4226 HOTP: HMAC of the 8-byte counter, dynamic truncation, N digits. algo is a WebCrypto hash name. */
  lib.hotp = async function (key, counter, digits = 6, algo = "SHA-1") {
    const buf = new ArrayBuffer(8), dv = new DataView(buf);
    dv.setUint32(0, Math.floor(counter / 4294967296)); dv.setUint32(4, counter >>> 0);
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: algo }, false, ["sign"]);
    const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, buf)), o = h[h.length - 1] & 15;
    const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(bin % 10 ** digits).padStart(digits, "0");
  };
  /* RFC 6238 TOTP: HOTP with counter = floor(unix seconds / period). */
  lib.totp = (key, timeMs, period = 30, digits = 6, algo = "SHA-1") => lib.hotp(key, Math.floor(timeMs / 1000 / period), digits, algo);

  /* otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30 */
  lib.parseOtpauth = function (uri) {
    const u = new URL(String(uri).trim());
    if (u.protocol !== "otpauth:") throw new Error("Not an otpauth:// URI.");
    const p = u.searchParams, label = decodeURIComponent(u.pathname.replace(/^\/+/, "")), i = label.indexOf(":");
    const algo = (p.get("algorithm") || "SHA1").toUpperCase().replace(/^SHA(\d)/, "SHA-$1");
    return {
      type: u.hostname, secret: p.get("secret") || "", issuer: p.get("issuer") || (i > 0 ? label.slice(0, i) : ""),
      account: i > 0 ? label.slice(i + 1).trim() : label, algo, digits: +(p.get("digits") || 6), period: +(p.get("period") || 30), counter: +(p.get("counter") || 0),
    };
  };

  DT.register({
    id: "totp", name: "TOTP / 2FA Code", group: "Network & Security",
    desc: "Generate the current one-time code from a Base32 secret (or an otpauth:// URI), with a live countdown. Useful for testing 2FA setups. Computed locally; nothing is sent.",
    keywords: "otp hotp 2fa mfa authenticator google authenticator rfc6238 otpauth",
    render(root) {
      root.innerHTML = `
        <div class="col"><label class="l" for="secret">Secret (Base32) or otpauth:// URI</label><input type="text" id="secret" class="mono" data-noshare autocomplete="off" spellcheck="false" placeholder="JBSWY3DPEHPK3PXP"></div>
        <div class="opts">
          <label>Digits <select id="digits"><option>6</option><option>7</option><option>8</option></select></label>
          <label>Period (s) <input type="number" id="period" value="30" min="1" max="300" style="width:70px"></label>
          <label>Algorithm <select id="algo"><option value="SHA-1">SHA-1</option><option value="SHA-256">SHA-256</option><option value="SHA-512">SHA-512</option></select></label>
        </div>
        <div class="status" id="st"></div>
        <div class="panel" style="text-align:center"><div id="code" style="font:700 44px var(--mono);letter-spacing:.12em">------</div>
          <div class="hint" id="left"></div><div class="hint" id="next"></div></div>
        <div class="btns"><button class="btn" data-copy="#code" type="button">Copy code</button></div>
        <div class="hint">Time-based codes need an accurate clock. This uses your device time (${new Date().toTimeString().slice(0, 8)} now). The secret is deliberately left out of share links.</div>`;
      const $ = s => root.querySelector(s);
      let timer = null;
      async function tick() {
        const raw = $("#secret").value.trim();
        if (!raw) { $("#code").textContent = "------"; $("#left").textContent = ""; $("#next").textContent = ""; DT.status($("#st"), "", ""); return; }
        try {
          if (/^otpauth:/i.test(raw)) {
            const o = lib.parseOtpauth(raw);
            if (o.type !== "totp") throw new Error("Only totp URIs are supported here.");
            $("#digits").value = String(o.digits); $("#period").value = o.period; $("#algo").value = o.algo;
            $("#secret").value = o.secret;
            DT.status($("#st"), "ok", `${o.issuer ? o.issuer + " · " : ""}${o.account}`);
            return tick();
          }
          const key = lib.base32Decode(raw), period = Math.max(1, +$("#period").value || 30), digits = +$("#digits").value, now = Date.now();
          const code = await lib.totp(key, now, period, digits, $("#algo").value), nextCode = await lib.totp(key, now + period * 1000, period, digits, $("#algo").value);
          $("#code").textContent = code;
          const left = period - (Math.floor(now / 1000) % period);
          $("#left").textContent = `Expires in ${left}s`; $("#next").textContent = `Next: ${nextCode}`;
          if (!$("#st").classList.contains("ok") || /^Secret/.test($("#st").textContent)) DT.status($("#st"), "ok", `Secret OK (${key.length} bytes)`);
        } catch (e) { $("#code").textContent = "------"; $("#left").textContent = ""; $("#next").textContent = ""; DT.status($("#st"), "err", e.message); }
      }
      root.addEventListener("input", tick); root.addEventListener("change", tick);
      timer = setInterval(tick, 1000); tick();
      return () => clearInterval(timer);
    },
  });
})();
