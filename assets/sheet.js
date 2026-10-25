/* Renders a cheat sheet from the plain-text block <script type="text/plain" id="sheet-src">:

     title: Regex                (also: eyebrow:, lede:, footer:)   <- header keys, before first section
     == Section title | tag
     note: Short intro for the section, `inline code` allowed
     some command --flag ## What it does          <- row: code, optional " ## " then description
                                                  (a U+2424 symbol in code becomes a real line break in the rendered/copied text)
     || Col A || Col B                            <- table: first line is the header row
     || a || b
*/
(function () {
  function parse(src) {
    const S = { sections: [] };
    let cur = null;
    src.split(/\r?\n/).forEach(raw => {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) return;
      if (line.startsWith("== ")) {
        const [t, tag] = line.slice(3).split(" | ");
        cur = { title: t.trim(), tag: tag && tag.trim(), parts: [] };
        cur.id = cur.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        S.sections.push(cur);
      } else if (!cur) {
        const m = line.match(/^(\w+):\s*(.*)$/); if (m) S[m[1]] = m[2];
      } else if (line.startsWith("note: ")) {
        cur.note = line.slice(6);
      } else if (line.startsWith("|| ")) {
        const cells = line.slice(3).split(" || ").map(s => s.trim());
        const last = cur.parts[cur.parts.length - 1];
        if (last && last.table) last.table.rows.push(cells); else cur.parts.push({ table: { head: cells, rows: [] } });
      } else {
        const i = line.indexOf(" ## ");
        cur.parts.push({ row: i < 0 ? [line.trim(), ""] : [line.slice(0, i).trim(), line.slice(i + 4).trim()] });
      }
    });
    return S;
  }
  const S = window.SHEET || parse(document.getElementById("sheet-src").textContent);
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  document.title = S.title + " Cheat Sheet";

  let total = 0;
  const cards = S.sections.map((sec, i) => {
    const id = sec.id || "s" + i;
    let body = "";
    if (sec.note) body += `<div class="note" data-s="${esc(sec.note.toLowerCase())}">${inline(sec.note)}</div>`;
    sec.parts.forEach(p => {
      if (p.row) {
        const [c0, d] = p.row, c = c0.replace(/\u2424/g, "\n");
        total++;
        body += `<div class="row" data-s="${esc((c + " " + (d || "")).toLowerCase())}"><pre>${esc(c)}</pre><button class="cp" type="button" aria-label="Copy">copy</button>${d ? `<div class="d">${inline(d)}</div>` : ""}</div>`;
      } else {
        const t = p.table;
        total += t.rows.length;
        body += `<div class="tbl"><table><thead><tr>${t.head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>` +
          t.rows.map(r => `<tr data-s="${esc(r.join(" ").toLowerCase())}">${r.map((x, j) => `<td>${j === 0 ? esc(x) : inline(x)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`;
      }
    });
    return `<section class="card" id="${esc(id)}" data-t="${esc((sec.title + " " + (sec.tag || "")).toLowerCase())}"><h2>${esc(sec.title)}${sec.tag ? `<small>${esc(sec.tag)}</small>` : ""}</h2>${body}</section>`;
  });

  document.getElementById("app").innerHTML = `
  <div class="wrap">
    <div class="topnav"><a href="../index.html">&larr; dev-tools</a></div>
    <header class="hero">
      <div class="eyebrow">${esc(S.eyebrow || "Cheat sheet")}</div>
      <h1>${esc(S.title)} <span>Cheat Sheet</span></h1>
      <p class="lede">${inline(S.lede || "")}</p>
    </header>
    <div class="bar">
      <input id="q" type="search" placeholder="Filter…" aria-label="Filter" autocomplete="off">
      <nav class="chips" aria-label="Sections">${S.sections.map((s, i) => `<a class="chip" href="#${esc(s.id || "s" + i)}">${esc(s.title)}</a>`).join("")}</nav>
      <span class="count" id="count">${total} entries</span>
    </div>
    <main class="grid" id="grid">${cards.join("")}</main>
    <p class="empty" id="empty" hidden>No entries match that filter.</p>
    ${S.footer ? `<footer>${inline(S.footer)}</footer>` : ""}
  </div>`;

  const grid = document.getElementById("grid"), q = document.getElementById("q");
  grid.addEventListener("click", async e => {
    const b = e.target.closest(".cp"); if (!b) return;
    const txt = b.parentElement.querySelector("pre").textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "copied"; b.classList.add("done"); }
    catch (_) { const r = document.createRange(); r.selectNodeContents(b.parentElement.querySelector("pre")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = "selected"; }
    setTimeout(() => { b.textContent = "copy"; b.classList.remove("done"); }, 1300);
  });
  q.addEventListener("input", () => {
    const v = q.value.trim().toLowerCase(); let shown = 0, any = false;
    grid.querySelectorAll(".card").forEach(card => {
      const titleHit = v && card.dataset.t.includes(v);
      let n = 0;
      card.querySelectorAll("[data-s]").forEach(r => {
        const ok = !v || titleHit || r.dataset.s.includes(v);
        r.hidden = !ok;
        if (ok && !r.classList.contains("note")) n++;
      });
      card.hidden = !!v && n === 0;
      shown += n; if (!card.hidden) any = true;
    });
    document.getElementById("count").textContent = v ? shown + " match" + (shown === 1 ? "" : "es") : total + " entries";
    document.getElementById("empty").hidden = any || !v;
  });
  const pre = new URLSearchParams(location.search).get("q");           // deep link from the overview's command search
  if (pre) { q.value = pre; q.dispatchEvent(new Event("input")); }
})();
