(function () {
  const lib = DT.lib;

  /* Line diff via longest common subsequence, after trimming the common head and tail.
     Returns [{ t: "ctx"|"add"|"del", line, a?: lineNoInA, b?: lineNoInB }]. */
  lib.lineDiff = function (A, B, { ignoreWs = false, ignoreCase = false } = {}) {
    const norm = s => { if (ignoreWs) s = s.replace(/\s+/g, " ").trim(); return ignoreCase ? s.toLowerCase() : s; };
    const a = A.split("\n"), b = B.split("\n"), na = a.map(norm), nb = b.map(norm);
    let head = 0; while (head < a.length && head < b.length && na[head] === nb[head]) head++;
    let tail = 0; while (tail < a.length - head && tail < b.length - head && na[a.length - 1 - tail] === nb[b.length - 1 - tail]) tail++;
    const n = a.length - head - tail, m = b.length - head - tail;
    if (n * m > 6e6) throw new Error("Inputs are too large to diff in the browser (try fewer lines).");
    const out = [];
    for (let i = 0; i < head; i++) out.push({ t: "ctx", line: a[i], a: i + 1, b: i + 1 });
    // DP table of LCS lengths over the middle section
    const w = m + 1, L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = na[head + i] === nb[head + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (na[head + i] === nb[head + j]) { out.push({ t: "ctx", line: b[head + j], a: head + i + 1, b: head + j + 1 }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { out.push({ t: "del", line: a[head + i], a: head + i + 1 }); i++; }
      else { out.push({ t: "add", line: b[head + j], b: head + j + 1 }); j++; }
    }
    for (; i < n; i++) out.push({ t: "del", line: a[head + i], a: head + i + 1 });
    for (; j < m; j++) out.push({ t: "add", line: b[head + j], b: head + j + 1 });
    for (let k = 0; k < tail; k++) out.push({ t: "ctx", line: a[a.length - tail + k], a: a.length - tail + k + 1, b: b.length - tail + k + 1 });
    return out;
  };

  /* Collapse long unchanged runs, keeping `context` lines around changes. */
  lib.foldContext = function (ops, context = 3) {
    const keep = new Array(ops.length).fill(false);
    ops.forEach((o, i) => { if (o.t !== "ctx") for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true; });
    const out = []; let skipped = 0;
    ops.forEach((o, i) => { if (keep[i]) { if (skipped) { out.push({ t: "gap", n: skipped }); skipped = 0; } out.push(o); } else skipped++; });
    if (skipped) out.push({ t: "gap", n: skipped });
    return out;
  };

  DT.register({
    id: "diff", name: "Text Diff", group: "Format & Validate",
    desc: "Compare two blocks of text line by line. Paste configs, JSON, code or logs and see exactly what changed.",
    keywords: "compare difference changes unified patch merge",
    render(root) {
      root.innerHTML = `
        <div class="two">
          <div class="col"><label class="l" for="a">Original</label><textarea id="a" spellcheck="false"></textarea></div>
          <div class="col"><label class="l" for="b">Changed</label><textarea id="b" spellcheck="false"></textarea></div>
        </div>
        <div class="opts"><label><input type="checkbox" id="ws"> Ignore whitespace</label><label><input type="checkbox" id="ic"> Ignore case</label>
          <label><input type="checkbox" id="fold" checked> Collapse unchanged lines</label>
          <label><input type="checkbox" id="split"> Side-by-side view</label>
          <button class="btn" id="swap" type="button">Swap sides</button><button class="btn" data-clear="#a,#b" type="button">Clear</button></div>
        <div class="status" id="st"></div>
        <div class="diff" id="out"></div>`;
      const $ = s => root.querySelector(s);
      function renderSplit(ops) {
        const out = [];
        let i = 0;
        while (i < ops.length) {
          const o = ops[i];
          if (o.t === "gap") {
            out.push(`<div class="split-row"><div class="split-cell ctx" style="grid-column:1/-1;text-align:center;justify-content:center;opacity:.6">⋯ ${o.n} unchanged line${o.n === 1 ? "" : "s"} ⋯</div></div>`);
            i++;
          } else if (o.t === "ctx") {
            out.push(`<div class="split-row"><div class="split-cell ctx"><span class="ln">${o.a}</span><pre>${DT.esc(o.line) || " "}</pre></div><div class="split-cell ctx"><span class="ln">${o.b}</span><pre>${DT.esc(o.line) || " "}</pre></div></div>`);
            i++;
          } else if (o.t === "del") {
            const dels = [], adds = [];
            while (i < ops.length && ops[i].t === "del") dels.push(ops[i++]);
            while (i < ops.length && ops[i].t === "add") adds.push(ops[i++]);
            const m = Math.max(dels.length, adds.length);
            for (let k = 0; k < m; k++) {
              const d = dels[k], a = adds[k];
              const lCell = d ? `<div class="split-cell del"><span class="ln">${d.a}</span><pre>- ${DT.esc(d.line) || " "}</pre></div>` : `<div class="split-cell empty"></div>`;
              const rCell = a ? `<div class="split-cell add"><span class="ln">${a.b}</span><pre>+ ${DT.esc(a.line) || " "}</pre></div>` : `<div class="split-cell empty"></div>`;
              out.push(`<div class="split-row">${lCell}${rCell}</div>`);
            }
          } else if (o.t === "add") {
            out.push(`<div class="split-row"><div class="split-cell empty"></div><div class="split-cell add"><span class="ln">${o.b}</span><pre>+ ${DT.esc(o.line) || " "}</pre></div></div>`);
            i++;
          }
        }
        return out.join("");
      }
      function run() {
        const A = $("#a").value, B = $("#b").value;
        if (!A && !B) { $("#out").innerHTML = ""; $("#out").classList.remove("split"); DT.status($("#st"), "", ""); return; }
        try {
          let ops = lib.lineDiff(A, B, { ignoreWs: $("#ws").checked, ignoreCase: $("#ic").checked });
          const add = ops.filter(o => o.t === "add").length, del = ops.filter(o => o.t === "del").length;
          DT.status($("#st"), add + del ? "warn" : "ok", add + del ? `${add} added · ${del} removed` : "Identical");
          if ($("#fold").checked) ops = lib.foldContext(ops, 3);
          const isSplit = $("#split").checked;
          $("#out").classList.toggle("split", isSplit);
          if (isSplit) {
            $("#out").innerHTML = renderSplit(ops);
          } else {
            $("#out").innerHTML = ops.map(o => o.t === "gap"
              ? `<div class="ctx" style="text-align:center;opacity:.6">⋯ ${o.n} unchanged line${o.n === 1 ? "" : "s"} ⋯</div>`
              : `<div class="${o.t}">${o.t === "add" ? "+" : o.t === "del" ? "-" : " "} ${DT.esc(o.line) || "&nbsp;"}</div>`).join("");
          }
        } catch (e) { DT.status($("#st"), "err", e.message); }
      }
      const go = DT.debounce(run, 200);
      ["#a", "#b"].forEach(s => $(s).addEventListener("input", go));
      ["#ws", "#ic", "#fold", "#split"].forEach(s => $(s).onchange = run);
      $("#swap").onclick = () => { const t = $("#a").value; $("#a").value = $("#b").value; $("#b").value = t; run(); };
    },
  });
})();
