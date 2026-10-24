(function () {
  const lib = DT.lib;

  lib.urlEncode = {
    component: s => encodeURIComponent(s),
    uri: s => encodeURI(s),
    form: s => encodeURIComponent(s).replace(/%20/g, "+"),
  };
  lib.urlDecode = {
    component: s => decodeURIComponent(s),
    uri: s => decodeURI(s),
    form: s => decodeURIComponent(s.replace(/\+/g, " ")),
  };

  lib.parseUrl = function (input) {
    const u = new URL(input);
    const params = [];
    u.searchParams.forEach((v, k) => params.push([k, v]));
    return {
      href: u.href, protocol: u.protocol, username: u.username, password: u.password, host: u.host, hostname: u.hostname,
      port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin, params,
    };
  };

  DT.register({
    id: "url", name: "URL Encode / Decode / Parse", group: "Encode & Decode",
    desc: "Percent-encode and decode text, or break a URL into its parts and decoded query parameters.",
    keywords: "percent encoding query string uri component urlencode parse",
    render(root) {
      root.innerHTML = `
        <div class="two">
          <div class="col"><label class="l" for="in">Text or URL</label><textarea id="in" class="md" spellcheck="false" placeholder="https://example.com/a b?q=hello world&x=1#top"></textarea></div>
          <div class="col"><label class="l" for="out">Result</label><textarea id="out" class="md" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="btns">
          <button class="btn primary" data-m="component" data-d="enc" type="button">encodeURIComponent</button>
          <button class="btn" data-m="component" data-d="dec" type="button">decodeURIComponent</button>
          <button class="btn" data-m="uri" data-d="enc" type="button">encodeURI</button>
          <button class="btn" data-m="uri" data-d="dec" type="button">decodeURI</button>
          <button class="btn" data-m="form" data-d="enc" type="button">Form-encode (+)</button>
          <button class="btn" data-m="form" data-d="dec" type="button">Form-decode</button>
          <button class="btn" data-copy="#out" type="button">Copy result</button>
          <button class="btn" data-clear="#in,#out" type="button">Clear</button>
        </div>
        <div class="status" id="st"></div>
        <div class="panel"><label class="l">Parsed URL</label><div id="parts" class="hint">Paste an absolute URL above to see its parts.</div></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st"), parts = $("#parts");
      root.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
        try {
          out.value = (b.dataset.d === "enc" ? lib.urlEncode : lib.urlDecode)[b.dataset.m](inp.value);
          DT.status(st, "ok", `${b.textContent}`);
        } catch (e) { out.value = ""; DT.status(st, "err", e.message.includes("URI") ? "Malformed percent-encoding in the input." : e.message); }
      });
      function parse() {
        const v = inp.value.trim();
        if (!v) { parts.innerHTML = '<span class="hint">Paste an absolute URL above to see its parts.</span>'; return; }
        try {
          const p = lib.parseUrl(v);
          const rows = [["protocol", p.protocol], ["host", p.host], ["hostname", p.hostname], ["port", p.port || "(default)"], ["path", p.pathname], ["query", p.search || "(none)"], ["fragment", p.hash || "(none)"], ["origin", p.origin]];
          if (p.username) rows.splice(1, 0, ["username", p.username], ["password", p.password]);
          parts.innerHTML = DT.kv(rows) + (p.params.length ? `<div class="lbl" style="margin:14px 0 4px">Query parameters (decoded)</div>` + DT.kv(p.params.map(([k, x]) => [k, x])) : "");
        } catch (_) { parts.innerHTML = '<span class="hint">Not an absolute URL (include the scheme, e.g. https://).</span>'; }
      }
      inp.addEventListener("input", DT.debounce(parse, 150));
    },
  });
})();
