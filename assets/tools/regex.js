(function () {
  const lib = DT.lib;

  /* Self-contained so it can also be injected into a Web Worker (see runRegexSafe).
     Returns { matches: [{ index, end, text, groups: [..], named: {..} }], truncated } or { error }. */
  lib.runRegex = function (pattern, flags, text, limit) {
    let re;
    try { re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g"); } catch (e) { return { error: e.message }; }
    const matches = [];
    let truncated = false;
    for (const m of text.matchAll(re)) {
      if (!flags.includes("g") && matches.length) break;
      if (matches.length >= limit) { truncated = true; break; }
      matches.push({ index: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1).map(x => x === undefined ? null : x), named: m.groups ? { ...m.groups } : {} });
    }
    return { matches, truncated };
  };

  /* Run in a worker with a timeout so catastrophic backtracking cannot freeze the page. */
  lib.runRegexSafe = function (pattern, flags, text, limit = 1000, timeoutMs = 1500) {
    return new Promise(resolve => {
      let w, url, done = false;
      const finish = v => { if (done) return; done = true; clearTimeout(t); if (w) w.terminate(); if (url) URL.revokeObjectURL(url); resolve(v); };
      let t;
      try {
        url = URL.createObjectURL(new Blob([`const run=${lib.runRegex.toString()};onmessage=e=>postMessage(run(...e.data));`], { type: "text/javascript" }));
        w = new Worker(url);
        w.onmessage = e => finish(e.data);
        w.onerror = () => finish(lib.runRegex(pattern, flags, text, limit));
        t = setTimeout(() => finish({ error: `Timed out after ${timeoutMs} ms: this pattern backtracks catastrophically on this input.` }), timeoutMs);
        w.postMessage([pattern, flags, text, limit]);
      } catch (_) { finish(lib.runRegex(pattern, flags, text, limit)); }
    });
  };

  lib.highlightMatches = function (text, matches, esc) {
    let out = "", pos = 0;
    matches.forEach((m, i) => {
      if (m.index < pos) return;
      out += esc(text.slice(pos, m.index));
      out += m.text === "" ? `<mark class="m ${i % 2 ? "alt" : ""}" title="empty match">&#8203;</mark>` : `<mark class="m ${i % 2 ? "alt" : ""}">${esc(m.text)}</mark>`;
      pos = m.end;
    });
    return out + esc(text.slice(pos));
  };

  const PRESETS = [
    ["Email", "[\\w.+-]+@[\\w-]+\\.[\\w.-]+"], ["URL", "https?:\\/\\/[^\\s/$.?#].[^\\s]*"], ["IPv4", "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b"],
    ["ISO date", "\\d{4}-\\d{2}-\\d{2}"], ["Hex color", "#(?:[0-9a-fA-F]{3}){1,2}\\b"], ["UUID", "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"], ["Words", "\\b\\w+\\b"],
  ];

  DT.register({
    id: "regex", name: "Regex Tester", group: "Format & Validate",
    desc: "Test JavaScript regular expressions live with highlighted matches, capture groups and replace. Runs in a worker with a timeout so a bad pattern cannot hang the page.",
    keywords: "regexp pattern match replace groups lookahead test",
    render(root) {
      root.innerHTML = `
        <div class="opts"><span class="lbl">/</span><input type="text" id="pat" class="mono" style="flex:1;min-width:240px;max-width:640px" placeholder="pattern" spellcheck="false" aria-label="Pattern"><span class="lbl">/</span>
          ${["g", "i", "m", "s", "u", "y", "d"].map(f => `<label title="${f}"><input type="checkbox" data-f="${f}" ${f === "g" ? "checked" : ""}> ${f}</label>`).join("")}</div>
        <div class="chip-row" id="presets">${PRESETS.map(([n, p], i) => `<span class="chip" data-i="${i}">${n}</span>`).join("")}</div>
        <div class="status" id="st"></div>
        <div class="two">
          <div class="col"><label class="l" for="txt">Test string</label><textarea id="txt" class="md" spellcheck="false">Contact ada@example.com or grace@navy.mil by 2026-10-24.</textarea></div>
          <div class="col"><label class="l">Matches highlighted</label><pre class="out" id="hl" style="min-height:150px"></pre></div>
        </div>
        <div class="panel"><div class="lbl" style="margin-bottom:8px">Match details</div><div id="det" class="hint">—</div></div>
        <div class="two">
          <div class="col"><label class="l" for="rep">Replace with (supports $1, $&amp;, $&lt;name&gt;)</label><input type="text" id="rep" class="mono" spellcheck="false"></div>
          <div class="col"><label class="l">Replace result</label><pre class="out" id="rout"></pre></div>
        </div>`;
      const $ = s => root.querySelector(s);
      const flags = () => [...root.querySelectorAll("[data-f]")].filter(c => c.checked).map(c => c.dataset.f).join("");
      let seq = 0;
      async function run() {
        const my = ++seq, pat = $("#pat").value, txt = $("#txt").value, fl = flags();
        if (!pat) { $("#hl").textContent = txt; $("#det").textContent = "—"; $("#rout").textContent = ""; DT.status($("#st"), "", ""); return; }
        const r = await lib.runRegexSafe(pat, fl, txt);
        if (my !== seq) return;
        if (r.error) { DT.status($("#st"), "err", r.error); $("#hl").textContent = txt; $("#det").textContent = "—"; $("#rout").textContent = ""; return; }
        DT.status($("#st"), r.matches.length ? "ok" : "warn", `${r.matches.length}${r.truncated ? "+" : ""} match${r.matches.length === 1 ? "" : "es"}`);
        $("#hl").innerHTML = lib.highlightMatches(txt, r.matches, DT.esc);
        if (!r.matches.length) $("#det").textContent = "No matches.";
        else {
          const hasG = r.matches.some(m => m.groups.length);
          $("#det").innerHTML = `<table class="kv"><thead><tr><th>#</th><th>Index</th><th>Match</th>${hasG ? "<th>Groups</th>" : ""}</tr></thead><tbody>${r.matches.slice(0, 200).map((m, i) =>
            `<tr><td class="k">${i + 1}</td><td class="v">${m.index}–${m.end}</td><td class="v">${DT.esc(m.text) || "<i>(empty)</i>"}</td>${hasG ? `<td class="v">${m.groups.map((g, j) => `$${j + 1} = ${g === null ? "<i>undefined</i>" : DT.esc(g)}`).concat(Object.entries(m.named).map(([k, v]) => `&lt;${DT.esc(k)}&gt; = ${v === undefined ? "<i>undefined</i>" : DT.esc(v)}`)).join("<br>")}</td>` : ""}</tr>`).join("")}</tbody></table>${r.matches.length > 200 ? '<div class="hint">Showing first 200.</div>' : ""}`;
        }
        try { $("#rout").textContent = $("#rep").value === "" && !$("#rep").dataset.used ? "" : txt.replace(new RegExp(pat, fl), $("#rep").value); } catch (_) { /* reported above */ }
      }
      const go = DT.debounce(run, 150);
      $("#pat").addEventListener("input", go); $("#txt").addEventListener("input", go);
      $("#rep").addEventListener("input", () => { $("#rep").dataset.used = "1"; go(); });
      root.querySelectorAll("[data-f]").forEach(c => c.onchange = go);
      $("#presets").addEventListener("click", e => { const c = e.target.closest("[data-i]"); if (c) { $("#pat").value = PRESETS[c.dataset.i][1]; run(); } });
      $("#pat").value = PRESETS[0][1]; run();
    },
  });
})();
