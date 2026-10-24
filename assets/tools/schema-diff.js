/* Schema Diff: load two versions of a schema set and see what changed, with each change rated for a system built on the old one. */
(function () {
  const lib = DT.lib, esc = DT.esc;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const SEV_LABEL = { breaking: "breaking", review: "review", additive: "additive", docs: "docs" };
  const MAX_ROWS = 400;

  DT.register({
    id: "schemadiff", name: "Schema Diff", group: "UCI",
    desc: "Compare two versions of an XSD set (for example UCI 2.5 and 2.6): added, removed and changed messages, types, members and enumeration values, each rated breaking, review or additive for a system built on the old version, with the messages each change reaches. Export as Markdown or CSV.",
    keywords: "uci schema compare diff version upgrade migration breaking change xsd 2.5 2.6 enum members",
    render(root) {
      const $ = s => root.querySelector(s);
      const S = { a: null, b: null, diff: null, tab: "messages", sev: new Set(["breaking", "review", "additive"]), q: "", open: new Set(), shown: MAX_ROWS };

      const side = (id, title, hint) => `<div class="panel" id="${id}" style="margin:0"><div class="col"><label class="l">${title}</label>
        <div class="opts"><button class="btn" data-a="files" type="button">Load .xsd files…</button><button class="btn" data-a="dir" type="button">Load folder…</button><button class="btn" data-a="saved" type="button" title="The schema saved by the XSD Explorer">Use the remembered schema</button></div>
        <div class="hint" data-r="sum">${hint}</div>
        <input type="file" multiple accept=".xsd,.xml" hidden data-r="f"><input type="file" webkitdirectory hidden data-r="d"></div></div>`;
      root.innerHTML = `
        <div class="two">${side("sa", "Older schema (A)", "Load the version you build on today.")}${side("sb", "Newer schema (B)", "Load the version you are moving to.")}</div>
        <div class="status" id="dst"></div>
        <div id="out" hidden>
          <div class="tiles" id="tiles"></div>
          <div class="opts"><span class="chip-row" id="sevs"></span><label><input type="checkbox" id="docs"> include documentation changes</label><input type="search" id="q" class="mono" placeholder="filter by name or change text" style="width:260px"><button class="btn" id="exmd" type="button">Markdown</button><button class="btn" id="excsv" type="button">CSV</button></div>
          <div class="tabs"><button class="tab on" data-t="messages" type="button">Messages</button><button class="tab" data-t="types" type="button">Types</button><button class="tab" data-t="roots" type="button">Root causes</button></div>
          <div class="hint" id="thint" style="margin-bottom:6px"></div>
          <div class="tscroll" style="max-height:62vh"><div id="list"></div></div>
        </div>`;
      DT.wire(root);

      /* ----- loading ----- */
      async function load(which, files, how) {
        const box = $(which === "a" ? "#sa" : "#sb"), sum = box.querySelector('[data-r="sum"]');
        sum.textContent = `Parsing ${files.length} file${files.length === 1 ? "" : "s"}…`;
        await new Promise(r => setTimeout(r, 20));
        try {
          const m = lib.xsdModel(files); S[which] = m;
          const vers = [...new Set(m.files.map(f => f.version).filter(Boolean))], sm = lib.xsdSummary(m);
          sum.textContent = `${how}${m.files.length} file${m.files.length === 1 ? "" : "s"} · version ${vers.join(", ") || "?"} · ${sm.elements.toLocaleString()} messages · ${sm.types.toLocaleString()} types`;
          run();
        } catch (e) { sum.textContent = "Could not load: " + e.message; }
      }
      for (const which of ["a", "b"]) {
        const box = $(which === "a" ? "#sa" : "#sb");
        const pick = async list => {
          const picked = lib.xsdPickFiles([...list]);
          if (!picked.length) { box.querySelector('[data-r="sum"]').textContent = "No .xsd files found in that selection."; return; }
          await load(which, await Promise.all(picked.map(async f => ({ name: f.name, text: await f.text() }))), "");
        };
        box.querySelector('[data-a="files"]').onclick = () => box.querySelector('[data-r="f"]').click();
        box.querySelector('[data-a="dir"]').onclick = () => box.querySelector('[data-r="d"]').click();
        box.querySelector('[data-r="f"]').onchange = e => pick(e.target.files);
        box.querySelector('[data-r="d"]').onchange = e => pick(e.target.files);
        box.querySelector('[data-a="saved"]').onclick = async () => {
          const v = lib.idb && await lib.idb.get("xsd-set");
          if (v && v.files && v.files.length) load(which, v.files, "Remembered schema: "); else box.querySelector('[data-r="sum"]').textContent = "Nothing remembered yet: load a schema in the XSD Explorer first.";
        };
      }

      function run() {
        if (!S.a || !S.b) return;
        DT.status($("#dst"), "", "Comparing…");
        setTimeout(() => {
          try {
            const t0 = performance.now();
            S.diff = lib.schemaDiff(S.a, S.b, { docs: $("#docs").checked });
            S.open.clear(); S.shown = MAX_ROWS;
            DT.status($("#dst"), "ok", `Compared in ${Math.round(performance.now() - t0)} ms.`);
            $("#out").hidden = false; render();
          } catch (e) { DT.status($("#dst"), "err", "Comparison failed: " + e.message); }
        }, 20);
      }
      $("#docs").onchange = run;

      /* ----- results ----- */
      const labelA = () => (S.diff.a.versions[0] || "A"), labelB = () => (S.diff.b.versions[0] || "B");
      function render() {
        const d = S.diff, sm = d.summary;
        $("#tiles").innerHTML = [["Messages added", sm.messages.added], ["Messages removed", sm.messages.removed], ["Messages affected", sm.messages.changed], ["Types added", sm.types.added], ["Types removed", sm.types.removed], ["Types changed", sm.types.changed], ["Breaking types", sm.types.breaking]]
          .map(([l, v]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${v.toLocaleString()}</div></div>`).join("");
        const sevCount = S.tab === "types" ? sm.types : sm.messages;
        $("#sevs").innerHTML = lib.diffSeverities.map(k => `<span class="chip" data-sev="${k}" style="${S.sev.has(k) ? "color:var(--accent);border-color:var(--accent)" : ""}">${k} ${sevCount[k] || 0}</span>`).join("");
        root.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.t === S.tab));
        $("#thint").textContent = S.tab === "messages" ? "Messages whose definition changed, directly or through a type they contain. Click one for the changes and the types that reach it."
          : S.tab === "types" ? "Every type that was added, removed or changed. Click one for the individual changes."
          : "The changed types that reach the most messages: fixing the answer for these settles most of the list.";
        drawList();
      }
      const match = (x, q) => !q || x.name.toLowerCase().includes(q) || x.changes.some(c => c.text.toLowerCase().includes(q));
      function drawList() {
        const d = S.diff, q = S.q.trim().toLowerCase(), box = $("#list"); box.innerHTML = "";
        let items;
        if (S.tab === "roots") {
          const count = new Map();
          for (const m of d.messages) for (const i of m.impacts) count.set(i.type, (count.get(i.type) || 0) + 1);
          items = d.types.filter(t => S.sev.has(t.severity) && match(t, q)).map(t => ({ ...t, reach: count.get(t.name) || 0 })).sort((x, y) => y.reach - x.reach || x.name.localeCompare(y.name));
        } else items = (S.tab === "types" ? d.types : d.messages).filter(x => S.sev.has(x.severity) && match(x, q));
        if (!items.length) { box.append(el("div", "hint", "Nothing matches.")); return; }
        for (const x of items.slice(0, S.shown)) {
          const row = el("div", "dfrow"), key = S.tab + ":" + x.name, head = el("div", "dfh");
          head.innerHTML = `<span class="badge ${x.severity === "breaking" ? "err" : x.severity === "review" ? "warn" : x.severity === "additive" ? "ok" : "info"}">${SEV_LABEL[x.severity]}</span><span class="kb">${x.status}</span><b>${esc(x.name)}</b>`
            + (S.tab === "roots" ? `<span class="dfn">reaches ${x.reach.toLocaleString()} message${x.reach === 1 ? "" : "s"}</span>` : S.tab === "messages" && x.impacts.length ? `<span class="dfn">via ${x.impacts.length} changed type${x.impacts.length === 1 ? "" : "s"}</span>` : `<span class="dfn">${x.changes.length} change${x.changes.length === 1 ? "" : "s"}</span>`)
            + `<span class="dft">${esc((x.changes[0] || {}).text || "")}</span>`;
          row.append(head);
          if (S.open.has(key)) {
            const det = el("div", "dfd");
            det.innerHTML = x.changes.map(c => `<div><span class="sv ${c.severity}">${c.severity}</span> ${esc(c.text)}</div>`).join("")
              + (x.impacts && x.impacts.length ? `<div class="dfi"><span class="hint">Reached through:</span> ${x.impacts.slice(0, 30).map(i => `<a class="go" data-type="${esc(i.type)}">${esc(i.type)}</a> <span class="sv ${i.severity}">${i.severity}</span>`).join(" · ")}${x.impacts.length > 30 ? ` … and ${x.impacts.length - 30} more` : ""}</div>` : "");
            row.append(det);
          }
          head.onclick = () => { if (S.open.has(key)) S.open.delete(key); else S.open.add(key); drawList(); };
          box.append(row);
        }
        if (items.length > S.shown) { const more = el("button", "btn", `Show ${Math.min(MAX_ROWS, items.length - S.shown)} more (${items.length - S.shown} hidden)`); more.type = "button"; more.onclick = () => { S.shown += MAX_ROWS; drawList(); }; box.append(more); }
      }
      root.querySelector(".tabs").onclick = e => { const b = e.target.closest(".tab"); if (b) { S.tab = b.dataset.t; S.shown = MAX_ROWS; render(); } };
      $("#sevs").onclick = e => { const c = e.target.closest(".chip"); if (!c) return; const k = c.dataset.sev; if (S.sev.has(k)) S.sev.delete(k); else S.sev.add(k); S.shown = MAX_ROWS; render(); };
      $("#q").addEventListener("input", DT.debounce(() => { S.q = $("#q").value; S.shown = MAX_ROWS; drawList(); }, 150));
      $("#list").onclick = e => { const a = e.target.closest("a[data-type]"); if (a) { S.tab = "types"; S.q = a.dataset.type; $("#q").value = a.dataset.type; S.open.add("types:" + a.dataset.type); S.shown = MAX_ROWS; render(); } };
      $("#exmd").onclick = () => { if (S.diff) DT.download("schema-diff.md", lib.schemaDiffMarkdown(S.diff, { labelA: labelA(), labelB: labelB(), min: S.sev.has("additive") ? "additive" : S.sev.has("review") ? "review" : "breaking" }), "text/markdown"); };
      $("#excsv").onclick = () => { if (S.diff) DT.download("schema-diff.csv", lib.schemaDiffCsv(S.diff), "text/csv"); };
    },
  });
})();
