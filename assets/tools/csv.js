(function () {
  const lib = DT.lib;

  /* RFC 4180-style parser: quoted fields, doubled quotes, embedded newlines. Returns array of rows. */
  lib.parseCSV = function (text, delim = ",") {
    const rows = []; let row = [], f = "", q = false, i = 0;
    while (i < text.length) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
        f += c; i++; continue;
      }
      if (c === '"' && f === "") { q = true; i++; continue; }
      if (c === delim) { row.push(f); f = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; i++; continue; }
      f += c; i++;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  };

  lib.toCSV = function (rows, delim = ",") {
    const cell = v => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return rows.map(r => r.map(cell).join(delim)).join("\n");
  };

  lib.csvToObjects = function (rows, header = true, infer = true) {
    const conv = s => {
      if (!infer) return s;
      if (s === "") return null;
      if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
      if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s) && Number.isSafeInteger(Math.trunc(+s))) return +s;
      return s;
    };
    if (!rows.length) return [];
    const head = header ? rows[0] : rows[0].map((_, i) => "col" + (i + 1));
    return rows.slice(header ? 1 : 0).map(r => Object.fromEntries(head.map((h, i) => [h, conv(r[i] ?? "")])));
  };

  lib.objectsToRows = function (data) {
    const arr = Array.isArray(data) ? data : [data];
    if (arr.every(x => Array.isArray(x))) return arr;
    const keys = [];
    arr.forEach(o => { if (o && typeof o === "object") Object.keys(o).forEach(k => { if (!keys.includes(k)) keys.push(k); }); });
    if (!keys.length) return arr.map(x => [x]);
    return [keys, ...arr.map(o => keys.map(k => (o && typeof o === "object" && k in o) ? o[k] : ""))];
  };

  DT.register({
    id: "csv", name: "CSV ⇄ JSON", group: "Translate",
    desc: "Convert CSV or TSV to a JSON array of objects, or JSON back to CSV. Handles quoted fields, embedded commas and newlines.",
    keywords: "tsv spreadsheet excel table",
    render(root) {
      root.innerHTML = `
        <div class="opts">
          <label>Direction <select id="mode"><option value="auto">Auto-detect</option><option value="c2j">CSV → JSON</option><option value="j2c">JSON → CSV</option></select></label>
          <label>Delimiter <select id="delim"><option value=",">Comma</option><option value="&#9;">Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option></select></label>
          <label><input type="checkbox" id="header" checked> First row is header</label>
          <label><input type="checkbox" id="infer" checked> Convert numbers / booleans / empty → null</label>
        </div>
        <div class="two">
          <div class="col"><label class="l" for="in">Input</label><textarea id="in" spellcheck="false" placeholder="name,age&#10;Ada,36"></textarea></div>
          <div class="col"><label class="l" for="out">Output</label><textarea id="out" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="btns"><button class="btn" data-copy="#out" type="button">Copy output</button><button class="btn" id="dl" type="button">Download</button><button class="btn" id="swap" type="button">Output → Input</button><button class="btn" data-clear="#in,#out" type="button">Clear</button></div>
        <div class="status" id="st"></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st");
      let kind = "json";
      function run() {
        const text = inp.value;
        if (!text.trim()) { out.value = ""; DT.status(st, "", ""); return; }
        const delim = $("#delim").value;
        let mode = $("#mode").value, parsed;
        if (mode !== "c2j") { try { parsed = JSON.parse(text); if (mode === "auto") mode = "j2c"; } catch (e) { if (mode === "j2c") { DT.status(st, "err", "Invalid JSON: " + lib.jsonError(text, e)); out.value = ""; return; } mode = "c2j"; } }
        try {
          if (mode === "j2c") {
            const rows = lib.objectsToRows(parsed);
            out.value = lib.toCSV(rows, delim); kind = "csv";
            DT.status(st, "ok", `JSON → CSV · ${Math.max(0, rows.length - 1)} data rows · ${rows[0] ? rows[0].length : 0} columns`);
          } else {
            const rows = lib.parseCSV(text, delim);
            const objs = lib.csvToObjects(rows, $("#header").checked, $("#infer").checked);
            out.value = JSON.stringify(objs, null, 2); kind = "json";
            const widths = new Set(rows.map(r => r.length));
            DT.status(st, widths.size > 1 ? "warn" : "ok", `CSV → JSON · ${objs.length} records` + (widths.size > 1 ? " · warning: rows have differing column counts" : ""));
          }
        } catch (e) { out.value = ""; DT.status(st, "err", e.message); }
      }
      inp.addEventListener("input", DT.debounce(run, 200));
      root.querySelectorAll("select,input[type=checkbox]").forEach(el => el.addEventListener("change", run));
      $("#swap").onclick = () => { inp.value = out.value; $("#mode").value = "auto"; run(); };
      $("#dl").onclick = () => out.value && DT.download("converted." + kind, out.value, kind === "csv" ? "text/csv" : "application/json");
    },
  });
})();
