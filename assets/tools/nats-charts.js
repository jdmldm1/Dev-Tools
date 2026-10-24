/* Small dependency-free SVG charts for the NATS explorer (dark theme). Builders return strings; attach functions add hover.
   Marks follow the dataviz spec: 2px lines, 4px rounded bar ends, 8px end dots with a surface ring, hairline grid. */
(function () {
  const lib = DT.lib, esc = DT.esc;
  lib.chartColors = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];   // categorical order, dark steps
  const num = n => n >= 1e9 ? (n / 1e9).toFixed(1) + "G" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : Number.isInteger(n) ? String(n) : Math.abs(n) < 10 ? n.toFixed(2) : n.toFixed(1);
  lib.chartNum = num;
  const nice = v => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;
  lib.chartNice = nice;

  /* Line chart. series: [{ name, color, points: [[x, y], ...] }] with x ascending.
     opts: { w, h, xFmt(x), yFmt(y), zero (start the y axis at 0), xMin, xMax }. Returns { svg, plot } for chartAttachLine(). */
  lib.chartLine = function (series, o = {}) {
    const W = o.w || 760, H = o.h || 220, L = 46, R = 14, T = 10, B = 24, yFmt = o.yFmt || num, xFmt = o.xFmt || String;
    const pts = series.flatMap(s => s.points);
    if (!pts.length) return { svg: `<div class="hint" style="padding:18px 4px">Waiting for data…</div>`, plot: null };
    let xmin = o.xMin ?? Math.min(...pts.map(p => p[0])), xmax = o.xMax ?? Math.max(...pts.map(p => p[0]));
    if (xmax === xmin) xmax = xmin + 1;
    let ymin = Math.min(...pts.map(p => p[1])), ymax = Math.max(...pts.map(p => p[1]));
    if (o.zero || (ymin >= 0 && ymin < ymax * 0.5)) ymin = 0;
    if (ymax === ymin) ymax = ymin + 1;
    const step = nice((ymax - ymin) / 4); ymin = Math.floor(ymin / step) * step; ymax = Math.ceil(ymax / step) * step;
    const X = x => L + (x - xmin) / (xmax - xmin) * (W - L - R), Y = y => T + (1 - (y - ymin) / (ymax - ymin)) * (H - T - B);
    let g = "";
    for (let v = ymin; v <= ymax + step / 1e6; v += step) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${esc(yFmt(v))}</text>`;
    for (let i = 0; i <= 4; i++) { const x = xmin + (xmax - xmin) * i / 4; g += `<text x="${X(x).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${esc(xFmt(x))}</text>`; }
    for (const [i, s] of series.entries()) {
      if (!s.points.length) continue;
      const c = s.color || lib.chartColors[i % 8], d = s.points.map(([x, y], k) => (k ? "L" : "M") + X(x).toFixed(1) + " " + Y(y).toFixed(1)).join("");
      const last = s.points[s.points.length - 1];
      if (series.length === 1) g += `<path d="${d}L${X(last[0]).toFixed(1)} ${Y(ymin).toFixed(1)}L${X(s.points[0][0]).toFixed(1)} ${Y(ymin).toFixed(1)}Z" fill="${c}" opacity=".10"/>`;
      g += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      g += `<circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="4" fill="${c}" class="ring"/>`;
    }
    return {
      svg: `<svg class="ch" viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}<g class="hv"></g><rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`,
      plot: { W, H, L, R, T, B, xmin, xmax, ymin, ymax, X, Y, series, xFmt, yFmt },
    };
  };

  /* One tooltip per host element. */
  function tipFor(host) {
    if (host._tip) return host._tip;
    host.classList.add("tipped");
    const el = document.createElement("div"); el.className = "ctip"; el.hidden = true; host.appendChild(el);
    return (host._tip = {
      show(html, e) {
        el.innerHTML = html; el.hidden = false;
        const r = host.getBoundingClientRect(), x = e.clientX - r.left, flip = x > r.width * 0.6;
        el.style.left = (flip ? x - el.offsetWidth - 12 : x + 14) + "px"; el.style.top = Math.max(0, e.clientY - r.top - 10) + "px";
      },
      hide() { el.hidden = true; },
    });
  }

  /* Crosshair and tooltip for a line chart whose svg is inside `host`. Call again after the svg is re-rendered. */
  lib.chartAttachLine = function (host, plot) {
    const svg = host.querySelector("svg.ch"); if (!svg || !plot) return;
    const hv = svg.querySelector(".hv"), tip = tipFor(host), hit = svg.querySelector(".hit");
    const nearest = (pts, x) => { let lo = 0, hi = pts.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m][0] < x) lo = m + 1; else hi = m; } return lo > 0 && Math.abs(pts[lo - 1][0] - x) < Math.abs(pts[lo][0] - x) ? pts[lo - 1] : pts[lo]; };
    hit.addEventListener("mousemove", e => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * plot.W, x = plot.xmin + (px - plot.L) / (plot.W - plot.L - plot.R) * (plot.xmax - plot.xmin);
      const rows = plot.series.filter(s => s.points.length).map((s, i) => ({ s, p: nearest(s.points, x), c: s.color || lib.chartColors[i % 8] }));
      if (!rows.length) return;
      const cx = plot.X(rows[0].p[0]).toFixed(1);
      hv.innerHTML = `<line class="cross" x1="${cx}" x2="${cx}" y1="${plot.T}" y2="${plot.H - plot.B}"/>` + rows.map(q => `<circle cx="${plot.X(q.p[0]).toFixed(1)}" cy="${plot.Y(q.p[1]).toFixed(1)}" r="4" fill="${q.c}" class="ring"/>`).join("");
      tip.show(`<div class="tt-h">${esc(plot.xFmt(rows[0].p[0]))}</div>` + rows.map(q => `<div><span class="sw" style="background:${q.c}"></span>${esc(q.s.name)} <b>${esc(plot.yFmt(q.p[1]))}</b></div>`).join(""), e);
    });
    hit.addEventListener("mouseleave", () => { hv.innerHTML = ""; tip.hide(); });
  };

  /* Horizontal bars. rows: [{ label, value, color?, tip? }]; each row is a <g data-i> so callers can handle clicks. */
  lib.chartBars = function (rows, o = {}) {
    if (!rows.length) return `<div class="hint" style="padding:12px 4px">${esc(o.empty || "Nothing to show yet.")}</div>`;
    const W = o.w || 760, rowH = o.rowH || 22, labelW = o.labelW || 230, valW = 74, H = rows.length * rowH + 4, fmt = o.fmt || num;
    const max = Math.max(...rows.map(r => r.value)) || 1, bw = W - labelW - valW;
    const g = rows.map((r, i) => {
      const y = 2 + i * rowH, w = Math.max(2, r.value / max * bw), c = r.color || o.color || lib.chartColors[0], t = Math.min(14, rowH - 8), r4 = Math.min(4, w / 2);
      const bar = `M${labelW} ${y + 4}H${(labelW + w - r4).toFixed(1)}a${r4} ${r4} 0 0 1 ${r4} ${r4}V${y + 4 + t - r4}a${r4} ${r4} 0 0 1 -${r4} ${r4}H${labelW}Z`;
      return `<g class="brow${o.click ? " click" : ""}" data-i="${i}" data-tip="${esc(r.tip || r.label + ": " + fmt(r.value))}"><rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"/>`
        + `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(trunc(r.label, Math.floor(labelW / 7)))}</text><path d="${bar}" fill="${c}"/>`
        + `<text x="${(labelW + w + 6).toFixed(1)}" y="${y + rowH / 2 + 4}" class="val">${esc(fmt(r.value))}</text></g>`;
    }).join("");
    return `<svg class="ch" viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
  };

  lib.chartSpark = function (values, w = 110, h = 26, color = lib.chartColors[0]) {
    if (values.length < 2) return "";
    const max = Math.max(...values, 1e-9), min = Math.min(...values, 0), X = i => 2 + i / (values.length - 1) * (w - 4), Y = v => 2 + (1 - (v - min) / (max - min || 1)) * (h - 4);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${values.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join("")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/></svg>`;
  };

  /* Tooltips for anything with [data-tip] inside host (bars). Safe to call repeatedly. */
  lib.chartAttachTips = function (host) {
    const tip = tipFor(host);
    if (host._tipsBound) return; host._tipsBound = true;
    host.addEventListener("mousemove", e => { const g = e.target.closest("[data-tip]"); if (g) tip.show(esc(g.dataset.tip), e); else if (!e.target.closest(".hit")) tip.hide(); });
    host.addEventListener("mouseleave", () => tip.hide());
  };
})();
