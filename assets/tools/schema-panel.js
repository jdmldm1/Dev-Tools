/* The "load a schema" block shared by the NATS and CAL explorers: files or folder, remembered in this browser (the same
   saved schema the XSD Explorer uses), restored on the next visit. The loaded model is kept in lib.sharedSchema.model so
   moving between tools does not lose it. */
(function () {
  const lib = DT.lib, esc = DT.esc;
  lib.sharedSchema = { model: null };

  lib.schemaPanelHtml = what => `<div class="col" style="margin-top:8px"><label class="l">Schema for decoding ${esc(what)} (optional)</label>
    <div class="opts"><span class="hint" id="sch">No schema loaded.</span>
      <button class="btn" id="schpick" type="button">Load .xsd files…</button><button class="btn" id="schdir" type="button">Load folder…</button><button class="btn" id="schforget" type="button" hidden>Forget</button>
      <label><input type="checkbox" id="schrem" checked> remember in this browser</label></div>
    <input type="file" id="schf" multiple accept=".xsd,.xml" hidden><input type="file" id="schd" webkitdirectory hidden>
    <div class="hint">Any schema version works: messages are matched by element name; a namespace difference is reported, not blocked. Shared with the XSD Explorer.</div>
  </div>`;

  /* First schema version found in the loaded files (e.g. "002.6.0"), for protocols that negotiate it. */
  lib.schemaVersion = m => (m && m.files.map(f => f.version).find(Boolean)) || "";

  /* Wires the block inside `root`. onModel(model|null) is called whenever the schema changes.
     Returns { use(model), start() }: start() adopts the shared model or restores the saved one. */
  lib.schemaPanel = function (root, onModel) {
    const $ = s => root.querySelector(s), idb = lib.idb;
    const describe = (m, how) => {
      const sm = lib.xsdSummary(m), vers = [...new Set(m.files.map(f => f.version).filter(Boolean))], tns = [...new Set(m.files.map(f => f.targetNamespace).filter(Boolean))];
      const errs = m.problems.filter(p => p.level === "error").length;
      return `${how}${m.files.length} file${m.files.length === 1 ? "" : "s"}${vers.length ? " · version " + vers.join(", ") : ""} · ${sm.elements.toLocaleString()} messages · ${sm.types.toLocaleString()} types${tns.length ? " · " + tns[0] + (tns.length > 1 ? ` (+${tns.length - 1})` : "") : ""}${errs ? ` · ${errs} schema error${errs === 1 ? "" : "s"}` : ""}`;
    };
    function use(m, how = "") {
      lib.sharedSchema.model = m;
      $("#sch").textContent = m ? describe(m, how) : "No schema loaded.";
      $("#schforget").hidden = !m;
      onModel(m);
    }
    async function load(files) {
      $("#sch").textContent = `Parsing ${files.length} file${files.length === 1 ? "" : "s"}…`;
      await new Promise(r => setTimeout(r, 20));
      try {
        use(lib.xsdModel(files));
        if ($("#schrem").checked && idb) await idb.set("xsd-set", { files, saved: Date.now() });
      } catch (e) { $("#sch").textContent = "Could not load the schema: " + e.message; }
    }
    const pick = async list => {
      const picked = lib.xsdPickFiles([...list]);
      if (!picked.length) { $("#sch").textContent = "No .xsd files found in that selection."; return; }
      await load(await Promise.all(picked.map(async f => ({ name: f.name, text: await f.text() }))));
    };
    $("#schpick").onclick = () => $("#schf").click();
    $("#schdir").onclick = () => $("#schd").click();
    $("#schf").onchange = e => pick(e.target.files);
    $("#schd").onchange = e => pick(e.target.files);
    $("#schforget").onclick = async () => { if (idb) await idb.del("xsd-set"); use(null); };
    return {
      use,
      start() {
        if (lib.sharedSchema.model) return use(lib.sharedSchema.model);
        if (idb) idb.get("xsd-set").then(v => {
          if (v && v.files && v.files.length && root.isConnected && !lib.sharedSchema.model) { try { use(lib.xsdModel(v.files), "Restored from this browser: "); } catch (_) { /* unreadable saved schema */ } }
        });
      },
    };
  };
})();
