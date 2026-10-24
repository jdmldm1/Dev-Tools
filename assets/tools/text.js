(function () {
  const lib = DT.lib;

  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const lines = s => s.split("\n");
  const unlines = a => a.join("\n");

  /* Each op: { name, args: [labels], run(text, a, b) -> text }. */
  lib.textOps = {
    sortAsc: { name: "Sort lines A → Z", run: t => unlines(lines(t).sort((x, y) => x < y ? -1 : x > y ? 1 : 0)) },
    sortDesc: { name: "Sort lines Z → A", run: t => unlines(lines(t).sort((x, y) => x < y ? 1 : x > y ? -1 : 0)) },
    sortNat: { name: "Sort lines (natural, case-insensitive)", run: t => unlines(lines(t).sort(natural)) },
    sortNum: { name: "Sort lines numerically", run: t => unlines(lines(t).sort((x, y) => (parseFloat(x) || 0) - (parseFloat(y) || 0))) },
    sortLen: { name: "Sort lines by length", run: t => unlines(lines(t).sort((x, y) => x.length - y.length)) },
    reverse: { name: "Reverse line order", run: t => unlines(lines(t).reverse()) },
    shuffle: { name: "Shuffle lines", run: t => { const a = lines(t); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return unlines(a); } },
    unique: { name: "Remove duplicate lines (keep first)", run: t => unlines([...new Set(lines(t))]) },
    dupes: { name: "Keep only duplicated lines", run: t => { const c = new Map(); lines(t).forEach(l => c.set(l, (c.get(l) || 0) + 1)); return unlines([...c].filter(([, n]) => n > 1).map(([l]) => l)); } },
    count: { name: "Count occurrences of each line", run: t => { const c = new Map(); lines(t).forEach(l => c.set(l, (c.get(l) || 0) + 1)); return unlines([...c].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${n}\t${l}`)); } },
    blank: { name: "Remove blank lines", run: t => unlines(lines(t).filter(l => l.trim() !== "")) },
    trim: { name: "Trim each line", run: t => unlines(lines(t).map(l => l.trim())) },
    collapse: { name: "Collapse runs of spaces", run: t => t.replace(/[ \t]{2,}/g, " ") },
    number: { name: "Add line numbers", run: t => { const a = lines(t), w = String(a.length).length; return unlines(a.map((l, i) => `${String(i + 1).padStart(w, " ")}  ${l}`)); } },
    unnumber: { name: "Remove leading line numbers", run: t => unlines(lines(t).map(l => l.replace(/^\s*\d+[.):\-\s]\s?/, ""))) },
    prefix: { name: "Prefix each line", args: ["prefix"], run: (t, a) => unlines(lines(t).map(l => a + l)) },
    suffix: { name: "Suffix each line", args: ["suffix"], run: (t, a) => unlines(lines(t).map(l => l + a)) },
    quote: { name: "Wrap each line in quotes", args: ["quote char (default \")"], run: (t, a) => { const q = a || '"'; return unlines(lines(t).map(l => q + l + q)); } },
    join: { name: "Join lines with delimiter", args: ["delimiter (default ,)"], run: (t, a) => lines(t).filter(l => l !== "").join(a === "" || a === undefined ? "," : a.replace(/\\n/g, "\n").replace(/\\t/g, "\t")) },
    split: { name: "Split on delimiter into lines", args: ["delimiter (default ,)"], run: (t, a) => t.split(a === "" || a === undefined ? "," : a.replace(/\\t/g, "\t")).map(s => s.trim()).join("\n") },
    jsonArray: { name: "Lines → JSON array", run: t => JSON.stringify(lines(t).filter(l => l !== ""), null, 2) },
    replace: { name: "Find & replace (plain text)", args: ["find", "replace with"], run: (t, a, b) => a ? t.split(a).join(b || "") : t },
    regexReplace: { name: "Find & replace (regex, global)", args: ["pattern", "replacement ($1 ok)"], run: (t, a, b) => a ? t.replace(new RegExp(a, "g"), b || "") : t },
    filter: { name: "Keep lines containing", args: ["text"], run: (t, a) => unlines(lines(t).filter(l => l.includes(a || ""))) },
    exclude: { name: "Remove lines containing", args: ["text"], run: (t, a) => unlines(lines(t).filter(l => !l.includes(a || "\u0000"))) },
  };

  lib.textStats = function (t) {
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    return { chars: [...t].length, noSpaces: [...t.replace(/\s/g, "")].length, words, lines: t ? t.split("\n").length : 0, bytes: new TextEncoder().encode(t).length, sentences: (t.match(/[^.!?]+[.!?]+/g) || []).length };
  };

  DT.register({
    id: "text", name: "Text Utilities", group: "Text",
    desc: "Sort, de-duplicate, number, quote, join, split and search-and-replace lines of text, with live counts. Every operation can be undone.",
    keywords: "lines sort unique dedupe count words characters bytes trim prefix join split replace list",
    render(root) {
      const ops = Object.entries(lib.textOps);
      root.innerHTML = `
        <div class="col"><label class="l" for="t">Text</label><textarea id="t" spellcheck="false" placeholder="Paste lines here"></textarea></div>
        <div class="hint mono" id="stats" style="margin:6px 0"></div>
        <div class="opts">
          <select id="op" class="mono" style="max-width:340px">${ops.map(([k, o]) => `<option value="${k}">${DT.esc(o.name)}</option>`).join("")}</select>
          <input type="text" id="a1" class="mono" style="width:200px" hidden><input type="text" id="a2" class="mono" style="width:200px" hidden>
          <button class="btn primary" id="apply" type="button">Apply</button><button class="btn" id="undo" type="button" disabled>Undo</button>
          <button class="btn" data-copy="#t" type="button">Copy</button><button class="btn" data-clear="#t" type="button">Clear</button>
        </div>
        <div class="status" id="st"></div>`;
      const $ = s => root.querySelector(s), t = $("#t"), hist = [];
      function stats() { const s = lib.textStats(t.value); $("#stats").textContent = `${s.chars.toLocaleString()} chars · ${s.noSpaces.toLocaleString()} without spaces · ${s.words.toLocaleString()} words · ${s.lines.toLocaleString()} lines · ${s.bytes.toLocaleString()} bytes (UTF-8) · ${s.sentences} sentences`; }
      function args() {
        const o = lib.textOps[$("#op").value], n = (o.args || []).length;
        [$("#a1"), $("#a2")].forEach((el, i) => { el.hidden = i >= n; el.placeholder = (o.args || [])[i] || ""; });
      }
      $("#op").onchange = args;
      $("#apply").onclick = () => {
        try { const before = t.value; t.value = lib.textOps[$("#op").value].run(before, $("#a1").value, $("#a2").value); hist.push(before); $("#undo").disabled = false; DT.status($("#st"), "ok", lib.textOps[$("#op").value].name); stats(); }
        catch (e) { DT.status($("#st"), "err", e.message); }
      };
      $("#undo").onclick = () => { if (hist.length) { t.value = hist.pop(); stats(); } $("#undo").disabled = !hist.length; };
      t.addEventListener("input", stats); args(); stats();
    },
  });
})();
