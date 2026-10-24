(function () {
  const lib = DT.lib;

  /* Split a shell-ish command line into tokens: quotes, escapes, line continuations (\ ^ `). */
  lib.shellSplit = function (s) {
    s = s.replace(/\\\r?\n|\^\r?\n|`\r?\n/g, " ");
    const out = []; let cur = "", has = false, i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "'") {
        i++; has = true;
        while (i < s.length && s[i] !== "'") cur += s[i++];
        i++; continue;
      }
      if (c === '"') {
        i++; has = true;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\" && '"\\$`'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; } else cur += s[i++];
        }
        i++; continue;
      }
      if (c === "$" && s[i + 1] === "'") {   // ANSI-C quoting: $'a\nb'
        i += 2; has = true;
        while (i < s.length && s[i] !== "'") {
          if (s[i] === "\\") {
            const n = s[i + 1]; i += 2;
            cur += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
          } else cur += s[i++];
        }
        i++; continue;
      }
      if (c === "\\") { cur += s[i + 1] ?? ""; has = true; i += 2; continue; }
      if (/\s/.test(c)) { if (has) { out.push(cur); cur = ""; has = false; } i++; continue; }
      cur += c; has = true; i++;
    }
    if (has) out.push(cur);
    return out;
  };

  const ARG_SHORT = new Set(["X", "H", "d", "F", "u", "A", "b", "e", "o", "T", "m", "x", "w", "K", "c"]);
  const LONG_ARG = {
    "--request": "X", "--header": "H", "--data": "d", "--data-raw": "d", "--data-binary": "d", "--data-ascii": "d",
    "--data-urlencode": "du", "--form": "F", "--user": "u", "--user-agent": "A", "--cookie": "b", "--referer": "e",
    "--output": "o", "--upload-file": "T", "--max-time": "m", "--proxy": "x", "--url": "url", "--json": "json", "--oauth2-bearer": "bearer",
  };
  const LONG_FLAG = { "--get": "G", "--head": "I", "--location": "L", "--insecure": "k", "--compressed": "z", "--silent": "s", "--verbose": "v", "--include": "i", "--show-error": "S", "--fail": "f" };

  lib.parseCurl = function (cmd) {
    const t = lib.shellSplit(cmd.trim());
    if (!t.length) throw new Error("Paste a curl command.");
    if (/^curl(\.exe)?$/i.test(t[0])) t.shift();
    const r = { url: "", method: "", headers: [], data: [], form: [], user: "", get: false, head: false, insecure: false, follow: false, json: false, cookie: "", note: [] };
    const set = (k, v) => {
      switch (k) {
        case "X": r.method = v.toUpperCase(); break;
        case "H": { const i = v.indexOf(":"); if (i > 0) r.headers.push([v.slice(0, i).trim(), v.slice(i + 1).trim()]); break; }
        case "d": r.data.push(v); break;
        case "du": r.data.push(v.includes("=") ? v.split("=")[0] + "=" + encodeURIComponent(v.slice(v.indexOf("=") + 1)) : encodeURIComponent(v)); break;
        case "F": r.form.push(v); break;
        case "u": r.user = v; break;
        case "A": r.headers.push(["User-Agent", v]); break;
        case "b": r.cookie = v; break;
        case "e": r.headers.push(["Referer", v]); break;
        case "url": r.url = v; break;
        case "json": r.data.push(v); r.json = true; break;
        case "bearer": r.headers.push(["Authorization", "Bearer " + v]); break;
        default: r.note.push("ignored -" + k);
      }
    };
    for (let i = 0; i < t.length; i++) {
      const a = t[i];
      if (a.startsWith("--")) {
        const eq = a.indexOf("="), name = eq > 0 ? a.slice(0, eq) : a;
        if (LONG_ARG[name]) { set(LONG_ARG[name], eq > 0 ? a.slice(eq + 1) : t[++i] ?? ""); continue; }
        if (LONG_FLAG[name]) { const f = LONG_FLAG[name]; if (f === "G") r.get = true; if (f === "I") r.head = true; if (f === "k") r.insecure = true; if (f === "L") r.follow = true; continue; }
        r.note.push("ignored " + name); continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const f = a[j];
          if (ARG_SHORT.has(f)) { const v = a.slice(j + 1) || t[++i] || ""; set(f, v); break; }
          if (f === "G") r.get = true; else if (f === "I") r.head = true; else if (f === "k") r.insecure = true; else if (f === "L") r.follow = true;
        }
        continue;
      }
      if (!r.url) r.url = a;
    }
    if (!r.url) throw new Error("No URL found in the command.");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(r.url)) r.url = "http://" + r.url;
    if (r.json) {
      if (!r.headers.some(h => /^content-type$/i.test(h[0]))) r.headers.push(["Content-Type", "application/json"]);
      if (!r.headers.some(h => /^accept$/i.test(h[0]))) r.headers.push(["Accept", "application/json"]);
    }
    r.body = r.data.join(r.json ? "" : "&");
    if (r.get && r.body) { r.url += (r.url.includes("?") ? "&" : "?") + r.body; r.body = ""; }
    if (r.cookie) r.headers.push(["Cookie", r.cookie]);
    r.method = r.method || (r.head ? "HEAD" : (r.body || r.form.length) ? "POST" : "GET");
    if (r.body && !r.headers.some(h => /^content-type$/i.test(h[0])) && !r.form.length) r.headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
    const ct = (r.headers.find(h => /^content-type$/i.test(h[0])) || [])[1] || "";
    r.jsonBody = null;
    if (r.body && /json/i.test(ct)) { try { r.jsonBody = JSON.parse(r.body); } catch (_) { /* leave as string */ } }
    r.basic = r.user ? r.user.split(/:(.*)/s).slice(0, 2) : null;
    return r;
  };

  const J = JSON.stringify;
  const GEN = {};

  GEN.fetch = r => {
    const opts = [`  method: ${J(r.method)}`];
    const hl = r.headers.map(([k, v]) => `    ${J(k)}: ${J(v)}`);
    if (r.basic) hl.push(`    "Authorization": "Basic " + btoa(${J(r.basic.join(":"))})`);
    if (hl.length) opts.push(`  headers: {\n${hl.join(",\n")}\n  }`);
    if (r.form.length) {
      return `const form = new FormData();\n${r.form.map(f => { const i = f.indexOf("="), k = f.slice(0, i), v = f.slice(i + 1); return v.startsWith("@") ? `form.append(${J(k)}, /* file */ new Blob([/* contents of ${v.slice(1)} */]), ${J(v.slice(1))});` : `form.append(${J(k)}, ${J(v)});`; }).join("\n")}\n\nconst response = await fetch(${J(r.url)}, {\n${opts.concat("  body: form").join(",\n")}\n});\nconst data = await response.text();\nconsole.log(response.status, data);`;
    }
    if (r.body) opts.push(`  body: ${r.jsonBody !== null ? `JSON.stringify(${J(r.jsonBody, null, 2).replace(/\n/g, "\n  ")})` : J(r.body)}`);
    return `const response = await fetch(${J(r.url)}, {\n${opts.join(",\n")}\n});\nconst data = await response.text();\nconsole.log(response.status, data);`;
  };

  GEN.python = r => {
    const lines = ["import requests", "", `url = ${J(r.url)}`];
    const h = r.headers;
    if (h.length) lines.push(`headers = {\n${h.map(([k, v]) => `    ${J(k)}: ${J(v)},`).join("\n")}\n}`);
    let args = [];
    if (h.length) args.push("headers=headers");
    if (r.form.length) {
      lines.push(`files = {\n${r.form.map(f => { const i = f.indexOf("="), k = f.slice(0, i), v = f.slice(i + 1); return v.startsWith("@") ? `    ${J(k)}: open(${J(v.slice(1))}, "rb"),` : `    ${J(k)}: (None, ${J(v)}),`; }).join("\n")}\n}`);
      args.push("files=files");
    } else if (r.body) {
      if (r.jsonBody !== null) { lines.push(`payload = ${pyLit(r.jsonBody)}`); args.push("json=payload"); }
      else { lines.push(`data = ${J(r.body)}`); args.push("data=data"); }
    }
    if (r.basic) args.push(`auth=(${J(r.basic[0])}, ${J(r.basic[1] ?? "")})`);
    if (r.insecure) args.push("verify=False");
    if (!r.follow) args.push("allow_redirects=False");
    lines.push("", `response = requests.request(${J(r.method)}, url${args.length ? ", " + args.join(", ") : ""})`, "print(response.status_code)", "print(response.text)");
    return lines.join("\n");
  };
  function pyLit(v, ind = 0) {
    const pad = "    ".repeat(ind + 1), end = "    ".repeat(ind);
    if (v === null) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "string") return J(v);
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.length ? `[\n${v.map(x => pad + pyLit(x, ind + 1)).join(",\n")},\n${end}]` : "[]";
    const e = Object.entries(v);
    return e.length ? `{\n${e.map(([k, x]) => `${pad}${J(k)}: ${pyLit(x, ind + 1)}`).join(",\n")},\n${end}}` : "{}";
  }

  GEN.powershell = r => {
    const q = s => "'" + String(s).replace(/'/g, "''") + "'";
    const lines = [];
    const h = r.headers.filter(([k]) => !/^content-type$/i.test(k));
    const ct = (r.headers.find(([k]) => /^content-type$/i.test(k)) || [])[1];
    if (r.basic) lines.push(`$cred = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${q(r.basic.join(":"))}))`);
    if (h.length || r.basic) lines.push(`$headers = @{\n${h.map(([k, v]) => `    ${q(k)} = ${q(v)}`).concat(r.basic ? ["    'Authorization' = \"Basic $cred\""] : []).join("\n")}\n}`);
    if (r.body) lines.push(`$body = ${r.body.includes("\n") ? `@'\n${r.body}\n'@` : q(r.body)}`);
    const a = [`Invoke-RestMethod -Uri ${q(r.url)} -Method ${r.method[0] + r.method.slice(1).toLowerCase()}`];
    if (h.length || r.basic) a.push("-Headers $headers");
    if (ct && !r.form.length) a.push(`-ContentType ${q(ct)}`);
    if (r.body) a.push("-Body $body");
    if (r.form.length) {
      lines.push(`# Multipart needs PowerShell 7+: -Form takes a hashtable\n$form = @{\n${r.form.map(f => { const i = f.indexOf("="), k = f.slice(0, i), v = f.slice(i + 1); return `    ${q(k)} = ${v.startsWith("@") ? `Get-Item ${q(v.slice(1))}` : q(v)}`; }).join("\n")}\n}`);
      a.push("-Form $form");
    }
    if (r.insecure) a.push("-SkipCertificateCheck   # PowerShell 7+");
    return lines.concat(a.join(" `\n    ")).join("\n\n");
  };

  GEN.go = r => {
    const imp = ["fmt", "io", "net/http"];
    if (r.body) imp.push("strings");
    const l = [];
    l.push(`package main\n\nimport (\n${imp.sort().map(i => `\t"${i}"`).join("\n")}\n)\n\nfunc main() {`);
    l.push(r.body ? `\tbody := strings.NewReader(${J(r.body)})\n\treq, err := http.NewRequest(${J(r.method)}, ${J(r.url)}, body)` : `\treq, err := http.NewRequest(${J(r.method)}, ${J(r.url)}, nil)`);
    l.push("\tif err != nil {\n\t\tpanic(err)\n\t}");
    r.headers.forEach(([k, v]) => l.push(`\treq.Header.Set(${J(k)}, ${J(v)})`));
    if (r.basic) l.push(`\treq.SetBasicAuth(${J(r.basic[0])}, ${J(r.basic[1] ?? "")})`);
    l.push("\n\tresp, err := http.DefaultClient.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer resp.Body.Close()\n\n\tb, _ := io.ReadAll(resp.Body)\n\tfmt.Println(resp.StatusCode, string(b))\n}");
    if (r.form.length) l.push("// Note: -F multipart is not converted; build the body with mime/multipart.");
    return l.join("\n");
  };

  GEN.csharp = r => {
    const l = ["using var client = new HttpClient();", `using var request = new HttpRequestMessage(new HttpMethod(${J(r.method)}), ${J(r.url)});`];
    r.headers.filter(([k]) => !/^content-/i.test(k)).forEach(([k, v]) => l.push(`request.Headers.TryAddWithoutValidation(${J(k)}, ${J(v)});`));
    if (r.basic) l.push(`request.Headers.Authorization = new("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(${J(r.basic.join(":"))})));`);
    if (r.body) {
      const ct = (r.headers.find(([k]) => /^content-type$/i.test(k)) || [])[1] || "text/plain";
      l.push(`request.Content = new StringContent(${J(r.body)}, Encoding.UTF8, ${J(ct.split(";")[0].trim())});`);
    }
    l.push("", "using var response = await client.SendAsync(request);", "Console.WriteLine((int)response.StatusCode);", "Console.WriteLine(await response.Content.ReadAsStringAsync());");
    return l.join("\n");
  };

  lib.curlTo = (cmd, lang) => GEN[lang](lib.parseCurl(cmd));

  DT.register({
    id: "curl", name: "curl Converter", group: "Translate",
    desc: "Paste a curl command (bash, cmd or PowerShell style, copied from browser DevTools) and get equivalent code in JavaScript, Python, PowerShell, Go or C#.",
    keywords: "fetch requests invoke-restmethod httpclient devtools copy as curl",
    render(root) {
      root.innerHTML = `
        <div class="opts"><label>Output <select id="lang"><option value="fetch">JavaScript (fetch)</option><option value="python">Python (requests)</option><option value="powershell">PowerShell (Invoke-RestMethod)</option><option value="go">Go (net/http)</option><option value="csharp">C# (HttpClient)</option></select></label></div>
        <div class="two">
          <div class="col"><label class="l" for="in">curl command</label><textarea id="in" spellcheck="false" placeholder="curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{&quot;name&quot;:&quot;x&quot;}'"></textarea></div>
          <div class="col"><label class="l" for="out">Generated code</label><textarea id="out" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="btns"><button class="btn" data-copy="#out" type="button">Copy output</button><button class="btn" data-clear="#in,#out" type="button">Clear</button></div>
        <div class="status" id="st"></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st");
      function run() {
        if (!inp.value.trim()) { out.value = ""; DT.status(st, "", ""); return; }
        try {
          const r = lib.parseCurl(inp.value);
          out.value = GEN[$("#lang").value](r);
          DT.status(st, r.note.length ? "warn" : "ok", `${r.method} ${r.url}` + (r.note.length ? " · " + r.note.join(", ") : ""));
        } catch (e) { out.value = ""; DT.status(st, "err", e.message); }
      }
      inp.addEventListener("input", DT.debounce(run, 200));
      $("#lang").onchange = run;
    },
  });
})();
