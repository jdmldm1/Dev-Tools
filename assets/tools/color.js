(function () {
  const lib = DT.lib;
  const NAMES = { black: "#000000", white: "#ffffff", red: "#ff0000", lime: "#00ff00", blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", olive: "#808000", green: "#008000", purple: "#800080", teal: "#008080", navy: "#000080", orange: "#ffa500", pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", indigo: "#4b0082", violet: "#ee82ee", tomato: "#ff6347", rebeccapurple: "#663399", transparent: "#00000000" };

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const num = (t, pctMax) => /%$/.test(t) ? parseFloat(t) / 100 * pctMax : parseFloat(t);

  /* Returns { r, g, b, a } with r,g,b in 0-255 and a in 0-1, or throws. */
  lib.parseColor = function (input) {
    let s = String(input).trim().toLowerCase();
    let m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = [...h].map(c => c + c).join("");
      const v = [0, 2, 4, 6].map(i => h.length > i ? parseInt(h.slice(i, i + 2), 16) : 255);
      return { r: v[0], g: v[1], b: v[2], a: h.length === 8 ? +(v[3] / 255).toFixed(3) : 1 };
    }
    if (NAMES[s]) return lib.parseColor(NAMES[s]);
    else if (/^[a-z]+$/.test(s) && typeof document !== "undefined") {
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = "#010203"; c.fillStyle = s;
      if (c.fillStyle === "#010203" && s !== "#010203") { c.fillStyle = "#040506"; c.fillStyle = s; if (c.fillStyle === "#040506") throw new Error(`Unknown color name "${input}"`); }
      return lib.parseColor(c.fillStyle);
    }
    m = /^rgba?\(\s*([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (p.length < 3) throw new Error("rgb() needs three values");
      return { r: clamp(Math.round(num(p[0], 255)), 0, 255), g: clamp(Math.round(num(p[1], 255)), 0, 255), b: clamp(Math.round(num(p[2], 255)), 0, 255), a: p[3] !== undefined ? clamp(num(p[3], 1), 0, 1) : 1 };
    }
    m = /^hsla?\(\s*([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (p.length < 3) throw new Error("hsl() needs three values");
      const rgb = lib.hslToRgb(parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]));
      return { ...rgb, a: p[3] !== undefined ? clamp(num(p[3], 1), 0, 1) : 1 };
    }
    throw new Error("Use #hex, rgb(), hsl() or a color name.");
  };

  lib.rgbToHsl = function (r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  };
  lib.hslToRgb = function (h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
  };
  lib.rgbToHsv = function (r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const hsl = lib.rgbToHsl(r * 255, g * 255, b * 255);
    return { h: hsl.h, s: Math.round((max ? d / max : 0) * 100), v: Math.round(max * 100) };
  };
  lib.toHex = (c, withAlpha) => "#" + [c.r, c.g, c.b].concat(withAlpha && c.a < 1 ? [Math.round(c.a * 255)] : []).map(x => x.toString(16).padStart(2, "0")).join("");

  lib.luminance = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  lib.contrast = (a, b) => { const x = lib.luminance(a), y = lib.luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  lib.wcag = ratio => ({ aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5 });

  DT.register({
    id: "color", name: "Color Converter & Contrast", group: "Time & Numbers",
    desc: "Convert between HEX, RGB, HSL and HSV, pick colors, and check WCAG contrast between a foreground and background.",
    keywords: "hex rgb hsl hsv css picker wcag accessibility contrast ratio",
    render(root) {
      root.innerHTML = `
        <div class="two">
          <div class="col">
            <label class="l" for="in">Color (hex, rgb(), hsl(), or name)</label>
            <div class="opts"><input type="text" id="in" class="mono" value="#58a6ff" style="max-width:260px" spellcheck="false"><input type="color" id="pick" value="#58a6ff" aria-label="Color picker" style="width:48px;height:38px;padding:0;border:0;background:none"></div>
            <div class="status" id="st"></div><div class="swatch" id="sw"></div>
          </div>
          <div id="fmt"></div>
        </div>
        <div class="panel"><div class="lbl" style="margin-bottom:8px">Contrast checker</div>
          <div class="opts"><label>Text <input type="text" id="fg" class="mono" value="#e6edf3" style="width:130px"></label><label>Background <input type="text" id="bg" class="mono" value="#0d1117" style="width:130px"></label><button class="btn" id="flip" type="button">Swap</button><button class="btn" id="usemain" type="button">Use color above as text</button></div>
          <div id="prev" style="padding:16px;border-radius:8px;border:1px solid var(--line);margin:8px 0"><b style="font-size:20px">Large sample text</b><div>Normal body text sample 0123456789</div></div>
          <div id="cr"></div></div>`;
      const $ = s => root.querySelector(s);
      function main() {
        try {
          const c = lib.parseColor($("#in").value), hsl = lib.rgbToHsl(c.r, c.g, c.b), hsv = lib.rgbToHsv(c.r, c.g, c.b), a = c.a < 1;
          DT.status($("#st"), "", "");
          $("#sw").style.background = `rgba(${c.r},${c.g},${c.b},${c.a})`;
          $("#pick").value = lib.toHex(c);
          $("#fmt").innerHTML = DT.kv([
            ["HEX", lib.toHex(c, a)], ["HEX (upper)", lib.toHex(c, a).toUpperCase()],
            ["RGB", a ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`],
            ["HSL", a ? `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${c.a})` : `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`],
            ["HSV", `hsv(${hsv.h}, ${hsv.s}%, ${hsv.v}%)`], ["Int (0xRRGGBB)", String((c.r << 16) | (c.g << 8) | c.b)],
          ]);
        } catch (e) { DT.status($("#st"), "err", e.message); }
      }
      function contrast() {
        try {
          const f = lib.parseColor($("#fg").value), b = lib.parseColor($("#bg").value), r = lib.contrast(f, b), w = lib.wcag(r);
          $("#prev").style.color = lib.toHex(f); $("#prev").style.background = lib.toHex(b);
          const pill = ok => `<span class="${ok ? "ok" : "err"}" style="font-weight:600;color:var(--${ok ? "green" : "bad"})">${ok ? "Pass" : "Fail"}</span>`;
          $("#cr").innerHTML = `<div class="mono" style="font-size:20px;margin-bottom:8px">${r.toFixed(2)} : 1</div><table class="kv"><thead><tr><th></th><th>Normal text</th><th>Large text (18pt / 14pt bold)</th></tr></thead><tbody><tr><td class="k">AA</td><td>${pill(w.aaNormal)} (4.5)</td><td>${pill(w.aaLarge)} (3.0)</td></tr><tr><td class="k">AAA</td><td>${pill(w.aaaNormal)} (7.0)</td><td>${pill(w.aaaLarge)} (4.5)</td></tr></tbody></table>`;
        } catch (e) { $("#cr").innerHTML = `<span class="status err">${DT.esc(e.message)}</span>`; }
      }
      $("#in").addEventListener("input", DT.debounce(main, 100));
      $("#pick").addEventListener("input", e => { $("#in").value = e.target.value; main(); });
      $("#fg").addEventListener("input", DT.debounce(contrast, 100)); $("#bg").addEventListener("input", DT.debounce(contrast, 100));
      $("#flip").onclick = () => { const t = $("#fg").value; $("#fg").value = $("#bg").value; $("#bg").value = t; contrast(); };
      $("#usemain").onclick = () => { $("#fg").value = $("#in").value; contrast(); };
      main(); contrast();
    },
  });
})();
