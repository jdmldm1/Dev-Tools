/* Turns a cheat sheet page into searchable entries { id, title, sec, code, d } for the overview's command search.
   Template sheets carry their rows as plain text in <script id="sheet-src"> (same format as sheet.js); the older
   standalone sheets are read from their <code>/<pre> elements when a DOMParser is available. */
(function () {
  const root = typeof window !== "undefined" ? window : globalThis;
  function fromSource(id, title, text) {
    const out = []; let sec = "";
    text.split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (line.startsWith("== ")) { sec = line.slice(3).split(" | ")[0]; return; }
      if (!sec || !line || line.startsWith("note: ")) return;
      if (line.startsWith("|| ")) { const c = line.slice(3).split(" || "); out.push({ id, title, sec, code: c[0], d: c.slice(1).join(" ") }); return; }
      const i = line.indexOf(" ## ");
      out.push({ id, title, sec, code: (i < 0 ? line : line.slice(0, i)).replace(/␤/g, " "), d: i < 0 ? "" : line.slice(i + 4) });
    });
    return out;
  }
  /* Rows written as ["Section",[["command","what it does"],...]]: a section marker, then command/description pairs. */
  function fromData(id, title, html) {
    const marks = [...html.matchAll(/\["([^"]{2,60})",\[\[/g)].map(m => [m.index, m[1]]);
    if (!marks.length) return [];
    const out = [];
    for (const m of html.matchAll(/\["([^"]{3,200})","([^"]{0,300})"\]/g)) {
      let sec = "";
      for (const [at, name] of marks) { if (at <= m.index) sec = name; else break; }
      if (sec) out.push({ id, title, sec, code: m[1], d: m[2] });
    }
    return out;
  }
  function entries(id, title, html) {
    const m = /<script type="text\/plain" id="sheet-src">([\s\S]*?)<\/script>/.exec(html);
    if (m) return fromSource(id, title, m[1]);
    const data = fromData(id, title, html);                     // older sheets that build their rows from a JS array
    if (data.length) return data;
    if (typeof DOMParser === "undefined") return [];
    const out = [], doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("code, pre").forEach(el => {
      const code = el.textContent.trim();
      if (code.length < 3 || (el.tagName === "CODE" && el.closest("pre"))) return;
      const card = el.closest("section, article, .card"), h = card && card.querySelector("h2, h3");
      out.push({ id, title, sec: h ? h.textContent.trim() : "", code, d: "" });
    });
    return out;
  }
  root.SheetIndex = { entries, fromSource };
})();
