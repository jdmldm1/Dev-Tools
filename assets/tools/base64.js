(function () {
  const lib = DT.lib;

  lib.bytesToB64 = function (bytes, urlSafe = false, pad = true) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    let s = btoa(bin);
    if (urlSafe) s = s.replace(/\+/g, "-").replace(/\//g, "_");
    return pad ? s : s.replace(/=+$/, "");
  };
  lib.b64ToBytes = function (str) {
    let s = String(str).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error("Not valid Base64: contains characters outside A-Z a-z 0-9 + / = (and - _ for URL-safe).");
    s = s.replace(/=+$/, "");
    if (s.length % 4 === 1) throw new Error("Not valid Base64: length is impossible (1 extra character).");
    s += "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  lib.b64encode = (text, urlSafe, pad) => lib.bytesToB64(new TextEncoder().encode(text), urlSafe, pad);
  lib.b64decode = text => new TextDecoder("utf-8", { fatal: true }).decode(lib.b64ToBytes(text));

  DT.register({
    id: "base64", name: "Base64", group: "Encode & Decode",
    desc: "Encode and decode Base64 with UTF-8 handling, URL-safe alphabet and optional padding. Also turns a file into Base64 or a data: URI.",
    keywords: "b64 base64url data uri file basic auth",
    render(root) {
      root.innerHTML = `
        <div class="opts">
          <label><input type="checkbox" id="url"> URL-safe (- _ instead of + /)</label>
          <label><input type="checkbox" id="nopad"> Omit padding (=)</label>
          <label><input type="checkbox" id="wrap"> Wrap at 76 columns</label>
        </div>
        <div class="two">
          <div class="col"><label class="l" for="in">Input</label><textarea id="in" spellcheck="false" placeholder="Text to encode, or Base64 to decode"></textarea></div>
          <div class="col"><label class="l" for="out">Output</label><textarea id="out" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="btns">
          <button class="btn primary" id="enc" type="button">Encode →</button>
          <button class="btn primary" id="dec" type="button">← Decode</button>
          <button class="btn" id="swap" type="button">Output → Input</button>
          <button class="btn" data-copy="#out" type="button">Copy output</button>
          <button class="btn" data-clear="#in,#out" type="button">Clear</button>
        </div>
        <div class="status" id="st"></div>
        <div class="panel"><label class="l" for="file">File → Base64</label>
          <div class="opts"><input type="file" id="file"><label><input type="checkbox" id="datauri" checked> as data: URI</label></div></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st");
      const wrap = s => $("#wrap").checked ? s.replace(/(.{76})/g, "$1\n") : s;
      $("#enc").onclick = () => { out.value = wrap(lib.b64encode(inp.value, $("#url").checked, !$("#nopad").checked)); DT.status(st, "ok", `Encoded ${new TextEncoder().encode(inp.value).length} bytes`); };
      $("#dec").onclick = () => {
        try { out.value = lib.b64decode(inp.value); DT.status(st, "ok", "Decoded as UTF-8 text"); }
        catch (e) {
          if (e instanceof TypeError || /utf/i.test(e.message)) {
            try { const b = lib.b64ToBytes(inp.value); out.value = Array.from(b, x => x.toString(16).padStart(2, "0")).join(" "); DT.status(st, "warn", "Not valid UTF-8 text; showing raw bytes as hex"); }
            catch (e2) { out.value = ""; DT.status(st, "err", e2.message); }
          } else { out.value = ""; DT.status(st, "err", e.message); }
        }
      };
      $("#swap").onclick = () => { inp.value = out.value; };
      $("#file").onchange = e => {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          const b64 = lib.bytesToB64(new Uint8Array(r.result), $("#url").checked, !$("#nopad").checked);
          out.value = $("#datauri").checked ? `data:${f.type || "application/octet-stream"};base64,${b64}` : wrap(b64);
          DT.status(st, "ok", `${f.name} · ${f.size.toLocaleString()} bytes → ${out.value.length.toLocaleString()} characters`);
        };
        r.readAsArrayBuffer(f);
      };
    },
  });
})();
