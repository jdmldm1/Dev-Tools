(function () {
  const lib = DT.lib;

  const CATEGORIES = ["Lu", "Ll", "Lt", "Lm", "Lo", "Mn", "Mc", "Me", "Nd", "Nl", "No", "Pc", "Pd", "Ps", "Pe", "Pi", "Pf", "Po", "Sm", "Sc", "Sk", "So", "Zs", "Zl", "Zp", "Cc", "Cf", "Cs", "Co", "Cn"]
    .map(c => [c, new RegExp(`^\\p{${c}}$`, "u")]);
  lib.UNICODE_CATEGORY_NAMES = {
    Lu: "Uppercase letter", Ll: "Lowercase letter", Lt: "Titlecase letter", Lm: "Modifier letter", Lo: "Other letter", Mn: "Nonspacing mark", Mc: "Spacing mark", Me: "Enclosing mark",
    Nd: "Decimal digit", Nl: "Letter number", No: "Other number", Pc: "Connector punctuation", Pd: "Dash punctuation", Ps: "Open punctuation", Pe: "Close punctuation",
    Pi: "Initial quote", Pf: "Final quote", Po: "Other punctuation", Sm: "Math symbol", Sc: "Currency symbol", Sk: "Modifier symbol", So: "Other symbol",
    Zs: "Space separator", Zl: "Line separator", Zp: "Paragraph separator", Cc: "Control", Cf: "Format (invisible)", Cs: "Surrogate", Co: "Private use", Cn: "Unassigned",
  };

  /* Code points that render as nothing or as a space, and the bidi controls behind "Trojan Source" attacks. */
  const BIDI = new Set([0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]);
  const INVISIBLE = new Set([0x00AD, 0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x3164, 0xFEFF, 0xFFA0, 0x180E, 0x200B, 0x200C, 0x200D]);
  const SPACES = new Set([0x00A0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x202F, 0x205F, 0x3000]);
  const NAMES = {
    0x00A0: "NO-BREAK SPACE", 0x00AD: "SOFT HYPHEN", 0x200B: "ZERO WIDTH SPACE", 0x200C: "ZERO WIDTH NON-JOINER", 0x200D: "ZERO WIDTH JOINER", 0x200E: "LEFT-TO-RIGHT MARK",
    0x200F: "RIGHT-TO-LEFT MARK", 0x202A: "LEFT-TO-RIGHT EMBEDDING", 0x202B: "RIGHT-TO-LEFT EMBEDDING", 0x202C: "POP DIRECTIONAL FORMATTING", 0x202D: "LEFT-TO-RIGHT OVERRIDE",
    0x202E: "RIGHT-TO-LEFT OVERRIDE", 0x2060: "WORD JOINER", 0x2066: "LEFT-TO-RIGHT ISOLATE", 0x2067: "RIGHT-TO-LEFT ISOLATE", 0x2068: "FIRST STRONG ISOLATE", 0x2069: "POP DIRECTIONAL ISOLATE",
    0xFEFF: "ZERO WIDTH NO-BREAK SPACE (BOM)", 0x3000: "IDEOGRAPHIC SPACE", 0x2028: "LINE SEPARATOR", 0x2029: "PARAGRAPH SEPARATOR", 0x0009: "TAB", 0x000A: "LINE FEED", 0x000D: "CARRIAGE RETURN",
    0x0020: "SPACE", 0x202F: "NARROW NO-BREAK SPACE", 0x2009: "THIN SPACE", 0x2003: "EM SPACE", 0x2002: "EN SPACE", 0x034F: "COMBINING GRAPHEME JOINER", 0x180E: "MONGOLIAN VOWEL SEPARATOR",
  };

  const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, "0");
  lib.utf8Bytes = cp => Array.from(new TextEncoder().encode(String.fromCodePoint(cp)));
  lib.utf16Units = cp => (cp > 0xFFFF ? [0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF)] : [cp]);

  /* One record per code point: { cp, ch, cat, flags: [...], name }. flags: bidi, invisible, space, control, nonascii, variation. */
  lib.codepoints = function (text) {
    const out = [];
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0), cat = (CATEGORIES.find(([, re]) => re.test(ch)) || ["Cs"])[0], flags = [];
      if (BIDI.has(cp)) flags.push("bidi");
      if (INVISIBLE.has(cp) || (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF) || (cp >= 0xE0000 && cp <= 0xE007F)) flags.push("invisible");
      if (SPACES.has(cp)) flags.push("space");
      if (cat === "Cc" && ![9, 10, 13].includes(cp)) flags.push("control");
      if (cp > 127) flags.push("nonascii");
      out.push({ cp, ch, cat, flags, name: NAMES[cp] || "" });
    }
    return out;
  };

  /* Make hidden characters visible: invisible, bidi, odd spaces and controls become ⟦U+XXXX⟧. */
  lib.revealInvisible = text => lib.codepoints(text).map(c => (c.flags.some(f => f === "bidi" || f === "invisible" || f === "control" || (f === "space" && c.cp !== 0x20)) ? `⟦U+${hex(c.cp)}⟧` : c.ch)).join("");

  lib.unicodeStats = function (text) {
    const s = String(text), cps = Array.from(s);
    let graphemes = cps.length;
    if (typeof Intl !== "undefined" && Intl.Segmenter) graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)).length;
    return { utf16: s.length, codepoints: cps.length, graphemes, utf8: new TextEncoder().encode(s).length };
  };

  lib.escapes = function (text) {
    const cps = Array.from(String(text), c => c.codePointAt(0));
    return {
      "JavaScript / Python": cps.map(c => (c > 0xFFFF ? `\\u{${hex(c, 1)}}` : c > 127 || c < 32 ? `\\u${hex(c)}` : String.fromCodePoint(c))).join(""),
      "HTML entities": cps.map(c => (c > 127 || c < 32 ? `&#x${hex(c, 1)};` : String.fromCodePoint(c))).join(""),
      "U+ notation": cps.map(c => "U+" + hex(c)).join(" "),
      "UTF-8 bytes": cps.map(c => lib.utf8Bytes(c).map(b => hex(b, 2)).join(" ")).join(" "),
      "URL-encoded": encodeURIComponent(String(text)),
    };
  };

  DT.register({
    id: "unicode", name: "Unicode Inspector", group: "Text",
    desc: "See every code point in a string: code point, UTF-8 and UTF-16 bytes, category, and flags for invisible characters, odd spaces and bidi controls (Trojan Source). Normalization forms and escapes included.",
    keywords: "utf8 utf16 codepoint zero width invisible bidi homoglyph normalize nfc nfd emoji grapheme",
    render(root) {
      root.innerHTML = `
        <div class="col"><label class="l" for="in">Text</label><textarea id="in" class="md" spellcheck="false" placeholder="Paste text with suspicious characters, an emoji, or accented letters"></textarea></div>
        <div class="panel"><div id="stats"></div></div>
        <div class="status" id="st"></div>
        <div class="col"><label class="l">Revealed (hidden characters shown as ⟦U+XXXX⟧)</label><pre class="out" id="rev" style="white-space:pre-wrap;margin:0"></pre></div>
        <div class="tablewrap"><table class="kv" id="tbl"><thead><tr><th>Char</th><th>Code point</th><th>UTF-8</th><th>UTF-16</th><th>Category</th><th>Flags</th></tr></thead><tbody></tbody></table></div>
        <div class="panel"><label class="l">Normalization</label><div id="norm"></div></div>
        <div class="panel"><label class="l">Escapes</label><div id="esc"></div></div>`;
      const $ = s => root.querySelector(s);
      function run() {
        const text = $("#in").value, cps = lib.codepoints(text), st = lib.unicodeStats(text);
        $("#stats").innerHTML = DT.kv([["UTF-16 code units (JS .length)", st.utf16], ["Code points", st.codepoints], ["Grapheme clusters (what you see)", st.graphemes], ["UTF-8 bytes", st.utf8]]);
        const bidi = cps.filter(c => c.flags.includes("bidi")), hidden = cps.filter(c => c.flags.includes("invisible") || c.flags.includes("control")), spaces = cps.filter(c => c.flags.includes("space") && c.cp !== 0x20);
        if (!text) DT.status($("#st"), "", "");
        else if (bidi.length) DT.status($("#st"), "err", `${bidi.length} bidirectional control character${bidi.length > 1 ? "s" : ""}: these can make code or text display differently from how it is stored.`);
        else if (hidden.length || spaces.length) DT.status($("#st"), "warn", `${hidden.length} invisible and ${spaces.length} non-standard space character${hidden.length + spaces.length > 1 ? "s" : ""} found.`);
        else DT.status($("#st"), "ok", cps.some(c => c.flags.includes("nonascii")) ? "No hidden characters. Contains non-ASCII text." : "Plain ASCII.");
        $("#rev").textContent = lib.revealInvisible(text);
        $("#tbl tbody").innerHTML = cps.slice(0, 2000).map(c => {
          const shown = c.flags.some(f => f === "invisible" || f === "bidi" || f === "control") || c.cat === "Zs" || c.cat === "Cc" ? "·" : c.ch;
          return `<tr><td class="v">${DT.esc(shown)}</td><td class="k">U+${hex(c.cp)}${c.name ? `<br><small>${DT.esc(c.name)}</small>` : ""}</td><td class="v">${lib.utf8Bytes(c.cp).map(b => hex(b, 2)).join(" ")}</td><td class="v">${lib.utf16Units(c.cp).map(u => hex(u)).join(" ")}</td><td class="v">${c.cat} <small>${lib.UNICODE_CATEGORY_NAMES[c.cat] || ""}</small></td><td class="v">${c.flags.filter(f => f !== "nonascii").join(", ")}</td></tr>`;
        }).join("") + (cps.length > 2000 ? `<tr><td colspan="6">… ${cps.length - 2000} more code points not listed</td></tr>` : "");
        $("#norm").innerHTML = DT.kv(["NFC", "NFD", "NFKC", "NFKD"].map(f => { const n = text.normalize(f); return [f + (n === text ? " (unchanged)" : ` (${Array.from(n).length} code points)`), n]; }));
        $("#esc").innerHTML = DT.kv(Object.entries(lib.escapes(text)));
      }
      $("#in").addEventListener("input", DT.debounce(run, 120)); run();
    },
  });
})();
