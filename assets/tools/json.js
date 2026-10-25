(function () {
  const lib = DT.lib;

  /* Strip // and C-style comments plus trailing commas, ignoring anything inside strings. */
  lib.lenientJson = function (src) {
    let out = "", i = 0, inStr = false;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (inStr) {
        out += c;
        if (c === "\\") { out += n ?? ""; i += 2; continue; }
        if (c === '"') inStr = false;
        i++; continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      out += c; i++;
    }
    return out.replace(/,(\s*[}\]])/g, "$1");
  };

  lib.sortKeys = function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
    return v;
  };

  lib.jsonStats = function (v) {
    let keys = 0, depth = 0;
    (function walk(x, d) {
      depth = Math.max(depth, d);
      if (Array.isArray(x)) x.forEach(y => walk(y, d + 1));
      else if (x && typeof x === "object") { keys += Object.keys(x).length; Object.values(x).forEach(y => walk(y, d + 1)); }
    })(v, 0);
    return { keys, depth };
  };

  /* Strict JSON validator that reports where parsing fails. Engines often omit the position from
     JSON.parse errors, so we locate it ourselves. Returns null if valid, else { msg, line, col }. */
  lib.jsonLocate = function (text) {
    let i = 0;
    const fail = (msg, pos = i) => { throw { pos, msg }; };
    const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
    const end = () => i >= text.length;
    function str() {
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') { i++; return; }
        if (c === "\\") {
          const n = text[i + 1];
          if (n === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("Bad Unicode escape", i); i += 6; continue; }
          if (!n || !'"\/bfnrt'.includes(n)) fail("Bad escaped character", i + 1);
          i += 2; continue;
        }
        if (c < " ") fail("Control character in string (use \n)");
        i++;
      }
      fail("Unterminated string");
    }
    function num() {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) fail("Bad number");
      i += m[0].length;
    }
    function value() {
      ws();
      const c = text[i];
      if (c === "{") {
        i++; ws();
        if (text[i] === "}") { i++; return; }
        for (;;) {
          ws();
          if (text[i] !== '"') fail(end() ? "Unexpected end of JSON input" : "Expected a double-quoted property name");
          str(); ws();
          if (text[i] !== ":") fail(end() ? "Unexpected end of JSON input" : "Expected ':' after property name");
          i++; value(); ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "}") { i++; return; }
          fail(end() ? "Unexpected end of JSON input" : "Expected ',' or '}' after property value");
        }
      }
      if (c === "[") {
        i++; ws();
        if (text[i] === "]") { i++; return; }
        for (;;) {
          value(); ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "]") { i++; return; }
          fail(end() ? "Unexpected end of JSON input" : "Expected ',' or ']' after array element");
        }
      }
      if (c === '"') return str();
      if (c === "-" || (c >= "0" && c <= "9")) return num();
      for (const lit of ["true", "false", "null"]) if (text.startsWith(lit, i)) { i += lit.length; return; }
      fail(end() ? "Unexpected end of JSON input" : `Unexpected token '${c}'`);
    }
    try {
      value(); ws();
      if (i < text.length) fail(`Unexpected token '${text[i]}' after JSON value`);
      return null;
    } catch (e) {
      if (e && typeof e.pos === "number") {
        const before = text.slice(0, e.pos).split("\n");
        return { msg: e.msg, line: before.length, col: before[before.length - 1].length + 1 };
      }
      throw e;
    }
  };

  /* Turn a JSON.parse error into "message (line L, column C)". */
  lib.jsonError = function (text, err) {
    const loc = lib.jsonLocate(text);
    if (loc) return `${loc.msg} (line ${loc.line}, column ${loc.col})`;
    return String(err && err.message || err);
  };

  /* Evaluate simple property / index paths like user.roles[0] or items[*].name */
  lib.jsonQuery = function (obj, path) {
    if (!path || !path.trim() || path.trim() === "$" || path.trim() === ".") return obj;
    const tokens = path.trim().replace(/^\$\.?/, "").replace(/\[(\w+)\]/g, ".$1").split(".").filter(Boolean);
    let cur = obj;
    for (let i = 0; i < tokens.length; i++) {
      if (cur == null) return undefined;
      const t = tokens[i];
      if (t === "*" && Array.isArray(cur)) {
        const rest = tokens.slice(i + 1).join(".");
        return cur.map(item => rest ? lib.jsonQuery(item, rest) : item);
      }
      cur = cur[t];
    }
    return cur;
  };

  DT.register({
    id: "json", name: "JSON Formatter & Validator", group: "Format & Validate",
    desc: "Pretty-print, minify, sort keys, filter by path and validate JSON with line and column for errors. Lenient mode tolerates comments and trailing commas.",
    keywords: "pretty print beautify minify lint validate escape unescape jsonpath query filter",
    render(root) {
      root.innerHTML = `
        <div class="two">
          <div class="col"><label class="l" for="in">Input</label><textarea id="in" spellcheck="false" placeholder='{"paste": "JSON here"}'></textarea></div>
          <div class="col"><label class="l" for="out">Output</label><textarea id="out" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="opts" style="align-items:flex-end">
          <div class="col" style="flex:1;max-width:320px"><label class="l" for="jq">Filter / Path (optional)</label><input type="text" id="jq" class="mono" placeholder="e.g. data.items[0].id or users.*.name" style="width:100%"></div>
          <label>Indent <select id="indent"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tab</option></select></label>
          <label><input type="checkbox" id="sort"> Sort keys</label>
          <label><input type="checkbox" id="lenient"> Lenient</label>
        </div>
        <div class="btns">
          <button class="btn primary" id="fmt" type="button">Format</button>
          <button class="btn" id="min" type="button">Minify</button>
          <button class="btn" id="esc" type="button">Escape as string</button>
          <button class="btn" id="unesc" type="button">Unescape string</button>
          <button class="btn" id="swap" type="button">Output → Input</button>
          <button class="btn" data-copy="#out" type="button">Copy output</button>
          <button class="btn" data-clear="#in,#out,#jq" type="button">Clear</button>
        </div>
        <div class="status" id="st"></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st");

      function parse() {
        let text = inp.value;
        if ($("#lenient").checked) text = lib.lenientJson(text);
        return JSON.parse(text);
      }
      function indent() { const v = $("#indent").value; return v === "tab" ? "\t" : +v; }
      function run(mode) {
        if (!inp.value.trim()) { out.value = ""; DT.status(st, "", ""); return; }
        try {
          let v = parse();
          const q = $("#jq").value.trim();
          if (q) v = lib.jsonQuery(v, q);
          if (v === undefined) {
            out.value = "undefined";
            DT.status(st, "warn", `No match for path "${q}"`);
            return;
          }
          if ($("#sort").checked) v = lib.sortKeys(v);
          out.value = JSON.stringify(v, null, mode === "min" ? 0 : indent());
          const s = lib.jsonStats(v), bytes = new TextEncoder().encode(out.value).length;
          DT.status(st, "ok", `${q ? `Filtered by "${q}" · ` : ""}Valid JSON · ${s.keys} keys · depth ${s.depth} · ${bytes.toLocaleString()} bytes`);
        } catch (e) { out.value = ""; DT.status(st, "err", lib.jsonError(inp.value, e)); }
      }
      $("#fmt").onclick = () => run("fmt");
      $("#min").onclick = () => run("min");
      $("#esc").onclick = () => { out.value = JSON.stringify(inp.value); DT.status(st, "ok", "Escaped as a JSON string literal"); };
      $("#unesc").onclick = () => {
        try { const v = JSON.parse(inp.value.trim()); out.value = typeof v === "string" ? v : JSON.stringify(v, null, 2); DT.status(st, "ok", "Unescaped"); }
        catch (e) { DT.status(st, "err", "Input must be a quoted JSON string: " + e.message); }
      };
      $("#swap").onclick = () => { inp.value = out.value; run("fmt"); };
      const live = DT.debounce(() => run("fmt"), 250);
      inp.addEventListener("input", live);
      $("#jq").addEventListener("input", live);
      $("#indent").onchange = $("#sort").onchange = $("#lenient").onchange = () => run("fmt");
    },
  });
})();
