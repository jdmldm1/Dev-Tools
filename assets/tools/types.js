(function () {
  const lib = DT.lib;

  /* ---- Schema inference ---------------------------------------------------
     { t: 'string'|'int'|'float'|'bool'|'null'|'unknown'|'mixed'|'array'|'object', nullable?, items?, f? }
     object: f = { key: { s: schema, opt: bool } } */
  function infer(v) {
    if (v === null) return { t: "null" };
    if (Array.isArray(v)) return { t: "array", items: v.length ? v.map(infer).reduce(merge) : { t: "unknown" } };
    switch (typeof v) {
      case "string": return { t: "string" };
      case "number": return { t: Number.isInteger(v) ? "int" : "float" };
      case "boolean": return { t: "bool" };
      default: {
        const f = {};
        for (const k of Object.keys(v)) f[k] = { s: infer(v[k]), opt: false };
        return { t: "object", f };
      }
    }
  }
  function merge(a, b) {
    const r = merge0(a, b);
    if (a.nullable || b.nullable) r.nullable = true;
    return r;
  }
  function merge0(a, b) {
    if (a.t === "unknown") return { ...b };
    if (b.t === "unknown") return { ...a };
    if (a.t === "null") return { ...b, nullable: true };
    if (b.t === "null") return { ...a, nullable: true };
    if (a.t === b.t) {
      if (a.t === "array") return { t: "array", items: merge(a.items, b.items) };
      if (a.t === "object") {
        const f = {};
        for (const k of new Set([...Object.keys(a.f), ...Object.keys(b.f)])) {
          const x = a.f[k], y = b.f[k];
          f[k] = x && y ? { s: merge(x.s, y.s), opt: x.opt || y.opt } : { s: (x || y).s, opt: true };
        }
        return { t: "object", f };
      }
      return { t: a.t };
    }
    if ((a.t === "int" && b.t === "float") || (a.t === "float" && b.t === "int")) return { t: "float" };
    return { t: "mixed" };
  }
  lib.inferSchema = infer;

  /* ---- Naming ------------------------------------------------------------ */
  const ACRONYMS = new Set(["id", "url", "uri", "api", "http", "https", "ip", "uuid", "json", "xml", "html", "sql", "ssh", "tcp", "udp", "dns", "cpu", "ui"]);
  const goName = s => lib.words(s).map(w => ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()).join("") || "Field";
  const singular = s => /ies$/i.test(s) ? s.replace(/ies$/i, "y") : /(ss|us)$/i.test(s) ? s : s.replace(/s$/i, "");
  const PYKW = new Set(["False","None","True","and","as","assert","async","await","break","class","continue","def","del","elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not","or","pass","raise","return","try","while","with","yield"]);
  const safeIdent = (s, fallback) => { let n = s; if (/^\d/.test(n)) n = "_" + n; return n || fallback; };

  /* Walk the schema; each emitter supplies: typeName(schema, hint) -> string and registers struct definitions. */
  function makeCtx(rootName) {
    const defs = [], used = new Set();
    const uniq = base => { let n = base, i = 2; while (used.has(n)) n = base + i++; used.add(n); return n; };
    return { defs, uniq, rootName };
  }

  /* ---- Emitters ---------------------------------------------------------- */
  const EMIT = {};

  EMIT.ts = function (schema, root) {
    const ctx = makeCtx(root);
    const qkey = k => /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
    function ty(s, hint) {
      let r;
      switch (s.t) {
        case "string": r = "string"; break;
        case "int": case "float": r = "number"; break;
        case "bool": r = "boolean"; break;
        case "null": return "null";
        case "unknown": case "mixed": r = "unknown"; break;
        case "array": { const i = ty(s.items, singular(hint)); r = /[|&]/.test(i) ? `(${i})[]` : i + "[]"; break; }
        case "object": {
          const name = ctx.uniq(lib.pascal(hint) || "Item");
          const lines = Object.entries(s.f).map(([k, v]) => `  ${qkey(k)}${v.opt ? "?" : ""}: ${ty(v.s, k)};`);
          ctx.defs.push(`export interface ${name} {\n${lines.join("\n")}\n}`);
          r = name; break;
        }
      }
      return s.nullable ? r + " | null" : r;
    }
    if (schema.t !== "object") return `export type ${root} = ${ty(schema, root + "Item")};`;
    ctx.uniq(root);
    const lines = Object.entries(schema.f).map(([k, v]) => `  ${qkey(k)}${v.opt ? "?" : ""}: ${ty(v.s, k)};`);
    return [`export interface ${root} {\n${lines.join("\n")}\n}`, ...ctx.defs].join("\n\n");
  };

  EMIT.go = function (schema, root) {
    const ctx = makeCtx(root);
    function ty(s, hint, opt) {
      let r, ptr = false;
      switch (s.t) {
        case "string": r = "string"; ptr = true; break;
        case "int": r = "int64"; ptr = true; break;
        case "float": r = "float64"; ptr = true; break;
        case "bool": r = "bool"; ptr = true; break;
        case "null": case "unknown": case "mixed": return "any";
        case "array": return "[]" + ty(s.items, singular(hint), false);
        case "object": { r = struct(s, hint); ptr = true; break; }
      }
      return (ptr && (opt || s.nullable) ? "*" : "") + r;
    }
    function struct(s, hint) {
      const name = ctx.uniq(goName(hint) || "Item");
      const slot = ctx.defs.push("") - 1;
      const entries = Object.entries(s.f);
      const w = Math.max(...entries.map(([k]) => goName(k).length), 1);
      const types = entries.map(([k, v]) => ty(v.s, k, v.opt));
      const tw = Math.max(...types.map(t => t.length), 1);
      const lines = entries.map(([k, v], i) => `\t${goName(k).padEnd(w)} ${types[i].padEnd(tw)} \`json:"${k}${v.opt ? ",omitempty" : ""}"\``);
      ctx.defs[slot] = `type ${name} struct {\n${lines.join("\n")}\n}`;
      return name;
    }
    if (schema.t !== "object") return `type ${root} ${ty(schema, root + "Item", false)}`;
    ctx.uniq(root);
    const slot = ctx.defs.push("") - 1;
    const entries = Object.entries(schema.f);
    const w = Math.max(...entries.map(([k]) => goName(k).length), 1);
    const types = entries.map(([k, v]) => ty(v.s, k, v.opt));
    const tw = Math.max(...types.map(t => t.length), 1);
    ctx.defs[slot] = `type ${root} struct {\n${entries.map(([k, v], i) => `\t${goName(k).padEnd(w)} ${types[i].padEnd(tw)} \`json:"${k}${v.opt ? ",omitempty" : ""}"\``).join("\n")}\n}`;
    return ctx.defs.join("\n\n");
  };

  EMIT.cs = function (schema, root) {
    const ctx = makeCtx(root);
    function ty(s, hint, opt) {
      let r, ref = false;
      switch (s.t) {
        case "string": r = "string"; ref = true; break;
        case "int": r = "long"; break;
        case "float": r = "double"; break;
        case "bool": r = "bool"; break;
        case "null": case "unknown": case "mixed": return "object?";
        case "array": r = `List<${ty(s.items, singular(hint), false)}>`; ref = true; break;
        case "object": r = klass(s, hint); ref = true; break;
      }
      return r + (opt || s.nullable ? "?" : "");
    }
    function body(s, name) {
      const lines = Object.entries(s.f).map(([k, v]) => {
        const prop = lib.pascal(k) || "Field";
        return `    [JsonPropertyName(${JSON.stringify(k)})]\n    public ${ty(v.s, k, v.opt)} ${safeIdent(prop, "Field")} { get; set; }`;
      });
      return `public class ${name}\n{\n${lines.join("\n\n")}\n}`;
    }
    function klass(s, hint) {
      const name = ctx.uniq(lib.pascal(hint) || "Item");
      const slot = ctx.defs.push("") - 1;
      ctx.defs[slot] = body(s, name);
      return name;
    }
    const head = "using System.Text.Json.Serialization;\n\n";
    if (schema.t !== "object") return `${head}// root is ${schema.t}: ${ty(schema, root + "Item", false)}`;
    ctx.uniq(root);
    const slot = ctx.defs.push("") - 1;
    ctx.defs[slot] = body(schema, root);
    return head + ctx.defs.join("\n\n");
  };

  EMIT.py = function (schema, root) {
    const ctx = makeCtx(root);
    function ty(s, hint) {
      let r;
      switch (s.t) {
        case "string": r = "str"; break;
        case "int": r = "int"; break;
        case "float": r = "float"; break;
        case "bool": r = "bool"; break;
        case "null": return "None";
        case "unknown": case "mixed": r = "Any"; break;
        case "array": r = `list[${ty(s.items, singular(hint))}]`; break;
        case "object": r = cls(s, hint); break;
      }
      return s.nullable ? `${r} | None` : r;
    }
    function body(s, name) {
      const entries = Object.entries(s.f).map(([k, v]) => ({ k, id: (id => PYKW.has(id) ? id + "_" : id)(safeIdent(lib.snake(k), "field")), v }));
      const req = entries.filter(e => !e.v.opt), opt = entries.filter(e => e.v.opt);
      const line = (e, def) => `    ${e.id}: ${ty(e.v.s, e.k)}${e.v.opt ? " | None" : ""}${def ? " = None" : ""}`;
      return `@dataclass\nclass ${name}:\n${[...req.map(e => line(e, false)), ...opt.map(e => line(e, true))].join("\n") || "    pass"}`;
    }
    function cls(s, hint) {
      const name = ctx.uniq(lib.pascal(hint) || "Item");
      const slot = ctx.defs.push("") - 1;
      ctx.defs[slot] = body(s, name);
      return name;
    }
    const head = "from __future__ import annotations\nfrom dataclasses import dataclass\nfrom typing import Any\n\n\n";
    if (schema.t !== "object") return `${head}${root} = ${ty(schema, root + "Item")}`;
    ctx.uniq(root);
    const slot = ctx.defs.push("") - 1;
    ctx.defs[slot] = body(schema, root);
    // children are defined before the parent so the file imports cleanly without forward refs
    const [parent, ...kids] = ctx.defs;
    return head + [...kids.reverse(), parent].join("\n\n\n") +
      "\n\n\n# Keys are snake_cased; map them from the JSON yourself (or use pydantic aliases).";
  };

  EMIT.rust = function (schema, root) {
    const ctx = makeCtx(root);
    function ty(s, hint) {
      let r;
      switch (s.t) {
        case "string": r = "String"; break;
        case "int": r = "i64"; break;
        case "float": r = "f64"; break;
        case "bool": r = "bool"; break;
        case "null": case "unknown": case "mixed": return "serde_json::Value";
        case "array": r = `Vec<${ty(s.items, singular(hint))}>`; break;
        case "object": r = st(s, hint); break;
      }
      return s.nullable ? `Option<${r}>` : r;
    }
    const KW = new Set(["type", "match", "fn", "let", "mod", "use", "struct", "enum", "impl", "ref", "self", "super", "crate", "where", "loop", "move", "box", "mut", "pub", "static", "trait", "async", "await", "dyn", "in", "as", "if", "else", "for", "while", "return", "const", "unsafe", "extern", "true", "false"]);
    function body(s, name) {
      const lines = Object.entries(s.f).map(([k, v]) => {
        let id = safeIdent(lib.snake(k), "field"), attrs = [];
        if (KW.has(id)) id = "r#" + id;
        if (lib.snake(k) !== k || id.startsWith("r#")) attrs.push(`rename = ${JSON.stringify(k)}`);
        if (v.opt) attrs.push(`skip_serializing_if = "Option::is_none"`, `default`);
        const t = ty(v.s, k), full = v.opt && !t.startsWith("Option<") ? `Option<${t}>` : t;
        return `${attrs.length ? `    #[serde(${attrs.join(", ")})]\n` : ""}    pub ${id}: ${full},`;
      });
      return `#[derive(Debug, Serialize, Deserialize)]\npub struct ${name} {\n${lines.join("\n")}\n}`;
    }
    function st(s, hint) {
      const name = ctx.uniq(lib.pascal(hint) || "Item");
      const slot = ctx.defs.push("") - 1;
      ctx.defs[slot] = body(s, name);
      return name;
    }
    const head = "use serde::{Deserialize, Serialize};\n\n";
    if (schema.t !== "object") return `${head}pub type ${root} = ${ty(schema, root + "Item")};`;
    ctx.uniq(root);
    const slot = ctx.defs.push("") - 1;
    ctx.defs[slot] = body(schema, root);
    return head + ctx.defs.join("\n\n");
  };

  lib.jsonToTypes = function (json, lang, root = "Root") {
    const v = typeof json === "string" ? JSON.parse(json) : json;
    return EMIT[lang](infer(v), lib.pascal(root) || "Root");
  };

  DT.register({
    id: "types", name: "JSON → Code Types", group: "Translate",
    desc: "Generate TypeScript, Go, C#, Python or Rust types from a JSON sample. Arrays are merged so fields missing in some items become optional.",
    keywords: "typescript interface struct dataclass class model codegen quicktype",
    render(root) {
      root.innerHTML = `
        <div class="opts">
          <label>Language <select id="lang"><option value="ts">TypeScript</option><option value="go">Go</option><option value="cs">C#</option><option value="py">Python (dataclasses)</option><option value="rust">Rust (serde)</option></select></label>
          <label>Root name <input type="text" id="name" value="Root" style="width:140px" class="mono"></label>
        </div>
        <div class="two">
          <div class="col"><label class="l" for="in">JSON sample</label><textarea id="in" spellcheck="false" placeholder='{"id": 1, "name": "Ada", "tags": ["a", "b"]}'></textarea></div>
          <div class="col"><label class="l" for="out">Generated code</label><textarea id="out" spellcheck="false" readonly></textarea></div>
        </div>
        <div class="btns"><button class="btn" data-copy="#out" type="button">Copy output</button><button class="btn" data-clear="#in,#out" type="button">Clear</button></div>
        <div class="status" id="st"></div>`;
      const $ = s => root.querySelector(s), inp = $("#in"), out = $("#out"), st = $("#st");
      function run() {
        if (!inp.value.trim()) { out.value = ""; DT.status(st, "", ""); return; }
        try { out.value = lib.jsonToTypes(inp.value, $("#lang").value, $("#name").value); DT.status(st, "ok", "Generated"); }
        catch (e) { out.value = ""; DT.status(st, "err", e instanceof SyntaxError ? lib.jsonError(inp.value, e) : e.message); }
      }
      inp.addEventListener("input", DT.debounce(run, 200));
      $("#lang").onchange = $("#name").oninput = run;
    },
  });
})();
