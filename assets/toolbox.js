/* Toolbox shell: registry, hash router, collapsible sidebar with search, shared helpers.
   Each tool file calls DT.register({ id, name, group, desc, keywords, render(root) }).
   Pure helpers a tool wants to test or reuse are exposed on DT.lib. */
(function () {
  const tools = [];
  const DT = (window.DT = {
    lib: {},
    register(t) { tools.push(t); },
    esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    debounce(fn, ms = 120) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },
    async copy(text, btn) {
      try { await navigator.clipboard.writeText(text); }
      catch (_) {
        const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (__) { /* ignore */ } ta.remove();
      }
      if (btn) { const o = btn.dataset.label || btn.textContent; btn.dataset.label = o; btn.textContent = "copied"; btn.classList.add("done"); setTimeout(() => { btn.textContent = o; btn.classList.remove("done"); }, 1100); }
    },
    download(name, text, type = "text/plain") {
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    /* Wire up common behaviours inside a tool root:
         [data-copy="#sel"]   copy value/text of the target
         [data-clear="#a,#b"] clear those fields (and fire input)
         [data-copytext]      copy the attribute's text */
    wire(root) {
      root.addEventListener("click", e => {
        const c = e.target.closest("[data-copy]");
        if (c) { const el = root.querySelector(c.dataset.copy); if (el) DT.copy("value" in el ? el.value : el.textContent, c); return; }
        const x = e.target.closest("[data-clear]");
        if (x) x.dataset.clear.split(",").forEach(s => { const el = root.querySelector(s.trim()); if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } });
        const k = e.target.closest("[data-copytext]");
        if (k) DT.copy(k.dataset.copytext, k);
      });
    },
    /* Set a status line. Only the status classes change, so other classes (and anything that selects by them) survive. */
    status(el, kind, msg) { el.classList.remove("ok", "err", "warn"); el.classList.add("status"); if (kind) el.classList.add(kind); el.textContent = msg || ""; },
    /* Key/value table whose values have a copy button. rows: [[key, value]] */
    kv(rows) {
      return `<table class="kv"><tbody>${rows.map(([k, v]) => `<tr><td class="k">${DT.esc(k)}</td><td class="v">${DT.esc(v)}</td><td class="cp"><button class="mini" type="button" data-copytext="${DT.esc(v)}">copy</button></td></tr>`).join("")}</tbody></table>`;
    },
  });

  /* Identifier-case helpers shared by the type generator and the case converter. */
  const L = DT.lib;
  L.words = s => String(s).replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  L.pascal = s => L.words(s).map(cap).join("");
  L.camel = s => { const w = L.words(s).map(x => x.toLowerCase()); return w.map((x, i) => i ? cap(x) : x).join(""); };
  L.snake = s => L.words(s).map(x => x.toLowerCase()).join("_");
  L.kebab = s => L.words(s).map(x => x.toLowerCase()).join("-");

  const GROUP_ORDER = ["Format & Validate", "Encode & Decode", "Translate", "Generate", "Time & Numbers", "Text", "Network & Security", "XML & Mission Systems"];

  function boot() {
    const side = document.getElementById("side"), main = document.getElementById("main");
    const byId = Object.fromEntries(tools.map(t => [t.id, t]));
    const groups = GROUP_ORDER.concat([...new Set(tools.map(t => t.group))].filter(g => !GROUP_ORDER.includes(g)));
    const sheets = (window.CATALOG && window.CATALOG.sheets) || [];
    const sheetGroups = [...new Set(sheets.map(s => s.group))];
    const link = (cls, href, id, name, s) => `<a class="${cls}" href="${href}" ${id ? `data-id="${id}"` : ""} data-s="${DT.esc(s.toLowerCase())}">${DT.esc(name)}</a>`;

    side.innerHTML = `<a class="brand" href="index.html"><span>&lt;/&gt;</span> dev-tools</a>
      <input id="tq" type="search" placeholder="Search tools & sheets…" aria-label="Search tools and sheets" autocomplete="off">
      <div class="mini-links"><button type="button" id="expandAll">expand all</button><button type="button" id="collapseAll">collapse all</button></div>
      <div id="tlist">
        ${groups.map(g => {
          const items = tools.filter(t => t.group === g);
          return items.length ? `<details class="grp" data-g="${DT.esc(g)}"><summary>${DT.esc(g)}<span class="n">${items.length}</span></summary>${items.map(t => link("t", "#" + t.id, t.id, t.name, t.name + " " + t.desc + " " + (t.keywords || ""))).join("")}</details>` : "";
        }).join("")}
        ${sheets.length ? `<details class="grp top" data-g="__sheets"><summary>Cheat sheets<span class="n">${sheets.length}</span></summary>${sheetGroups.map(g => {
          const items = sheets.filter(s => s.group === g);
          return `<details class="grp sub" data-g="sheets:${DT.esc(g)}"><summary>${DT.esc(g)}<span class="n">${items.length}</span></summary>${items.map(s => link("t sheet", "sheets/" + s.id + ".html", "", s.title, s.title + " " + s.blurb + " " + s.id)).join("")}</details>`;
        }).join("")}</details>` : ""}
      </div>`;

    const list = side.querySelector("#tlist");
    Groups.bind(list, "toolbox", false);

    function show() {
      const id = location.hash.slice(1);
      const t = byId[id] || tools[0];
      side.querySelectorAll("a.t[data-id]").forEach(a => a.classList.toggle("on", a.dataset.id === t.id));
      const active = side.querySelector(`a.t[data-id="${t.id}"]`);
      if (active && !side.querySelector("#tq").value) Groups.open(active);       // open the group you are in
      main.innerHTML = `<h1>${DT.esc(t.name)}</h1><p class="desc">${DT.esc(t.desc)}</p><div id="tool"></div>`;
      const root = document.getElementById("tool");
      DT.wire(root);
      try { t.render(root); } catch (e) { root.innerHTML = `<div class="status err">Tool failed to load: ${DT.esc(e.message)}</div>`; console.error(e); }
      document.title = t.name + " · dev-tools";
      window.scrollTo(0, 0);
    }
    window.addEventListener("hashchange", show);

    /* Search: open only groups that contain a match; restore the remembered state when cleared. */
    const q = side.querySelector("#tq");
    q.addEventListener("input", () => {
      const v = q.value.trim().toLowerCase();
      if (!v) {
        list.querySelectorAll("a.t, details.grp").forEach(el => { el.hidden = false; });
        Groups.restore(list, "toolbox", false);
        const active = list.querySelector("a.t.on"); if (active) Groups.open(active);
        return;
      }
      list.querySelectorAll("a.t").forEach(a => { a.hidden = !a.dataset.s.includes(v); });
      [...list.querySelectorAll("details.grp")].reverse().forEach(d => {      // innermost first
        const any = !!d.querySelector("a.t:not([hidden])");
        d.hidden = !any; Groups.set(d, any);
      });
    });
    side.querySelector("#expandAll").onclick = () => Groups.setAll(list, "toolbox", true);
    side.querySelector("#collapseAll").onclick = () => { Groups.setAll(list, "toolbox", false); const a = list.querySelector("a.t.on"); if (a) Groups.open(a); };
    show();
  }
  window.addEventListener("DOMContentLoaded", boot);
})();
