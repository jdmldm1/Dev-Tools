(function () {
  const lib = DT.lib;
  const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°", plusmn: "±", times: "×", divide: "÷", laquo: "«", raquo: "»", bull: "•", middot: "·", larr: "←", rarr: "→", uarr: "↑", darr: "↓" };

  const htmlDec = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") { const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(cp); } catch (_) { return m; } }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });

  lib.escapers = {
    html: { name: "HTML entities", enc: s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"), dec: htmlDec },
    xml: { name: "XML", enc: s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"), dec: htmlDec },
    json: {
      name: "JSON string",
      enc: s => JSON.stringify(s).slice(1, -1),
      dec: s => JSON.parse('"' + s.replace(/\r?\n/g, "\\n").replace(/(?<!\\)"/g, '\\"') + '"'),
    },
    js: {
      name: "JavaScript string (single quotes)",
      enc: s => JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'"),
      dec: s => JSON.parse('"' + s.replace(/\\'/g, "'").replace(/\r?\n/g, "\\n").replace(/(?<!\\)"/g, '\\"') + '"'),
    },
    regex: { name: "Regex literal", enc: s => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"), dec: s => s.replace(/\\([.*+?^${}()|[\]\\/-])/g, "$1") },
    sql: { name: "SQL string (single quotes)", enc: s => s.replace(/'/g, "''"), dec: s => s.replace(/''/g, "'") },
    shell: {
      name: "Shell (POSIX single-quoted)",
      enc: s => "'" + s.replace(/'/g, "'\\''") + "'",
      dec: s => s.replace(/^'|'$/g, "").replace(/'\\''/g, "'"),
    },
    csv: { name: "CSV field", enc: s => '"' + s.replace(/"/g, '""') + '"', dec: s => s.replace(/^"|"$/g, "").replace(/""/g, '"') },
    unicode: {
      name: "Unicode escapes (\\uXXXX)",
      enc: s => s.replace(/[^\x20-\x7e]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")),
      dec: s => s.replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi, (m, a, b) => String.fromCodePoint(parseInt(a || b, 16))),
    },
  };

  DT.register({
    id: "escape", name: "Escape / Unescape", group: "Encode & Decode",
    desc: "Escape or unescape text for HTML, XML, JSON, JavaScript, regex, SQL, shell, CSV and Unicode escapes.",
    keywords: "entities quote backslash sanitize string literal",
    render(root) {
      const modes = Object.entries(lib.escapers);
      root.innerHTML = `
        <div class="opts"><label>Format <select id="mode">${modes.map(([k, v]) => `<option value="${k}">${DT.esc(v.name)}</option>`).join("")}</select></label></div>
        <div class="two">
          <div class="col"><label class="l" for="in">Input</label><textarea id="in" class="md" spellcheck="false"></textarea></div>
          <div class="col"><label class="l" for="out">Output</label><textarea id="out" class="md" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="btns">
          <button class="btn primary" id="enc" type="button">Escape →</button>
          <button class="btn primary" id="dec" type="button">← Unescape</button>
          <button class="btn" id="swap" type="button">Output → Input</button>
          <button class="btn" data-copy="#out" type="button">Copy output</button>
          <button class="btn" data-clear="#in,#out" type="button">Clear</button>
        </div>
        <div class="status" id="st"></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st");
      const go = d => {
        try { out.value = lib.escapers[$("#mode").value][d](inp.value); DT.status(st, "ok", d === "enc" ? "Escaped" : "Unescaped"); }
        catch (e) { out.value = ""; DT.status(st, "err", "Could not unescape: " + e.message); }
      };
      $("#enc").onclick = () => go("enc");
      $("#dec").onclick = () => go("dec");
      $("#swap").onclick = () => { inp.value = out.value; };
    },
  });
})();
