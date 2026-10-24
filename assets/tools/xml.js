(function () {
  const lib = DT.lib;

  /* ---- Parser -------------------------------------------------------------
     Well-formedness-checking XML parser. Tree: { decl, root } where
     element = { t:"el", name, attrs:[[k,v]], kids:[...] }, plus { t:"text"|"cdata"|"comment"|"pi", v }.
     Throws Error with .line/.col on malformed input. No DTD/entity expansion beyond the 5 built-ins and numeric refs. */
  const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

  lib.xmlParse = function (src) {
    let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
    const pos = idx => { const b = src.slice(0, idx).split("\n"); return { line: b.length, col: b[b.length - 1].length + 1 }; };
    const err = (msg, idx = i) => { const p = pos(idx); const e = new Error(`${msg} (line ${p.line}, column ${p.col})`); e.line = p.line; e.col = p.col; throw e; };
    const decode = (s, at) => {
      const bad = /&(?!#x[0-9a-fA-F]+;|#\d+;|[A-Za-z][\w.-]*;)/.exec(s);
      if (bad) err("Unescaped '&' (write &amp;)", at + bad.index);
      return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*);/g, (m, e, off) => {
        if (e[0] === "#") { try { return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch (_) { err("Invalid character reference " + m, at + off); } }
        if (!(e in ENT)) err(`Undefined entity &${e};`, at + off);
        return ENT[e];
      });
    };
    const stack = []; let root = null, decl = null;
    const add = n => { if (stack.length) stack[stack.length - 1].kids.push(n); };
    const nameRe = /<([A-Za-z_][\w.:-]*)/y, attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y, closeRe = /<\/([A-Za-z_][\w.:-]*)\s*>/y;
    while (i < src.length) {
      if (src[i] !== "<") {
        let j = src.indexOf("<", i); if (j < 0) j = src.length;
        const t = src.slice(i, j);
        if (!stack.length) { if (t.trim()) err("Text outside the root element", i + t.search(/\S/)); }
        else add({ t: "text", v: decode(t, i) });
        i = j; continue;
      }
      if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i + 4); if (e < 0) err("Unterminated comment"); add({ t: "comment", v: src.slice(i + 4, e) }); i = e + 3; continue; }
      if (src.startsWith("<![CDATA[", i)) { const e = src.indexOf("]]>", i); if (e < 0) err("Unterminated CDATA section"); if (!stack.length) err("CDATA outside the root element"); add({ t: "cdata", v: src.slice(i + 9, e) }); i = e + 3; continue; }
      if (src.startsWith("<?", i)) { const e = src.indexOf("?>", i); if (e < 0) err("Unterminated processing instruction"); const body = src.slice(i + 2, e); if (/^xml(\s|$)/.test(body)) decl = body.trim(); else add({ t: "pi", v: body }); i = e + 2; continue; }
      if (src.startsWith("<!", i)) { let d = 0, j = i; for (; j < src.length; j++) { if (src[j] === "[") d++; else if (src[j] === "]") d--; else if (src[j] === ">" && d <= 0) break; } if (j >= src.length) err("Unterminated declaration"); i = j + 1; continue; }
      if (src[i + 1] === "/") {
        closeRe.lastIndex = i; const m = closeRe.exec(src); if (!m) err("Malformed closing tag");
        const top = stack.pop(); if (!top) err(`Unexpected closing tag </${m[1]}>`);
        if (top.name !== m[1]) err(`Mismatched tag: expected </${top.name}> but found </${m[1]}>`);
        i += m[0].length; continue;
      }
      nameRe.lastIndex = i; const nm = nameRe.exec(src); if (!nm) err("Invalid tag name");
      const el = { t: "el", name: nm[1], attrs: [], kids: [], pos: i }, start = i;
      let j = i + nm[0].length, selfClose = false;
      for (;;) {
        const ws = /\s*/y; ws.lastIndex = j; const sp = ws.exec(src)[0]; j += sp.length;
        if (src[j] === ">") { j++; break; }
        if (src.startsWith("/>", j)) { j += 2; selfClose = true; break; }
        if (j >= src.length) err(`Unterminated start tag <${el.name}>`, start);
        if (!sp) err("Expected whitespace between attributes", j);
        attrRe.lastIndex = j; const am = attrRe.exec(src);
        if (!am) err("Malformed attribute (values must be quoted)", j);
        if (el.attrs.some(a => a[0] === am[1])) err(`Duplicate attribute "${am[1]}"`, j);
        el.attrs.push([am[1], decode(am[2] ?? am[3], j + am[0].indexOf(am[2] ?? am[3]))]);
        j += am[0].length;
      }
      if (!stack.length) { if (root) err("Multiple root elements", start); root = el; } else add(el);
      if (!selfClose) stack.push(el);
      i = j;
    }
    if (stack.length) err(`Unclosed element <${stack[stack.length - 1].name}>`, src.length);
    if (!root) err("No root element", 0);
    return { decl, root };
  };

  /* Convert a character offset into { line, col } (1-based). */
  lib.xmlLineCol = function (src, pos) {
    let line = 1, last = -1;
    for (let i = src.indexOf("\n"); i >= 0 && i < pos; i = src.indexOf("\n", i + 1)) { line++; last = i; }
    return { line, col: pos - last };
  };

  /* ---- Serializer --------------------------------------------------------- */
  const escText = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");

  lib.xmlSerialize = function (tree, { indent = "  ", minify = false } = {}) {
    const nl = minify ? "" : "\n", pad = l => minify ? "" : indent.repeat(l);
    const open = el => `<${el.name}${el.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("")}`;
    function ser(n, lvl) {
      if (n.t === "text") return escText(n.v);
      if (n.t === "cdata") return `<![CDATA[${n.v}]]>`;
      if (n.t === "comment") return `<!--${n.v}-->`;
      if (n.t === "pi") return `<?${n.v}?>`;
      // Whitespace-only text is only dropped between child elements; in a text-only element it is data (e.g. fixed-width blank fields).
      const structural = n.kids.some(k => k.t === "el" || k.t === "comment" || k.t === "pi");
      const kids = n.kids.filter(k => !(structural && k.t === "text" && !k.v.trim()) && !(minify && k.t === "comment"));
      if (!kids.length) return open(n) + "/>";
      if (kids.every(k => k.t === "text" || k.t === "cdata")) return `${open(n)}>${kids.map(k => ser(k, 0)).join("")}</${n.name}>`;
      const body = kids.map(k => pad(lvl + 1) + (k.t === "text" ? escText(k.v.trim()) : ser(k, lvl + 1))).join(nl);
      return `${open(n)}>${nl}${body}${nl}${pad(lvl)}</${n.name}>`;
    }
    return (tree.decl ? `<?${tree.decl}?>${nl}` : "") + ser(tree.root, 0);
  };
  lib.xmlFormat = (text, opts) => lib.xmlSerialize(lib.xmlParse(text), opts);

  /* ---- XML <-> JSON ---------------------------------------------------------
     Convention: attributes -> "@name", mixed/leaf text -> "#text", repeated siblings -> arrays,
     text-only elements -> plain strings. */
  lib.xmlToJson = function (tree, { stripPrefix = false, infer = false } = {}) {
    const nm = n => stripPrefix ? n.replace(/^[^:]+:/, "") : n;
    const val = s => { if (!infer) return s; if (/^(true|false)$/.test(s)) return s === "true"; if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s) && Number.isFinite(+s) && String(+s) === s) return +s; return s; };
    function conv(el) {
      const kids = el.kids.filter(k => k.t === "el");
      const text = el.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join("").trim();
      if (!el.attrs.length && !kids.length) return val(text);
      const o = {};
      el.attrs.forEach(([k, v]) => { if (!/^xmlns(:|$)/.test(k) || !stripPrefix) o["@" + nm(k)] = v; });
      kids.forEach(k => {
        const key = nm(k.name), v = conv(k);
        if (key in o) { if (!Array.isArray(o[key])) o[key] = [o[key]]; o[key].push(v); } else o[key] = v;
      });
      if (text) o["#text"] = val(text);
      return o;
    }
    return { [nm(tree.root.name)]: conv(tree.root) };
  };

  lib.jsonToXml = function (obj, { rootName = "root", indent = "  " } = {}) {
    const NAME = /^[A-Za-z_][\w.:-]*$/;
    const mk = (name, v) => {
      if (!NAME.test(name)) throw new Error(`"${name}" is not a valid XML element name`);
      const el = { t: "el", name, attrs: [], kids: [] };
      if (v === null || v === undefined) return el;
      if (typeof v !== "object") { el.kids.push({ t: "text", v: String(v) }); return el; }
      for (const [k, x] of Object.entries(v)) {
        if (k[0] === "@") { if (!NAME.test(k.slice(1))) throw new Error(`"${k.slice(1)}" is not a valid attribute name`); el.attrs.push([k.slice(1), String(x)]); }
        else if (k === "#text") el.kids.push({ t: "text", v: String(x) });
        else (Array.isArray(x) ? x : [x]).forEach(item => el.kids.push(mk(k, item)));
      }
      return el;
    };
    const keys = obj && typeof obj === "object" && !Array.isArray(obj) ? Object.keys(obj).filter(k => k[0] !== "@" && k !== "#text") : [];
    const root = keys.length === 1 && !Array.isArray(obj[keys[0]]) ? mk(keys[0], obj[keys[0]]) : mk(rootName, obj);
    return lib.xmlSerialize({ decl: null, root }, { indent });
  };

  /* Flat list of "path = value" lines: handy for mapping one message onto another. */
  lib.xmlPaths = function (tree) {
    const out = [];
    (function walk(el, path) {
      el.attrs.forEach(([k, v]) => out.push([`${path}/@${k}`, v]));
      const kids = el.kids.filter(k => k.t === "el"), text = el.kids.filter(k => k.t === "text" || k.t === "cdata").map(k => k.v).join("").trim();
      if (text && !kids.length) out.push([path, text]);
      const total = {}, seen = {};
      kids.forEach(k => total[k.name] = (total[k.name] || 0) + 1);
      kids.forEach(k => { seen[k.name] = (seen[k.name] || 0) + 1; walk(k, `${path}/${k.name}${total[k.name] > 1 ? `[${seen[k.name]}]` : ""}`); });
      if (!kids.length && !text && !el.attrs.length) out.push([path, ""]);
    })(tree.root, "/" + tree.root.name);
    return out;
  };

  /* Browser-only: XPath 1.0 via the DOM. Returns an array of strings. */
  lib.xpath = function (text, expr) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const pe = doc.querySelector("parsererror"); if (pe) throw new Error(pe.textContent.split("\n")[0]);
    const r = doc.evaluate(expr, doc, p => doc.lookupNamespaceURI(p), XPathResult.ANY_TYPE, null);
    if (r.resultType === XPathResult.NUMBER_TYPE) return [String(r.numberValue)];
    if (r.resultType === XPathResult.STRING_TYPE) return [r.stringValue];
    if (r.resultType === XPathResult.BOOLEAN_TYPE) return [String(r.booleanValue)];
    const out = []; let n;
    while ((n = r.iterateNext())) out.push(n.nodeType === 1 ? new XMLSerializer().serializeToString(n) : n.nodeType === 2 ? `${n.name}="${n.value}"` : n.textContent);
    return out;
  };

  DT.register({
    id: "xml", name: "XML Format, Validate & Convert", group: "XML & Mission Systems",
    desc: "Check XML for well-formedness with line and column, pretty-print or minify, convert to and from JSON, list every path = value, and run XPath. Works fully offline.",
    keywords: "xml pretty print validate well-formed json convert xpath paths uci oms message namespace",
    render(root) {
      root.innerHTML = `
        <div class="two">
          <div class="col"><label class="l" for="in">Input</label><textarea id="in" spellcheck="false" placeholder="<Message>…</Message>   or JSON to convert to XML"></textarea></div>
          <div class="col"><label class="l" for="out">Output</label><textarea id="out" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="opts">
          <label>Indent <select id="indent"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tab</option></select></label>
          <label><input type="checkbox" id="strip"> Strip namespace prefixes (→ JSON)</label>
          <label><input type="checkbox" id="infer"> Numbers / booleans (→ JSON)</label>
          <label>Root name <input type="text" id="rootname" class="mono" value="root" style="width:110px"> <span class="hint">(JSON → XML when no single root key)</span></label>
        </div>
        <div class="btns">
          <button class="btn primary" id="fmt" type="button">Format</button>
          <button class="btn" id="min" type="button">Minify</button>
          <button class="btn" id="tojson" type="button">XML → JSON</button>
          <button class="btn" id="toxml" type="button">JSON → XML</button>
          <button class="btn" id="paths" type="button">List paths</button>
          <button class="btn" id="swap" type="button">Output → Input</button>
          <button class="btn" data-copy="#out" type="button">Copy output</button>
          <button class="btn" data-clear="#in,#out" type="button">Clear</button>
        </div>
        <div class="status" id="st"></div>
        <div class="panel"><label class="l" for="xp">XPath 1.0 <span class="hint">(default namespaces need <code>*[local-name()='Name']</code>)</span></label>
          <div class="opts"><input type="text" id="xp" class="mono" style="flex:1;min-width:260px;max-width:620px" placeholder="//*[local-name()='UUID']/text()" spellcheck="false"><button class="btn" id="runxp" type="button">Run</button></div>
          <pre class="out" id="xpo" style="min-height:40px"></pre></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st");
      const indent = () => $("#indent").value === "tab" ? "\t" : " ".repeat(+$("#indent").value);
      const attempt = (fn, ok) => { try { out.value = fn(); DT.status(st, "ok", ok); } catch (e) { out.value = ""; DT.status(st, "err", e.message); } };
      function check() {
        if (!inp.value.trim()) return DT.status(st, "", "");
        try { const t = lib.xmlParse(inp.value); let n = 0; (function c(e) { n++; e.kids.forEach(k => k.t === "el" && c(k)); })(t.root); DT.status(st, "ok", `Well-formed · root <${t.root.name}> · ${n} elements`); }
        catch (e) { if (/^\s*[\[{"]/.test(inp.value)) DT.status(st, "", "Looks like JSON; use JSON → XML."); else DT.status(st, "err", e.message); }
      }
      $("#fmt").onclick = () => attempt(() => lib.xmlFormat(inp.value, { indent: indent() }), "Formatted");
      $("#min").onclick = () => attempt(() => lib.xmlFormat(inp.value, { minify: true }), "Minified");
      $("#tojson").onclick = () => attempt(() => JSON.stringify(lib.xmlToJson(lib.xmlParse(inp.value), { stripPrefix: $("#strip").checked, infer: $("#infer").checked }), null, 2), "XML → JSON (@attr, #text, repeated elements → arrays)");
      $("#toxml").onclick = () => attempt(() => lib.jsonToXml(JSON.parse(inp.value), { rootName: $("#rootname").value || "root", indent: indent() }), "JSON → XML");
      $("#paths").onclick = () => attempt(() => lib.xmlPaths(lib.xmlParse(inp.value)).map(([p, v]) => v === "" ? p : `${p} = ${v}`).join("\n"), "Paths listed");
      $("#swap").onclick = () => { inp.value = out.value; check(); };
      $("#runxp").onclick = () => { try { const r = lib.xpath(inp.value, $("#xp").value); $("#xpo").textContent = r.length ? r.join("\n") : "(no results)"; } catch (e) { $("#xpo").textContent = "Error: " + e.message; } };
      inp.addEventListener("input", DT.debounce(check, 200));
    },
  });
})();
