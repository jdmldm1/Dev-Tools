/* XSD Schema Explorer UI. Library code lives in xsd-model.js, xsd-validate.js and xsd-sample.js. */
(function () {
  const lib = DT.lib, esc = DT.esc;

  /* ---- tiny IndexedDB key/value store, so a schema set can be remembered locally ---- */
  const idb = {
    open: () => new Promise((res, rej) => { const r = indexedDB.open("dev-tools", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
    async run(mode, fn) { try { const db = await idb.open(); return await new Promise((res, rej) => { const q = fn(db.transaction("kv", mode).objectStore("kv")); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (_) { return undefined; } },
    get: k => idb.run("readonly", s => s.get(k)),
    set: (k, v) => idb.run("readwrite", s => s.put(v, k)),
    del: k => idb.run("readwrite", s => s.delete(k)),
  };

  /* Collect schema files from a drop (including dropped folders). */
  async function filesFromDrop(dt) {
    const entries = [...dt.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);   // must be read synchronously
    if (!entries.length) return [...dt.files];
    const out = [];
    const walk = async e => {
      if (e.isFile) out.push(await new Promise((res, rej) => e.file(res, rej)));
      else if (e.isDirectory) { const r = e.createReader(); let batch; do { batch = await new Promise((res, rej) => r.readEntries(res, rej)); for (const c of batch) await walk(c); } while (batch.length); }
    };
    for (const e of entries) await walk(e);
    return out;
  }
  const pickSchemaFiles = files => {
    const xsd = files.filter(f => /\.xsd$/i.test(f.name));
    return xsd.length ? xsd : files.filter(f => /\.xml$/i.test(f.name));
  };

  const KIND_LABEL = { element: "message", type: "type", member: "member", value: "value" };
  const CAT_LABEL = { msgtype: "msg type", data: "data", enum: "enum", id: "id", choice: "choice", base: "base", complex: "complex", simple: "simple" };
  const TABS_COMPLEX = [["members", "Members"], ["diagram", "Diagram"], ["structure", "Structure"], ["usedby", "Used by"], ["sample", "Sample XML"]];
  const TABS_SIMPLE = [["values", "Values & facets"], ["usedby", "Used by"], ["sample", "Sample value"]];
  const short = (s, n = 140) => { const t = (s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

  DT.register({
    id: "xsd", name: "XSD Schema Explorer & Validator", group: "XML & Mission Systems",
    desc: "Load a whole schema release (for example the UCI .xsd files), then search it, browse messages and types with their documentation, trace where things are used, generate valid sample messages and validate XML messages against it. Files stay in your browser.",
    keywords: "xsd schema uci oms ams gra types enumeration facets elements complexType simpleType explorer message definition validate validator sample skeleton used by search",
    render(root) {
      root.innerHTML = `
        <div class="tabs" role="tablist" id="main-tabs">
          <button class="tab on" type="button" data-view="explore" role="tab">Explore</button>
          <button class="tab" type="button" data-view="validate" role="tab">Validate</button>
          <button class="tab" type="button" data-view="schema" role="tab">Schema info</button>
        </div>
        <div class="drop" id="drop">
          <div class="opts" style="margin:0">
            <label class="btn">Choose .xsd files<input type="file" id="files" multiple accept=".xsd,.xml" hidden></label>
            <label class="btn">Choose folder<input type="file" id="dir" webkitdirectory hidden></label>
            <label title="Keeps the schema text in this browser's local storage so you don't have to reload it"><input type="checkbox" id="remember" checked> remember in this browser</label>
            <button class="btn" id="forget" type="button" hidden>Forget saved schema</button>
            <span class="hint">…or drop files or a folder here. Select every .xsd of the set at once so includes resolve.</span>
          </div>
        </div>
        <div class="opts" style="margin:6px 0"><div class="status" id="st" role="status" style="margin:0;flex:1 1 300px"></div><button class="btn" id="chg" type="button" hidden>Load different files…</button></div>
        <div id="view-explore">
          <div class="xg">
            <div class="left">
              <input type="search" id="q" class="mono" placeholder="Search: orbit regime, Latitude, MessageHeader…" aria-label="Search schema" autocomplete="off" disabled>
              <div class="opts" style="margin:0"><label>Match <select id="scope" class="mono"><option value="names">names</option><option value="docs">names + documentation</option></select></label></div>
              <div class="chip-row" id="kinds"></div>
              <div class="opts" style="margin:0" id="catrow" hidden><label>Type category <select id="cat" class="mono"></select></label></div>
              <div class="chip-row" id="families"></div>
              <div class="hint" id="count"></div>
              <div class="reslist" id="results"></div>
            </div>
            <div id="detail"><div class="hint">Load a schema to begin.</div></div>
          </div>
        </div>
        <div id="view-validate" hidden>
          <div class="opts"><label>Message <input type="text" id="vmsg" class="mono" list="vmsgs" placeholder="type a message name" style="width:300px"></label><datalist id="vmsgs"></datalist>
            <button class="btn" id="vload" type="button">Load sample</button>
            <label class="btn">Open .xml file<input type="file" id="vfile" accept=".xml,.txt" hidden></label>
            <button class="btn primary" id="vrun" type="button">Validate</button>
            <label><input type="checkbox" id="vlive" checked> validate as I type</label></div>
          <div class="two" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)">
            <div class="col"><label class="l" for="vin">XML message</label><textarea id="vin" spellcheck="false" placeholder="Paste an XML message here"></textarea></div>
            <div class="col"><label class="l">Result</label><div id="vsum" class="status"></div><div class="chip-row" id="vkinds"></div><div class="tscroll errlist" id="verrs" style="max-height:60vh"></div></div>
          </div>
        </div>
        <div id="view-schema" hidden></div>`;
      const $ = s => root.querySelector(s);
      const S = { model: null, index: null, files: [], cur: null, hist: [], hi: -1, tab: "members", kinds: "all", family: "", shown: 250, vKind: null };

      /* ============================ loading ============================ */
      const tick = () => new Promise(r => setTimeout(r, 25));
      async function load(files, { save = true, restored = false } = {}) {
        DT.status($("#st"), "", `Parsing ${files.length} file${files.length === 1 ? "" : "s"}…`);
        await tick();
        try {
          const t0 = performance.now();
          S.model = lib.xsdModel(files);
          S.index = lib.xsdIndex(S.model);
          S.files = files; S.cur = null; S.hist = []; S.hi = -1; S.shown = 250; S.family = ""; S.kinds = "all";
          const sm = lib.xsdSummary(S.model), probs = S.model.problems.filter(p => p.level === "error").length, warns = S.model.problems.length - probs;
          const ms = Math.round(performance.now() - t0);
          const missing = S.model.problems.filter(p => /^missing-/.test(p.kind)).map(p => p.message.replace(/^.*?"([^"]+)".*$/, "$1"));
          DT.status($("#st"), probs || missing.length ? "warn" : "ok", `${restored ? "Restored from this browser: " : ""}${S.model.files.length} file${S.model.files.length === 1 ? "" : "s"} · ${sm.elements.toLocaleString()} elements (messages) · ${sm.types.toLocaleString()} types (${sm.complex.toLocaleString()} complex, ${sm.simple.toLocaleString()} simple, ${sm.enums.toLocaleString()} enumerations) · ${probs} error${probs === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"} · ${ms} ms${missing.length ? ` · NOT LOADED: ${[...new Set(missing)].join(", ")}. Add ${missing.length === 1 ? "it" : "them"} (select all the files together) to clear the unresolved-type errors.` : ""}`);
          $("#q").disabled = false;
          const sel = $("#cat"); sel.innerHTML = `<option value="">all types</option>` + Object.entries(lib.xsdCategoryLabels).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
          $("#vmsgs").innerHTML = [...S.model.elements.keys()].sort().map(n => `<option value="${esc(n)}">`).join("");
          $("#drop").hidden = true; $("#chg").hidden = false;                      // once loaded, the picker folds away to give the explorer the room
          renderKinds(); renderResults(); renderDetail(); renderSchema(); runValidate(true);
          if (save && $("#remember").checked) { await idb.set("xsd-set", { files, saved: Date.now() }); $("#forget").hidden = false; }
        } catch (e) { DT.status($("#st"), "err", e.message); $("#drop").hidden = false; }
      }
      $("#chg").onclick = () => { $("#drop").hidden = !$("#drop").hidden; };
      async function loadFileList(list) {
        const picked = pickSchemaFiles([...list]);
        if (!picked.length) return DT.status($("#st"), "err", "No .xsd files found in that selection.");
        const files = await Promise.all(picked.map(async f => ({ name: f.name, text: await f.text() })));
        await load(files);
      }
      $("#files").onchange = e => loadFileList(e.target.files);
      $("#dir").onchange = e => loadFileList(e.target.files);
      const drop = $("#drop");
      ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
      ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
      drop.addEventListener("drop", async e => { await loadFileList(await filesFromDrop(e.dataTransfer)); });
      $("#forget").onclick = async () => { await idb.del("xsd-set"); $("#forget").hidden = true; DT.status($("#st"), "", "Saved schema forgotten. The loaded schema stays until you leave this page."); };
      idb.get("xsd-set").then(v => { if (v && v.files && v.files.length) { $("#forget").hidden = false; load(v.files, { save: false, restored: true }); } });

      /* ============================ explore: search ============================ */
      const KINDS = [["all", "All"], ["element", "Messages"], ["type", "Types"], ["member", "Members"], ["value", "Enum values"]];
      function renderKinds() {
        $("#kinds").innerHTML = KINDS.map(([k, l]) => `<span class="chip" data-kind="${k}" style="${S.kinds === k ? "color:var(--accent);border-color:var(--accent)" : ""}">${l}</span>`).join("");
        $("#catrow").hidden = !(S.kinds === "type");
        const fam = $("#families");
        if (S.kinds === "element" && S.model) {
          const counts = new Map(); for (const n of S.model.elements.keys()) { const f = lib.xsdFamily(n); counts.set(f, (counts.get(f) || 0) + 1); }
          const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14);
          fam.innerHTML = `<span class="chip" data-family="" style="${!S.family ? "color:var(--accent);border-color:var(--accent)" : ""}">any</span>` + top.map(([f, n]) => `<span class="chip" data-family="${esc(f)}" style="${S.family === f ? "color:var(--accent);border-color:var(--accent)" : ""}">…${esc(f)} <small>${n}</small></span>`).join("");
        } else fam.innerHTML = "";
      }
      function renderResults() {
        if (!S.model) return;
        const q = $("#q").value.trim();
        const kinds = S.kinds === "all" ? (q ? new Set(["element", "type", "member", "value"]) : new Set(["element"])) : new Set([S.kinds]);   // nothing typed: browse the messages
        const cat = S.kinds === "type" ? $("#cat").value || null : null;
        const filter = S.family ? e => e.kind !== "element" || lib.xsdFamily(e.name) === S.family : null;
        const { results, total } = lib.xsdSearch(S.index, q, { docs: $("#scope").value === "docs", kinds, cat, filter, limit: S.shown });
        $("#count").textContent = `${total.toLocaleString()} match${total === 1 ? "" : "es"}${total > results.length ? ` · showing ${results.length}` : ""}${!q && S.kinds === "all" ? " messages · type to search everything, including types, members and enum values" : ""}`;
        const cur = S.cur;
        $("#results").innerHTML = results.map(e => {
          const kcls = e.kind === "element" ? "message" : e.kind === "type" ? e.cat : e.kind;
          const label = e.kind === "type" ? CAT_LABEL[e.cat] : KIND_LABEL[e.kind];
          const sub = e.kind === "member" ? `${e.owner} : ${e.type}` : e.kind === "value" ? `in ${e.owner}` : e.kind === "element" ? e.type : "";
          const goto = e.kind === "member" || e.kind === "value" ? `${e.kind}:${e.owner}|${e.name}` : `${e.kind}:${e.name}`;
          const on = cur && cur.key === goto ? " on" : "";
          return `<div class="res${on}" data-go="${esc(goto)}" title="${esc(sub)}"><span class="kb k-${kcls}">${label}</span><b>${esc(e.name)}</b><span class="sub">${esc(sub)}</span></div>`;
        }).join("") + (total > results.length ? `<div class="res" data-more="1" style="justify-content:center;color:var(--accent)">show more…</div>` : "") || `<div class="hint" style="padding:12px">Nothing matches.</div>`;
      }
      $("#q").addEventListener("input", DT.debounce(() => { S.shown = 250; renderResults(); }, 120));
      $("#scope").onchange = $("#cat").onchange = () => { S.shown = 250; renderResults(); };
      $("#kinds").addEventListener("click", e => { const c = e.target.closest("[data-kind]"); if (!c) return; S.kinds = c.dataset.kind; S.family = ""; S.shown = 250; renderKinds(); renderResults(); });
      $("#families").addEventListener("click", e => { const c = e.target.closest("[data-family]"); if (!c) return; S.family = c.dataset.family; S.shown = 250; renderKinds(); renderResults(); });

      /* ============================ explore: navigation ============================ */
      function parseGo(s) { const i = s.indexOf(":"), kind = s.slice(0, i), rest = s.slice(i + 1), [a, b] = rest.split("|"); return { kind, a, b, key: s }; }
      function go(s, { push = true, tab } = {}) {
        const t = parseGo(s), m = S.model; if (!m) return;
        let cur = t;
        if (t.kind === "member") { cur = { kind: "type", a: t.a, key: "type:" + t.a, highlight: t.b }; tab = tab || "members"; }
        else if (t.kind === "value") { cur = { kind: "type", a: t.a, key: "type:" + t.a, filterValue: t.b }; tab = tab || "values"; }
        if (cur.kind === "element" && !m.elements.has(cur.a)) return;
        if (cur.kind === "type" && !m.types.has(cur.a)) return;
        if (tab) S.tab = tab;
        else if (cur.kind === "element") S.tab = "diagram";                                   // a message opens on its composition picture
        else { const ty = m.types.get(cur.a); S.tab = ty && ty.kind === "simple" ? "values" : (["members", "diagram", "structure", "usedby", "sample"].includes(S.tab) ? S.tab : "members"); }
        if (S.cur && S.cur.key === cur.key && !cur.highlight && !cur.filterValue) { renderDetail(); return; }
        S.cur = { ...cur, key: s };
        if (push) { S.hist = S.hist.slice(0, S.hi + 1); S.hist.push({ s, tab: S.tab }); S.hi = S.hist.length - 1; }
        $("#view-explore").hidden = false; showView("explore");
        renderDetail(); renderResults();
      }
      const back = d => { const i = S.hi + d; if (i < 0 || i >= S.hist.length) return; S.hi = i; const h = S.hist[i]; go(h.s, { push: false, tab: h.tab }); };

      function typeLink(name) {
        if (!name) return `<span class="hint">(none)</span>`;
        if (S.model.types.has(name)) return `<a class="go" data-go="type:${esc(name)}">${esc(name)}</a>`;
        return `<span class="hint" title="XML Schema built-in type">${esc(name)}</span>`;
      }
      const occ = m => m.min === 1 && m.max === 1 ? "1" : lib.xsdFmtOccurs(m.min, m.max);

      /* ============================ explore: detail ============================ */
      function renderDetail() {
        const m = S.model, d = $("#detail");
        if (!m) return;
        if (!S.cur) {
          const sm = lib.xsdSummary(m);
          d.innerHTML = `<div class="panel"><h3 style="margin:0 0 8px">${sm.elements.toLocaleString()} messages and ${sm.types.toLocaleString()} types loaded</h3><p class="hint" style="margin:0 0 10px">Pick a message or type on the left, or search for any name, member, enumeration value (or phrase in the documentation, with “names + documentation”).</p>
            <p style="margin:0 0 6px">Start from a message: <span class="hint">choose “Messages” and a family chip such as <b>…Status</b> or <b>…Command</b>.</span></p>
            <ul class="hint" style="margin:0;padding-left:18px"><li><b>Members</b> shows every field including inherited ones, with its documentation.</li><li><b>Structure</b> is an expandable tree of the whole message; copy it as an outline or as a flat list of paths for mapping.</li><li><b>Used by</b> answers “which messages contain this enumeration or type?”.</li><li><b>Sample XML</b> generates a schema-valid message; <b>Validate</b> checks your own XML.</li></ul></div>`;
          return;
        }
        const c = S.cur;
        const el = c.kind === "element" ? m.elements.get(c.a) : null;
        const typeName = el ? el.type : c.a, t = m.types.get(typeName);
        const entity = el || t;
        const cat = t ? lib.xsdCategory(m, t) : "";
        const file = entity && entity.file;
        const chain = t ? lib.xsdChain(m, typeName).slice(0, -1).map(x => x.name) : [];
        const tabs = !t ? [] : (t.kind === "simple" || t.simpleContent ? TABS_SIMPLE : TABS_COMPLEX);
        if (!tabs.some(([k]) => k === S.tab)) S.tab = tabs[0] ? tabs[0][0] : "members";
        const doc = (el && el.doc) || (t && t.doc) || "";
        d.innerHTML = `
          <div class="dhead">
            <button class="navb" type="button" data-nav="-1" ${S.hi > 0 ? "" : "disabled"} title="Back">←</button><button class="navb" type="button" data-nav="1" ${S.hi < S.hist.length - 1 ? "" : "disabled"} title="Forward">→</button>
            <h2>${el ? `&lt;${esc(el.name)}&gt;` : esc(t ? t.name : c.a)}</h2>
            <span class="kb k-${el ? "message" : cat}">${el ? "message" : (CAT_LABEL[cat] || "type")}</span>
          </div>
          <div class="meta">
            ${el ? `<span>type ${typeLink(el.type)}</span>` : ""}
            ${t && t.base ? `<span>${esc(t.derivation || "based on")} ${typeLink(t.base)}</span>` : ""}
            ${t && t.abstract ? `<span class="warnc">abstract</span>` : ""}
            ${entity && entity.version ? `<span title="uci:version (structural version of this component)">version ${esc(entity.version)}</span>` : ""}
            ${file ? `<span title="defined in">${esc(file)}</span>` : ""}
            ${chain.length ? `<span title="inheritance chain">${chain.map(n => typeLink(n)).join(" → ")} → …</span>` : ""}
          </div>
          ${doc ? `<div class="doc-block${doc.length > 260 ? " clamp" : ""}" title="${doc.length > 260 ? "click to read all" : ""}">${esc(doc)}</div>` : ""}
          <div class="tabs" id="dtabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? "on" : ""}" type="button" data-tab="${k}">${l}</button>`).join("")}</div>
          <div id="tabbody"></div>`;
        if (!t) { $("#tabbody").innerHTML = `<div class="hint">Type "${esc(typeName)}" is built in or defined in a file you have not loaded.</div>`; return; }
        const body = $("#tabbody");
        ({ members: tabMembers, diagram: tabDiagram, structure: tabStructure, usedby: tabUsedBy, sample: tabSample, values: tabValues }[S.tab])(body, t, el);
      }

      /* ---- Diagram: the composition of a message or type as a graph (see xsd-diagram.js) ---- */
      function tabDiagram(body, t, el) {
        const rootName = el ? el.name : t.name, key = rootName + ":" + t.name;
        const st = (S.diagrams = S.diagrams || {})[key] || (S.diagrams[key] = {});
        lib.xsdDiagramMount(body, { model: S.model, typeName: t.name, rootName, state: st, open: name => go("type:" + name) });
      }

      /* ---- Members ---- */
      function tabMembers(body, t, el) {
        const rows = lib.xsdMembers(S.model, t.name);
        if (!rows.length) { body.innerHTML = `<div class="hint">This type declares no members.</div>`; return; }
        const inherited = rows.filter(r => r.inherited).length;
        body.innerHTML = `
          <div class="opts" style="margin:0 0 8px"><input type="search" id="mf" class="mono" placeholder="Filter ${rows.length} members…" style="max-width:300px"><span class="hint">${rows.length} members${inherited ? ` (${inherited} inherited)` : ""}</span><button class="mini" id="mcopy" type="button">copy as TSV</button></div>
          <div class="tscroll"><table class="kv"><thead><tr><th>Member</th><th>Type</th><th>Occurs</th><th>Documentation</th></tr></thead><tbody id="mrows">${rows.map(r => `
            <tr data-m="${esc(r.name)}" data-s="${esc((r.name + " " + r.type + " " + (r.doc || "")).toLowerCase())}">
              <td class="v" style="white-space:nowrap"><b>${r.kind === "attribute" ? "@" : ""}${esc(r.name)}</b>${r.choice ? ` <span class="ch hint" title="one of ${r.choice.of} alternatives">choice ${r.choice.alt}/${r.choice.of}</span>` : ""}${r.inherited ? ` <span class="hint" title="inherited from ${esc(r.from)}">↑ ${esc(r.from)}</span>` : ""}</td>
              <td class="v">${typeLink(r.type)}</td><td class="v">${occ(r)}${r.use === "required" ? " req" : ""}</td>
              <td style="font-size:12.5px;color:var(--muted)" title="${esc(r.doc || "")}">${esc(short(r.doc, 180))}</td></tr>`).join("")}</tbody></table></div>`;
        $("#mf").addEventListener("input", e => { const v = e.target.value.toLowerCase(); body.querySelectorAll("#mrows tr").forEach(tr => { tr.hidden = !!v && !tr.dataset.s.includes(v); }); });
        $("#mcopy").onclick = e => DT.copy(["Member\tType\tOccurs\tInherited from\tDocumentation", ...rows.map(r => [r.name, r.type, occ(r), r.inherited ? r.from : "", (r.doc || "").replace(/\s+/g, " ")].join("\t"))].join("\n"), e.target);
        if (S.cur.highlight) {
          const tr = [...body.querySelectorAll("#mrows tr")].find(x => x.dataset.m === S.cur.highlight);
          if (tr) { tr.classList.add("hl"); tr.scrollIntoView({ block: "center" }); setTimeout(() => tr.classList.remove("hl"), 2500); }
        }
      }

      /* ---- Structure tree ---- */
      function nodeHTML(m, anc, docs) {
        const t = S.model.types.get(m.type);
        const complex = t && t.kind === "complex" && !t.simpleContent;
        const hasEnum = t && t.facets && t.facets.enumeration;
        const recursive = anc.includes(m.type);
        const expandable = !recursive && ((complex && (lib.xsdMembers(S.model, m.type).length > 0)) || hasEnum);
        const glyph = recursive ? "↺" : expandable ? "▸" : "·";
        return `<div class="tn" data-type="${esc(m.type)}" data-anc="${esc(anc.join(","))}">
          <div class="tr"><span class="tg ${expandable ? "" : "off"}" ${expandable ? 'data-toggle="1"' : ""}>${glyph}</span>${m.choice ? `<span class="ch" title="one of ${m.choice.of}">│</span>` : ""}<span class="nm">${m.kind === "attribute" ? "@" : ""}${esc(m.name)}</span><span class="oc">${m.min === 1 && m.max === 1 ? "" : `[${lib.xsdFmtOccurs(m.min, m.max)}]`}</span><span class="ty">: ${typeLink(m.type)}</span>${m.inherited ? `<span class="ty" title="inherited from ${esc(m.from)}">↑</span>` : ""}${docs && m.doc ? `<span class="dc" title="${esc(m.doc)}">${esc(short(m.doc, 110))}</span>` : ""}</div>
          <div class="kids" hidden></div></div>`;
      }
      function fillNode(node, docs) {
        const kids = node.querySelector(":scope > .kids"); if (kids.dataset.done) return kids;
        const tn = node.dataset.type, anc = (node.dataset.anc ? node.dataset.anc.split(",") : []).concat(tn), t = S.model.types.get(tn);
        if (t && t.kind === "complex" && !t.simpleContent) kids.innerHTML = lib.xsdMembers(S.model, tn).filter(m => m.kind !== "group" && m.kind !== "any").map(m => nodeHTML(m, anc, docs)).join("");
        else if (t && t.facets.enumeration) {
          const en = t.facets.enumeration;
          kids.innerHTML = en.slice(0, 200).map(v => `<div class="tr"><span class="tg off">·</span><span class="nm" style="color:#d2a8ff">${esc(v.value)}</span>${docs && v.doc ? `<span class="dc" title="${esc(v.doc)}">${esc(short(v.doc, 110))}</span>` : ""}</div>`).join("") + (en.length > 200 ? `<div class="hint">… ${en.length - 200} more (open the type to see all)</div>` : "");
        }
        kids.dataset.done = "1"; return kids;
      }
      function expandDeep(node, depth, docs, budget) {
        if (depth <= 0 || budget.n <= 0) return;
        const tg = node.querySelector(":scope > .tr > .tg[data-toggle]"); if (!tg) return;
        const kids = fillNode(node, docs); kids.hidden = false; tg.textContent = "▾";
        for (const c of kids.querySelectorAll(":scope > .tn")) { budget.n--; expandDeep(c, depth - 1, docs, budget); }
      }
      function tabStructure(body, t, el) {
        const rootName = el ? el.name : t.name;
        body.innerHTML = `
          <div class="opts" style="margin:0 0 8px">
            <label>Expand to depth <select id="sdepth" class="mono">${[1, 2, 3, 4, 5, 6, 8, 10].map(d => `<option ${d === 3 ? "selected" : ""}>${d}</option>`).join("")}</select></label>
            <button class="btn" id="sexp" type="button">Expand</button><button class="btn" id="scol" type="button">Collapse</button>
            <label><input type="checkbox" id="sdocs" checked> show documentation</label>
            <button class="mini" id="scopy" type="button">copy outline</button><button class="mini" id="spaths" type="button">copy paths</button><button class="mini" id="sleaves" type="button">copy leaf paths</button>
          </div>
          <div class="hint" id="snote" style="margin-bottom:6px"></div>
          <div class="tree" id="tree"></div>`;
        const tree = $("#tree"), docs = () => $("#sdocs").checked;
        const draw = () => {
          tree.innerHTML = `<div class="tn" data-type="${esc(t.name)}" data-anc=""><div class="tr"><span class="tg" data-toggle="1">▾</span><span class="nm">${esc(rootName)}</span><span class="ty">: ${esc(t.name)}</span></div><div class="kids"></div></div>`;
          const node = tree.firstElementChild; fillNode(node, docs()); node.querySelector(":scope > .kids").hidden = false;
        };
        draw();
        $("#sdocs").onchange = draw;
        $("#sexp").onclick = () => { draw(); const budget = { n: 4000 }; for (const c of tree.querySelectorAll(":scope > .tn > .kids > .tn")) { budget.n--; expandDeep(c, +$("#sdepth").value - 1, docs(), budget); } $("#snote").textContent = budget.n <= 0 ? "Expansion stopped after about 4,000 nodes; expand deeper branches individually." : ""; };
        $("#scol").onclick = draw;
        tree.addEventListener("click", e => {
          const tg = e.target.closest(".tg[data-toggle]"); if (!tg) return;
          const node = tg.closest(".tn"), kids = fillNode(node, docs());
          kids.hidden = !kids.hidden; tg.textContent = kids.hidden ? "▸" : "▾";
        });
        $("#scopy").onclick = e => DT.copy([`${rootName} : ${t.name}`, ...lib.xsdTree(S.model, t.name, +$("#sdepth").value, { docs: docs() })].join("\n"), e.target);
        const paths = (leavesOnly, btn) => { const p = lib.xsdPaths(S.model, t.name, rootName, { maxDepth: Math.max(+$("#sdepth").value, 6) }); const rows = (leavesOnly ? p.filter(x => x.leaf) : p); DT.copy(rows.map(x => `${x.path}\t${x.type}\t${occ(x)}`).join("\n"), btn); $("#snote").textContent = `Copied ${rows.length.toLocaleString()} ${leavesOnly ? "leaf " : ""}paths (path, type, occurs)${p.truncated ? " — truncated at 20,000" : ""}.`; };
        $("#spaths").onclick = e => paths(false, e.target); $("#sleaves").onclick = e => paths(true, e.target);
      }

      /* ---- Used by ---- */
      function tabUsedBy(body, t, el) {
        const m = S.model, name = t.name;
        const members = (m.usedBy.get(name) || []).filter(u => u.kind === "element" || u.kind === "attribute" || u.kind === "list" || u.kind === "union");
        const derived = m.derived.get(name) || [];
        const msgs = lib.xsdMessagesUsing(m, name, 2000);
        const deps = lib.xsdDependencies(m, name);
        const list = (items, f, cap = 300) => items.slice(0, cap).map(f).join("") + (items.length > cap ? `<div class="hint">… ${items.length - cap} more</div>` : "");
        body.innerHTML = `
          ${el ? `<div class="panel"><b>${esc(el.name)}</b> is a message of type ${typeLink(el.type)}.</div>` : ""}
          <div class="panel"><div class="lbl" style="margin-bottom:6px">Used as a member type in (${members.length})</div>
            ${members.length ? `<div class="tscroll" style="max-height:240px"><table class="kv"><tbody>${list(members, u => `<tr><td class="v">${typeLink(u.owner)}</td><td class="v"><a class="go" data-go="member:${esc(u.owner)}|${esc(u.member)}">${esc(u.member)}</a></td></tr>`)}</tbody></table></div>` : `<span class="hint">Not used as a member anywhere.</span>`}</div>
          <div class="panel"><div class="lbl" style="margin-bottom:6px">Extended or restricted by (${derived.length})</div>
            ${derived.length ? `<div class="chip-row">${list(derived, n => `<a class="chip go" data-go="type:${esc(n)}">${esc(n)}</a>`)}</div>` : `<span class="hint">No derived types.</span>`}</div>
          <div class="panel"><div class="lbl" style="margin-bottom:6px">Appears in ${msgs.length.toLocaleString()} message${msgs.length === 1 ? "" : "s"}${msgs.length >= 2000 ? "+" : ""}</div>
            ${msgs.length ? `<div class="opts" style="margin:0 0 6px"><button class="mini" id="mcp" type="button">copy list</button></div><div class="chip-row" style="max-height:260px;overflow:auto">${list(msgs, n => `<a class="chip go" data-go="element:${esc(n)}">${esc(n)}</a>`, 500)}</div>` : `<span class="hint">Not reachable from any message.</span>`}</div>
          <details class="panel"><summary class="lbl" style="cursor:pointer">Built from ${deps.length.toLocaleString()} other type${deps.length === 1 ? "" : "s"}</summary>
            <div class="chip-row" style="margin-top:8px;max-height:240px;overflow:auto">${list(deps, n => `<a class="chip go" data-go="type:${esc(n)}">${esc(n)}</a>`, 600)}</div></details>`;
        const b = $("#mcp"); if (b) b.onclick = () => DT.copy(msgs.join("\n"), b);
      }

      /* ---- Values & facets (simple types) ---- */
      function tabValues(body, t) {
        const info = lib.xsdSimpleInfo(S.model, t.name), f = Object.entries(info.facets || {});
        const en = (t.facets && t.facets.enumeration) || (info.enumeration ? info.enumeration.map(v => ({ value: v, doc: "" })) : []);
        const sampleV = (() => { try { return lib.xsdSampleValue(S.model, info); } catch (_) { return ""; } })();
        body.innerHTML = `
          <div class="panel">${DT.kv([["Resolves to", info.builtin + (info.list ? ` list of ${info.list.builtin}` : "")], ...f.map(([k, v]) => [k, String(v)]), ...info.patterns.flat().map((p, i) => ["pattern", p]), ["Sample value", sampleV]])}</div>
          ${en.length ? `<div class="opts" style="margin:0 0 6px"><input type="search" id="vf" class="mono" placeholder="Filter ${en.length} values…" style="max-width:260px" value="${esc(S.cur.filterValue || "")}"><span class="hint" id="vcnt"></span><button class="mini" id="vcp" type="button">copy values</button><button class="mini" id="vcp2" type="button">copy value + doc (TSV)</button></div>
            <div class="tscroll"><table class="kv"><thead><tr><th>Value</th><th>Documentation</th></tr></thead><tbody id="vrows">${en.map(v => `<tr data-s="${esc((v.value + " " + (v.doc || "")).toLowerCase())}"><td class="v" style="white-space:nowrap">${esc(v.value)}</td><td style="font-size:12.5px;color:var(--muted)">${esc(v.doc || "")}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
        if (en.length) {
          const apply = () => { const v = $("#vf").value.toLowerCase(); let n = 0; body.querySelectorAll("#vrows tr").forEach(tr => { const ok = !v || tr.dataset.s.includes(v); tr.hidden = !ok; if (ok) n++; }); $("#vcnt").textContent = `${n} of ${en.length}`; };
          $("#vf").addEventListener("input", apply); apply();
          $("#vcp").onclick = e => DT.copy(en.map(v => v.value).join("\n"), e.target);
          $("#vcp2").onclick = e => DT.copy(en.map(v => `${v.value}\t${(v.doc || "").replace(/\s+/g, " ")}`).join("\n"), e.target);
        }
      }

      /* ---- Sample ---- */
      function tabSample(body, t, el) {
        const simple = t.kind === "simple" || t.simpleContent;
        if (simple && !el) { const v = lib.xsdSampleValue(S.model, lib.xsdSimpleInfo(S.model, t.name)); body.innerHTML = `<div class="panel">${DT.kv([["A valid value", v]])}</div>`; return; }
        body.innerHTML = `
          <div class="opts" style="margin:0 0 8px">
            <label>Include <select id="sall" class="mono"><option value="req">required elements only</option><option value="all">all elements (first choice branch)</option></select></label>
            <label><input type="checkbox" id="shint" checked> hint comments</label>
            <label>Max depth <input type="number" id="sdep" value="10" min="1" max="30" style="width:70px"></label>
            <button class="btn primary" id="sgen" type="button">Generate</button>
            <button class="btn" id="scp" type="button">Copy</button><button class="btn" id="sdl" type="button">Download</button><button class="btn" id="sval" type="button">Validate this</button>
          </div>
          <div class="status" id="sst"></div>
          <textarea id="sout" readonly spellcheck="false" style="min-height:360px"></textarea>`;
        const target = el ? el.name : t.name;
        const gen = () => {
          try {
            const r = lib.xsdSkeleton(S.model, target, { all: $("#sall").value === "all", hints: $("#shint").checked, maxDepth: +$("#sdep").value || 10 });
            $("#sout").value = r.xml;
            DT.status($("#sst"), r.warnings.length ? "warn" : "ok", `${r.elements.toLocaleString()} elements${r.warnings.length ? ` · ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}: ${r.warnings[0]}` : ""}${t.abstract ? " · abstract type: a concrete subtype was chosen with xsi:type" : ""}`);
          } catch (e) { $("#sout").value = ""; DT.status($("#sst"), "err", e.message); }
        };
        $("#sgen").onclick = gen; ["#sall", "#shint", "#sdep"].forEach(s => $(s).onchange = gen); gen();
        $("#scp").onclick = e => DT.copy($("#sout").value, e.target);
        $("#sdl").onclick = () => DT.download(`${target}.xml`, $("#sout").value, "application/xml");
        $("#sval").onclick = () => { $("#vin").value = $("#sout").value; showView("validate"); runValidate(); };
      }

      /* ============================ validate ============================ */
      function runValidate(silent) {
        const text = $("#vin").value;
        if (!S.model) { $("#vsum").className = "status"; $("#vsum").textContent = "Load a schema first."; $("#verrs").innerHTML = ""; return; }
        if (!text.trim()) { $("#vsum").className = "status"; $("#vsum").textContent = silent ? "" : "Paste an XML message to validate."; $("#verrs").innerHTML = ""; $("#vkinds").innerHTML = ""; return; }
        const t0 = performance.now(), r = lib.xsdValidate(S.model, text, { maxErrors: 300 });
        const ms = Math.round(performance.now() - t0);
        S.vResult = r;
        const kinds = {}; r.errors.forEach(e => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
        $("#vsum").className = "status " + (r.ok ? "ok" : "err");
        $("#vsum").textContent = r.ok ? `✔ Valid · <${r.root}> · ${r.elements.toLocaleString()} elements checked · ${ms} ms${r.warnings.length ? ` · ${r.warnings.length} note${r.warnings.length === 1 ? "" : "s"}` : ""}` : `✖ ${r.errors.length}${r.truncated ? "+" : ""} error${r.errors.length === 1 ? "" : "s"} · ${r.elements.toLocaleString()} elements checked · ${ms} ms`;
        $("#vkinds").innerHTML = Object.entries(kinds).map(([k, n]) => `<button class="pill ${S.vKind && S.vKind !== k ? "off" : ""}" type="button" data-vkind="${k}">${k} ${n}</button>`).join("");
        const shown = r.errors.filter(e => !S.vKind || e.kind === S.vKind);
        $("#verrs").innerHTML = shown.map((e, i) => `<div class="er" data-i="${r.errors.indexOf(e)}"><span class="ln">${e.line ? `${e.line}:${e.col}` : ""}</span><span class="ms">${esc(e.message)}</span>${e.path ? `<span class="pa">${esc(e.path)}</span>` : ""}</div>`).join("")
          + r.warnings.map(w => `<div class="er" style="cursor:default"><span class="ln warnc">note</span><span class="ms">${esc(w)}</span></div>`).join("")
          + (r.ok && !r.warnings.length ? `<div class="hint" style="padding:12px">No problems found. Checked against the loaded schema; for formal conformance also run xmllint or .NET (see the XML cheat sheet).</div>` : "");
      }
      $("#vrun").onclick = () => runValidate();
      $("#vin").addEventListener("input", DT.debounce(() => { if ($("#vlive").checked) runValidate(true); }, 350));
      $("#vkinds").addEventListener("click", e => { const b = e.target.closest("[data-vkind]"); if (!b) return; S.vKind = S.vKind === b.dataset.vkind ? null : b.dataset.vkind; runValidate(true); });
      $("#verrs").addEventListener("click", e => {
        const row = e.target.closest(".er[data-i]"); if (!row || !S.vResult) return;
        const er = S.vResult.errors[+row.dataset.i], ta = $("#vin"), lines = ta.value.split("\n");
        if (!er.line) return;
        const start = lines.slice(0, er.line - 1).reduce((a, l) => a + l.length + 1, 0);
        ta.focus(); ta.setSelectionRange(start, start + (lines[er.line - 1] || "").length);
        ta.scrollTop = Math.max(0, (er.line - 4) * 19.5);
      });
      $("#vload").onclick = () => {
        const n = $("#vmsg").value.trim();
        if (!S.model) return DT.status($("#vsum"), "err", "Load a schema first.");
        try { $("#vin").value = lib.xsdSkeleton(S.model, n, { hints: false }).xml; runValidate(); } catch (e) { DT.status($("#vsum"), "err", e.message); }
      };
      $("#vfile").onchange = async e => { const f = e.target.files[0]; if (f) { $("#vin").value = await f.text(); runValidate(); } };

      /* ============================ schema info ============================ */
      function renderSchema() {
        const m = S.model, v = $("#view-schema"); if (!m) return;
        const types = [...m.types.values()], cats = {};
        types.forEach(t => { const c = lib.xsdCategory(m, t); cats[c] = (cats[c] || 0) + 1; });
        const rank = p => /^missing-/.test(p.kind) ? 0 : p.level === "error" ? 1 : 2;           // root causes first, then the errors they cause
        const probs = [...m.problems].sort((a, b) => rank(a) - rank(b)), CAP = 200;
        v.innerHTML = `
          <div class="panel"><div class="lbl" style="margin-bottom:6px">Files</div>
            <div class="tscroll"><table class="kv"><thead><tr><th>File</th><th>Version</th><th>Namespace</th><th>Elements</th><th>Types</th><th>Size</th><th>Includes / imports</th></tr></thead><tbody>${m.files.map(f => `<tr><td class="v">${esc(f.name)}</td><td class="v">${esc(f.version)}</td><td class="v" style="font-size:11.5px">${esc(f.targetNamespace || "(none)")}</td><td class="v">${f.counts.elements.toLocaleString()}</td><td class="v">${f.counts.types.toLocaleString()}</td><td class="v">${(f.size / 1024).toFixed(0)} KB</td><td class="v" style="font-size:12px">${[...f.includes.map(i => `include ${i}`), ...f.imports.map(i => `import ${i.location || i.namespace}`)].map(esc).join("<br>") || "—"}</td></tr>`).join("")}</tbody></table></div></div>
          <div class="panel"><div class="lbl" style="margin-bottom:6px">Problems (${probs.length})</div>
            ${probs.length ? `<div class="tscroll errlist" style="max-height:260px">${probs.slice(0, CAP).map(p => `<div class="er" style="cursor:default"><span class="ln ${p.level === "error" ? "badc" : "warnc"}">${p.level}</span><span class="ms">${esc(p.message)}</span>${p.file ? `<span class="pa">${esc(p.file)}</span>` : ""}</div>`).join("")}${probs.length > CAP ? `<div class="hint" style="padding:10px">… and ${probs.length - CAP} more, usually caused by the first problem above.</div>` : ""}</div>` : `<span class="good">No problems: every type reference resolves and every include is loaded.</span>`}</div>
          <div class="panel"><div class="lbl" style="margin-bottom:6px">Contents</div>${DT.kv(Object.entries(lib.xsdCategoryLabels).map(([k, l]) => [l, String(cats[k] || 0)]).concat([["Messages (global elements)", String(m.elements.size)], ["Target namespace", m.targetNamespace || "(none)"], ["elementFormDefault", m.elementFormDefault]]))}</div>`;
      }

      /* ============================ shared events ============================ */
      function showView(v) {
        root.querySelectorAll("#main-tabs .tab").forEach(b => b.classList.toggle("on", b.dataset.view === v));
        for (const n of ["explore", "validate", "schema"]) $("#view-" + n).hidden = n !== v;
      }
      root.addEventListener("click", e => {
        const vt = e.target.closest("#main-tabs [data-view]"); if (vt) { showView(vt.dataset.view); return; }
        const db = e.target.closest(".doc-block"); if (db && db.title) { db.classList.toggle("clamp"); return; }
        const g = e.target.closest("[data-go]"); if (g) { e.preventDefault(); go(g.dataset.go); return; }
        const nv = e.target.closest("[data-nav]"); if (nv) { back(+nv.dataset.nav); return; }
        const tb = e.target.closest("#dtabs [data-tab]"); if (tb) { S.tab = tb.dataset.tab; if (S.hist[S.hi]) S.hist[S.hi].tab = S.tab; renderDetail(); return; }
        if (e.target.closest("[data-more]")) { S.shown += 500; renderResults(); }
      });
    },
  });
})();
