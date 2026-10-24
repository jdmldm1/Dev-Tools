(function () {
  DT.register({
    id: "yaml", name: "JSON ⇄ YAML", group: "Translate",
    desc: "Convert between JSON and YAML in either direction. Auto mode detects which one you pasted. Multi-document YAML becomes a JSON array.",
    keywords: "yml convert kubernetes compose openapi",
    render(root) {
      root.innerHTML = `
        <div class="opts">
          <label>Direction <select id="mode"><option value="auto">Auto-detect</option><option value="j2y">JSON → YAML</option><option value="y2j">YAML → JSON</option></select></label>
          <label>Indent <select id="indent"><option>2</option><option>4</option></select></label>
          <label><input type="checkbox" id="sort"> Sort keys</label>
          <label><input type="checkbox" id="quote"> Quote strings in YAML</label>
        </div>
        <div class="two">
          <div class="col"><label class="l" for="in">Input</label><textarea id="in" spellcheck="false" placeholder="Paste JSON or YAML"></textarea></div>
          <div class="col"><label class="l" for="out">Output <span id="dir" class="hint"></span></label><textarea id="out" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="btns"><button class="btn" data-copy="#out" type="button">Copy output</button><button class="btn" id="swap" type="button">Output → Input</button><button class="btn" data-clear="#in,#out" type="button">Clear</button></div>
        <div class="status" id="st"></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st");
      function run() {
        const text = inp.value;
        if (!text.trim()) { out.value = ""; DT.status(st, "", ""); $("#dir").textContent = ""; return; }
        if (!window.jsyaml) { DT.status(st, "err", "js-yaml failed to load (assets/vendor/js-yaml.min.js)."); return; }
        const indent = +$("#indent").value, sortKeys = $("#sort").checked;
        let mode = $("#mode").value, json;
        if (mode !== "y2j") { try { json = JSON.parse(text); if (mode === "auto") mode = "j2y"; } catch (e) { if (mode === "j2y") { DT.status(st, "err", "Invalid JSON: " + DT.lib.jsonError(text, e)); out.value = ""; return; } mode = "y2j"; } }
        try {
          if (mode === "j2y") {
            out.value = jsyaml.dump(json, { indent, sortKeys, lineWidth: -1, noRefs: true, forceQuotes: $("#quote").checked });
            $("#dir").textContent = "· YAML"; DT.status(st, "ok", "JSON → YAML");
          } else {
            const docs = jsyaml.loadAll(text);
            let v = docs.length === 1 ? docs[0] : docs;
            if (sortKeys) v = DT.lib.sortKeys(v);
            out.value = JSON.stringify(v, null, indent);
            $("#dir").textContent = "· JSON"; DT.status(st, "ok", docs.length > 1 ? `YAML (${docs.length} documents) → JSON array` : "YAML → JSON");
          }
        } catch (e) { out.value = ""; DT.status(st, "err", (e.reason || e.message) + (e.mark ? ` (line ${e.mark.line + 1}, column ${e.mark.column + 1})` : "")); }
      }
      inp.addEventListener("input", DT.debounce(run, 200));
      root.querySelectorAll("select,input[type=checkbox]").forEach(el => el.addEventListener("change", run));
      $("#swap").onclick = () => { inp.value = out.value; $("#mode").value = "auto"; run(); };
    },
  });
})();
