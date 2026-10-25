(function () {
  const lib = DT.lib;

  /* Quote one argument for a POSIX shell: leave simple words alone, otherwise single-quote and escape embedded quotes. */
  lib.shQuote = s => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'");

  /* req: { method, url, headers: [[name, value]], body, auth: { type: "none"|"basic"|"bearer", user, pass, token } } -> a curl command line. */
  lib.buildCurl = function (req) {
    const url = String(req.url || "").trim();
    if (!url) throw new Error("Enter a URL.");
    const method = (req.method || "GET").toUpperCase(), parts = ["curl"];
    const hasBody = req.body != null && req.body !== "";
    if (method !== "GET") parts.push("-X", method);
    for (const [n, v] of req.headers || []) if (n.trim()) parts.push("-H", lib.shQuote(`${n.trim()}: ${v}`));
    const a = req.auth || { type: "none" };
    if (a.type === "bearer" && a.token) parts.push("-H", lib.shQuote("Authorization: Bearer " + a.token));
    if (a.type === "basic" && (a.user || a.pass)) parts.push("-u", lib.shQuote(`${a.user || ""}:${a.pass || ""}`));
    if (hasBody) parts.push("--data-raw", lib.shQuote(req.body));
    parts.push(lib.shQuote(url));
    return parts.join(" ");
  };

  /* "Name: value" lines to [[name, value]]. Lines without a colon are reported rather than silently dropped. */
  lib.parseHeaderLines = function (text) {
    const out = [], bad = [];
    String(text).split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      const k = line.indexOf(":");
      if (k <= 0) { bad.push(i + 1); return; }
      out.push([line.slice(0, k).trim(), line.slice(k + 1).trim()]);
    });
    return { headers: out, bad };
  };

  DT.register({
    id: "httpreq", name: "HTTP Request Builder", group: "Translate",
    desc: "Fill in a request (method, URL, headers, auth, body) and get ready-to-run curl, fetch, Python, PowerShell, Go and C# code. Nothing is sent.",
    keywords: "rest api http client snippet curl fetch requests postman",
    render(root) {
      root.innerHTML = `
        <div class="opts">
          <label>Method <select id="method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>HEAD</option><option>OPTIONS</option></select></label>
          <label style="flex:1">URL <input type="text" id="url" class="mono" style="width:100%" placeholder="https://api.example.com/items?limit=10"></label>
        </div>
        <div class="two">
          <div class="col"><label class="l" for="hdr">Headers (one per line)</label><textarea id="hdr" class="md" spellcheck="false" placeholder="Accept: application/json"></textarea></div>
          <div class="col"><label class="l" for="body">Body</label><textarea id="body" class="md" spellcheck="false" placeholder='{"name":"Ada"}'></textarea>
            <div class="opts"><button class="mini" id="json" type="button">Content-Type: JSON</button><button class="mini" id="pretty" type="button">Format JSON</button></div></div>
        </div>
        <div class="opts">
          <label>Auth <select id="auth"><option value="none">None</option><option value="basic">Basic</option><option value="bearer">Bearer token</option></select></label>
          <span id="basic" hidden><label>User <input type="text" id="user" class="mono"></label> <label>Password <input type="text" id="pass" class="mono" data-noshare></label></span>
          <span id="bearer" hidden><label>Token <input type="text" id="token" class="mono" data-noshare></label></span>
        </div>
        <div class="status" id="st"></div>
        <div class="opts"><label>Output <select id="lang"><option value="curl">curl</option><option value="fetch">JavaScript (fetch)</option><option value="python">Python (requests)</option><option value="powershell">PowerShell</option><option value="go">Go (net/http)</option><option value="csharp">C# (HttpClient)</option></select></label></div>
        <div class="col"><label class="l" for="out">Code</label><textarea id="out" class="md" spellcheck="false" readonly></textarea></div>
        <div class="btns"><button class="btn" data-copy="#out" type="button">Copy code</button></div>`;
      const $ = s => root.querySelector(s);
      function run() {
        $("#basic").hidden = $("#auth").value !== "basic"; $("#bearer").hidden = $("#auth").value !== "bearer";
        const { headers, bad } = lib.parseHeaderLines($("#hdr").value);
        try {
          const cmd = lib.buildCurl({ method: $("#method").value, url: $("#url").value, headers, body: $("#body").value,
            auth: { type: $("#auth").value, user: $("#user").value, pass: $("#pass").value, token: $("#token").value } });
          $("#out").value = $("#lang").value === "curl" ? cmd : lib.curlTo(cmd, $("#lang").value);
          DT.status($("#st"), bad.length ? "warn" : "ok", bad.length ? `Ignored header line${bad.length > 1 ? "s" : ""} without a colon: ${bad.join(", ")}` : "Ready. This tool only builds code; it never sends the request.");
        } catch (e) { $("#out").value = ""; DT.status($("#st"), $("#url").value ? "err" : "", e.message); }
      }
      root.addEventListener("input", DT.debounce(run, 120)); root.addEventListener("change", run);
      $("#json").onclick = () => {
        const { headers } = lib.parseHeaderLines($("#hdr").value);
        if (!headers.some(h => h[0].toLowerCase() === "content-type")) $("#hdr").value = ($("#hdr").value.trim() ? $("#hdr").value.trim() + "\n" : "") + "Content-Type: application/json";
        run();
      };
      $("#pretty").onclick = () => { try { $("#body").value = JSON.stringify(JSON.parse($("#body").value), null, 2); run(); } catch (e) { DT.status($("#st"), "err", "Body is not valid JSON: " + e.message); } };
      run();
    },
  });
})();
