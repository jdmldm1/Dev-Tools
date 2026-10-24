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

  const GROUP_ORDER = ["UCI", "Format & Validate", "Encode & Decode", "Translate", "Generate", "Time & Numbers", "Text", "Network & Security", "XML & Mission Systems"];

  function boot() {
    const side = document.getElementById("side"), main = document.getElementById("main");
    const byId = Object.fromEntries(tools.map(t => [t.id, t]));
    const groups = GROUP_ORDER.concat([...new Set(tools.map(t => t.group))].filter(g => !GROUP_ORDER.includes(g)));
    const sheets = (window.CATALOG && window.CATALOG.sheets) || [];
    const sheetGroups = [...new Set(sheets.map(s => s.group))];
    const link = (cls, href, id, name, s, fav) => `<div class="trow" data-s="${DT.esc(s.toLowerCase())}"><a class="${cls}" href="${href}" ${id ? `data-id="${id}"` : ""}>${DT.esc(name)}</a><button class="star" type="button" data-fav="${fav}" aria-label="Favorite ${DT.esc(name)}" aria-pressed="false"></button></div>`;
    const toolRow = t => link("t", "#" + t.id, t.id, t.name, t.name + " " + t.desc + " " + (t.keywords || ""), "tool:" + t.id);
    const sheetRow = s => link("t sheet", "sheets/" + s.id + ".html", "", s.title, s.title + " " + s.blurb + " " + s.id, "sheet:" + s.id);

    side.innerHTML = `<a class="brand" href="index.html"><span>&lt;/&gt;</span> dev-tools</a>
      <input id="tq" type="search" placeholder="Search tools & sheets…" aria-label="Search tools and sheets" autocomplete="off">
      <div class="mini-links"><button type="button" id="expandAll">expand all</button><button type="button" id="collapseAll">collapse all</button></div>
      <div id="favs" class="favs" hidden><div class="favh">Favorites</div><div id="favlist"></div></div>
      <div id="tlist">
        <details class="grp top" data-g="__tools"><summary>Tools<span class="n">${tools.length}</span></summary>${groups.map(g => {
          const items = tools.filter(t => t.group === g);
          return items.length ? `<details class="grp sub" data-g="${DT.esc(g)}"><summary>${DT.esc(g)}<span class="n">${items.length}</span></summary>${items.map(toolRow).join("")}</details>` : "";
        }).join("")}</details>
        ${sheets.length ? `<details class="grp top" data-g="__sheets"><summary>Reference<span class="n">${sheets.length}</span></summary>${sheetGroups.map(g => {
          const items = sheets.filter(s => s.group === g);
          return `<details class="grp sub" data-g="sheets:${DT.esc(g)}"><summary>${DT.esc(g)}<span class="n">${items.length}</span></summary>${items.map(sheetRow).join("")}</details>`;
        }).join("")}</details>` : ""}
      </div>`;

    const list = side.querySelector("#tlist"), favBox = side.querySelector("#favs"), favList = side.querySelector("#favlist");
    Groups.bind(list, "toolbox", false);

    /* Favorites: a copy of each starred row, in the order they were starred, above the groups. */
    const byFav = new Map([...tools.map(t => ["tool:" + t.id, toolRow(t)]), ...sheets.map(s => ["sheet:" + s.id, sheetRow(s)])]);
    function renderFavs() {
      const ids = Favs.list().filter(id => byFav.has(id));
      favList.innerHTML = ids.map(id => byFav.get(id)).join("");
      favBox.hidden = !ids.length || !!side.querySelector("#tq").value.trim();
      Favs.sync(side); markActive();
    }
    function markActive() {
      const cur = location.hash.slice(1) || (tools[0] && tools[0].id);
      side.querySelectorAll("a.t[data-id]").forEach(a => a.classList.toggle("on", a.dataset.id === cur));
    }
    document.addEventListener("click", e => {
      const b = e.target.closest(".star[data-fav]"); if (!b) return;
      Favs.toggle(b.dataset.fav); renderFavs(); Favs.sync(document);
    });
    Favs.onChange(() => { renderFavs(); Favs.sync(document); });

    function show() {
      const id = location.hash.slice(1);
      const t = byId[id] || tools[0];
      side.querySelectorAll("a.t[data-id]").forEach(a => a.classList.toggle("on", a.dataset.id === t.id));
      const active = list.querySelector(`a.t[data-id="${t.id}"]`);
      if (active && !side.querySelector("#tq").value) Groups.open(active);       // open the group you are in
      main.innerHTML = `<h1>${DT.esc(t.name)} <button class="star" type="button" data-fav="tool:${t.id}" aria-label="Favorite ${DT.esc(t.name)}" aria-pressed="false"></button></h1><p class="desc">${DT.esc(t.desc)}</p><div id="tool"></div>`;
      const root = document.getElementById("tool");
      DT.wire(root);
      try { t.render(root); } catch (e) { root.innerHTML = `<div class="status err">Tool failed to load: ${DT.esc(e.message)}</div>`; console.error(e); }
      document.title = t.name + " · dev-tools";
      Favs.sync(main);
      window.scrollTo(0, 0);
    }
    window.addEventListener("hashchange", show);

    /* Search: open only groups that contain a match; restore the remembered state when cleared. */
    const q = side.querySelector("#tq");
    q.addEventListener("input", () => {
      const v = q.value.trim().toLowerCase();
      if (!v) {
        list.querySelectorAll(".trow, details.grp").forEach(el => { el.hidden = false; });
        renderFavs();
        Groups.restore(list, "toolbox", false);
        const active = list.querySelector("a.t.on"); if (active) Groups.open(active);
        return;
      }
      favBox.hidden = true;
      list.querySelectorAll(".trow").forEach(r => { r.hidden = !r.dataset.s.includes(v); });
      [...list.querySelectorAll("details.grp")].reverse().forEach(d => {      // innermost first
        const any = !!d.querySelector(".trow:not([hidden])");
        d.hidden = !any; Groups.set(d, any);
      });
    });
    side.querySelector("#expandAll").onclick = () => Groups.setAll(list, "toolbox", true);
    side.querySelector("#collapseAll").onclick = () => { Groups.setAll(list, "toolbox", false); const a = list.querySelector("a.t.on"); if (a) Groups.open(a); };
    renderFavs();
    show();
  }
  window.addEventListener("DOMContentLoaded", boot);
})();
