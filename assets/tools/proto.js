(function () {
  const lib = DT.lib;

  /* ---- tokenizer: identifiers (dots allowed), numbers, strings, punctuation; comments are skipped ---- */
  function tokenize(src) {
    const toks = []; let i = 0, line = 1;
    const isId = c => /[A-Za-z0-9_.+-]/.test(c);
    while (i < src.length) {
      const c = src[i];
      if (c === "\n") { line++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) throw new Error(`Line ${line}: unterminated comment.`);
        line += (src.slice(i, end).match(/\n/g) || []).length; i = end + 2; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1, s = "";
        while (j < src.length && src[j] !== c) { if (src[j] === "\\") { s += src[j + 1]; j += 2; } else s += src[j++]; if (src[j - 1] === "\n") throw new Error(`Line ${line}: unterminated string.`); }
        if (j >= src.length) throw new Error(`Line ${line}: unterminated string.`);
        toks.push({ t: "str", v: s, line }); i = j + 1; continue;
      }
      if ("{}[]()<>;,=".includes(c)) { toks.push({ t: c, v: c, line }); i++; continue; }
      if (isId(c)) { let j = i; while (j < src.length && isId(src[j])) j++; toks.push({ t: "id", v: src.slice(i, j), line }); i = j; continue; }
      throw new Error(`Line ${line}: unexpected character "${c}".`);
    }
    return toks;
  }

  const SCALARS = new Set(["double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes"]);
  lib.PROTO_SCALARS = SCALARS;

  /* Model: { syntax, package, imports[], messages[], enums[], services[] }.
     message: { name, fields[], oneofs[], messages[], enums[], reserved[] }; field: { name, num, type, label, oneof, map: {key, value} | null, line }. */
  lib.parseProto = function (src) {
    const toks = tokenize(String(src)); let p = 0;
    const peek = () => toks[p], at = v => toks[p] && toks[p].v === v && toks[p].t !== "str";
    const fail = (msg, tk = toks[p] || toks[toks.length - 1]) => { throw new Error(`Line ${tk ? tk.line : 1}: ${msg}`); };
    const next = () => toks[p++] || fail("unexpected end of file.");
    const expect = v => { const tk = next(); if (tk.v !== v || tk.t === "str") fail(`expected "${v}" but found "${tk.v}".`, tk); return tk; };
    const ident = () => { const tk = next(); if (tk.t !== "id") fail(`expected a name but found "${tk.v}".`, tk); return tk.v; };
    const number = () => { const tk = next(); if (tk.t !== "id" || !/^-?(0x[0-9a-f]+|[0-9]+)$/i.test(tk.v)) fail(`expected a number but found "${tk.v}".`, tk); return tk; };
    const skipStatement = () => {                         // option ...; / reserved ...; / extensions ...;  (balanced braces allowed in option values)
      let depth = 0;
      while (p < toks.length) { const tk = next(); if (tk.v === "{" && tk.t !== "str") depth++; else if (tk.v === "}" && tk.t !== "str") depth--; else if (tk.v === ";" && depth <= 0 && tk.t !== "str") return; }
      fail("missing ';'.");
    };
    const skipBlock = () => {                              // extend Foo { ... }
      while (p < toks.length && !at("{")) next();
      let depth = 0;
      do { const tk = next(); if (tk.t !== "str") { if (tk.v === "{") depth++; if (tk.v === "}") depth--; } } while (depth > 0 && p < toks.length);
    };
    const skipFieldOptions = () => { if (at("[")) { let depth = 0; do { const tk = next(); if (tk.t !== "str") { if (tk.v === "[") depth++; if (tk.v === "]") depth--; } } while (depth > 0 && p < toks.length); } };

    function parseEnum() {
      const name = ident(); expect("{"); const e = { name, values: [] };
      while (!at("}")) {
        if (!peek()) fail("enum is missing its closing brace.");
        if (at("option") || at("reserved")) { skipStatement(); continue; }
        if (at(";")) { next(); continue; }
        const vname = ident(); expect("="); const num = number(); skipFieldOptions(); expect(";");
        e.values.push({ name: vname, num: Number(num.v), line: num.line });
      }
      next(); return e;
    }
    function parseField(label, m, oneof) {
      let type = ident(), map = null;
      if (type === "map") {
        expect("<"); const key = ident(); expect(","); const value = ident(); expect(">"); map = { key, value }; type = `map<${key}, ${value}>`;
      }
      const name = ident(); expect("="); const num = number(); skipFieldOptions(); expect(";");
      m.fields.push({ name, num: Number(num.v), type, label, oneof, map, line: num.line });
    }
    function parseMessage() {
      const name = ident(); expect("{"); const m = { name, fields: [], oneofs: [], messages: [], enums: [], reserved: [] };
      while (!at("}")) {
        if (!peek()) fail(`message ${name} is missing its closing brace.`);
        const tk = peek();
        if (at(";")) { next(); continue; }
        if (at("message")) { next(); m.messages.push(parseMessage()); continue; }
        if (at("enum")) { next(); m.enums.push(parseEnum()); continue; }
        if (at("extend")) { skipBlock(); continue; }
        if (at("option") || at("extensions")) { skipStatement(); continue; }
        if (at("reserved")) { next(); const start = p; skipStatement(); m.reserved.push(toks.slice(start, p - 1).map(t => (t.t === "str" ? '"' + t.v + '"' : t.v)).join(" ")); continue; }
        if (at("oneof")) {
          next(); const oname = ident(); expect("{"); m.oneofs.push(oname);
          while (!at("}")) { if (!peek()) fail("oneof is missing its closing brace."); if (at("option")) { skipStatement(); continue; } parseField("", m, oname); }
          next(); continue;
        }
        let label = "";
        if (at("repeated") || at("optional") || at("required")) label = next().v;
        if (!peek()) fail("unexpected end of file.", tk);
        parseField(label, m, "");
      }
      next(); return m;
    }

    const model = { syntax: "proto2", package: "", imports: [], messages: [], enums: [], services: [] };
    while (p < toks.length) {
      if (at(";")) { next(); continue; }
      const tk = next();
      if (tk.v === "syntax") { expect("="); model.syntax = next().v; expect(";"); }
      else if (tk.v === "edition") { expect("="); model.syntax = "edition " + next().v; expect(";"); }
      else if (tk.v === "package") { model.package = ident(); expect(";"); }
      else if (tk.v === "import") { if (at("public") || at("weak")) next(); model.imports.push(next().v); expect(";"); }
      else if (tk.v === "option") { p--; skipStatement(); }
      else if (tk.v === "message") model.messages.push(parseMessage());
      else if (tk.v === "enum") model.enums.push(parseEnum());
      else if (tk.v === "extend") skipBlock();
      else if (tk.v === "service") {
        const s = { name: ident(), rpcs: [] }; expect("{");
        while (!at("}")) {
          if (!peek()) fail("service is missing its closing brace.");
          if (at("option")) { skipStatement(); continue; }
          if (at(";")) { next(); continue; }
          expect("rpc"); const rname = ident(); expect("(");
          const cs = at("stream"); if (cs) next(); const req = ident(); expect(")"); expect("returns"); expect("(");
          const ss = at("stream"); if (ss) next(); const res = ident(); expect(")");
          if (at("{")) { let d = 0; do { const t2 = next(); if (t2.v === "{") d++; if (t2.v === "}") d--; } while (d > 0 && p < toks.length); } else expect(";");
          s.rpcs.push({ name: rname, req, res, clientStream: cs, serverStream: ss });
        }
        next(); model.services.push(s);
      } else fail(`unexpected "${tk.v}" at the top level.`, tk);
    }
    return model;
  };

  /* Problems worth flagging: duplicate or reserved field numbers/names, enum without a zero value in proto3, numbers out of range. */
  lib.protoLint = function (model) {
    const out = [];
    const walk = (m, scope) => {
      const where = scope + m.name, nums = new Map(), names = new Set();
      for (const f of m.fields) {
        if (nums.has(f.num)) out.push(`${where}: field number ${f.num} is used by both "${nums.get(f.num)}" and "${f.name}" (line ${f.line}).`); else nums.set(f.num, f.name);
        if (names.has(f.name)) out.push(`${where}: field name "${f.name}" appears twice (line ${f.line}).`); names.add(f.name);
        if (!(f.num >= 1 && f.num <= 536870911) || (f.num >= 19000 && f.num <= 19999)) out.push(`${where}: field number ${f.num} of "${f.name}" is outside the allowed range (1-536870911, excluding 19000-19999).`);
        if (f.map && !/^(int|uint|sint|fixed|sfixed)(32|64)$|^bool$|^string$/.test(f.map.key)) out.push(`${where}: map key type "${f.map.key}" is not allowed.`);
        for (const r of m.reserved) {
          const nm = r.match(/"([^"]*)"/g); if (nm && nm.some(x => x === `"${f.name}"`)) out.push(`${where}: "${f.name}" is also listed as reserved.`);
          const rr = r.replace(/"[^"]*"/g, " ").split(",").map(s => s.trim()).filter(Boolean);
          for (const part of rr) { const mm = part.match(/^(\d+)(?: to (\d+|max))?$/); if (mm) { const lo = +mm[1], hi = mm[2] ? (mm[2] === "max" ? Infinity : +mm[2]) : lo; if (f.num >= lo && f.num <= hi) out.push(`${where}: field number ${f.num} of "${f.name}" is reserved.`); } }
        }
      }
      m.enums.forEach(e => enumLint(e, where + "."));
      m.messages.forEach(n => walk(n, where + "."));
    };
    const enumLint = (e, scope) => {
      if (model.syntax === "proto3" && e.values.length && !e.values.some(v => v.num === 0)) out.push(`${scope}${e.name}: a proto3 enum needs a value numbered 0.`);
      else if (model.syntax === "proto3" && e.values.length && e.values[0].num !== 0) out.push(`${scope}${e.name}: the first value of a proto3 enum must be 0.`);
    };
    model.messages.forEach(m => walk(m, ""));
    model.enums.forEach(e => enumLint(e, ""));
    return out;
  };

  /* Find a message or enum by (possibly partial) name, searching outward from the scope like protoc does. */
  function resolve(model, scopeChain, name) {
    const all = [];
    const collect = (list, prefix) => list.forEach(m => { all.push(["m", prefix + m.name, m]); collect(m.messages, prefix + m.name + "."); m.enums.forEach(e => all.push(["e", prefix + m.name + "." + e.name, e])); });
    collect(model.messages, ""); model.enums.forEach(e => all.push(["e", e.name, e]));
    const pkg = model.package ? model.package + "." : "";
    const clean = name.replace(/^\./, "");
    const stripped = pkg && clean.startsWith(pkg) ? clean.slice(pkg.length) : clean;
    for (let i = scopeChain.length; i >= 0; i--) {
      const full = scopeChain.slice(0, i).concat(stripped).join(".");
      const hit = all.find(a => a[1] === full); if (hit) return hit;
    }
    return null;
  }

  const WELL_KNOWN = {
    "google.protobuf.Timestamp": "2024-01-01T00:00:00Z", "google.protobuf.Duration": "1.5s", "google.protobuf.Empty": {}, "google.protobuf.Struct": {}, "google.protobuf.Value": null,
    "google.protobuf.ListValue": [], "google.protobuf.Any": { "@type": "type.googleapis.com/example.Message" }, "google.protobuf.FieldMask": "a,b.c",
    "google.protobuf.StringValue": "string", "google.protobuf.BoolValue": true, "google.protobuf.Int32Value": 1, "google.protobuf.Int64Value": "1", "google.protobuf.UInt32Value": 1,
    "google.protobuf.UInt64Value": "1", "google.protobuf.FloatValue": 1.5, "google.protobuf.DoubleValue": 1.5, "google.protobuf.BytesValue": "AAEC",
  };
  const scalarSample = t => {
    if (t === "string") return "string";
    if (t === "bool") return true;
    if (t === "bytes") return "AAEC";
    if (t === "float" || t === "double") return 1.5;
    if (/64$/.test(t)) return "1";                        // 64-bit integers are JSON strings in proto3 JSON
    return 1;
  };

  /* A JSON sample for one message using the proto3 JSON mapping. opts.camel (default true) renames fields to lowerCamelCase. */
  lib.protoSample = function (model, msgName, opts = {}) {
    const camel = opts.camel !== false, seen = [];
    const jsonName = n => (camel ? n.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()) : n);
    const hit = resolve(model, [], msgName);
    if (!hit || hit[0] !== "m") throw new Error(`Message "${msgName}" not found.`);
    const build = (fullName, m) => {
      const chain = fullName.split("."), out = {}, usedOneof = new Set();
      if (seen.filter(x => x === fullName).length >= 2) return {};
      seen.push(fullName);
      for (const f of m.fields) {
        if (f.oneof) { if (usedOneof.has(f.oneof)) continue; usedOneof.add(f.oneof); }
        let v;
        if (f.map) v = { [f.map.key === "bool" ? "true" : f.map.key === "string" ? "key" : "1"]: valueOf(chain, f.map.value) };
        else { v = valueOf(chain, f.type); if (f.label === "repeated") v = [v]; }
        out[jsonName(f.name)] = v;
      }
      seen.pop();
      return out;
    };
    function valueOf(chain, type) {
      if (SCALARS.has(type)) return scalarSample(type);
      const clean = type.replace(/^\./, "");
      if (Object.prototype.hasOwnProperty.call(WELL_KNOWN, clean)) return WELL_KNOWN[clean];
      const h = resolve(model, chain, type);
      if (!h) return null;                                // unknown (imported) type
      if (h[0] === "e") { const vals = h[2].values; return (vals.find(v => v.num !== 0) || vals[0] || { name: "" }).name; }
      return build(h[1], h[2]);
    }
    return build(hit[1], hit[2]);
  };

  lib.protoOutline = function (model) {
    const lines = [];
    if (model.package) lines.push(`package ${model.package}`);
    const msg = (m, ind) => {
      lines.push(`${ind}message ${m.name}`);
      let lastOneof = "";
      for (const f of m.fields) {
        if (f.oneof !== lastOneof) { if (f.oneof) lines.push(`${ind}  oneof ${f.oneof}:`); lastOneof = f.oneof; }
        lines.push(`${ind}  ${f.oneof ? "  " : ""}${String(f.num).padStart(3)}  ${f.label ? f.label + " " : ""}${f.type} ${f.name}`);
      }
      m.enums.forEach(e => en(e, ind + "  ")); m.messages.forEach(n => msg(n, ind + "  "));
    };
    const en = (e, ind) => lines.push(`${ind}enum ${e.name} { ${e.values.map(v => `${v.name}=${v.num}`).join(", ")} }`);
    model.enums.forEach(e => en(e, "")); model.messages.forEach(m => msg(m, ""));
    model.services.forEach(s => { lines.push(`service ${s.name}`); s.rpcs.forEach(r => lines.push(`  rpc ${r.name}(${r.clientStream ? "stream " : ""}${r.req}) returns (${r.serverStream ? "stream " : ""}${r.res})`)); });
    return lines.join("\n");
  };

  const EXAMPLE = `syntax = "proto3";
package shop.v1;

import "google/protobuf/timestamp.proto";

enum Status { STATUS_UNSPECIFIED = 0; ACTIVE = 1; CLOSED = 2; }

message Order {
  string id = 1;
  Status status = 2;
  repeated Item items = 3;
  map<string, string> labels = 4;
  google.protobuf.Timestamp created_at = 5;
  oneof payment { string card_token = 6; string invoice_ref = 7; }
  message Item { string sku = 1; int32 qty = 2; int64 price_cents = 3; }
}

service Orders { rpc Get(GetRequest) returns (Order); rpc Watch(GetRequest) returns (stream Order); }
message GetRequest { string id = 1; }`;

  DT.register({
    id: "proto", name: "Protobuf Viewer", group: "Translate",
    desc: "Paste a .proto file: see messages, fields, enums and services as an outline, catch duplicate or reserved field numbers, and generate a JSON sample for any message.",
    keywords: "protocol buffers grpc proto3 schema message json sample",
    render(root) {
      root.innerHTML = `
        <div class="two">
          <div class="col"><label class="l" for="in">.proto source</label><textarea id="in" class="md" spellcheck="false" style="min-height:320px"></textarea>
            <div class="btns"><button class="btn" id="ex" type="button">Load example</button><button class="btn" data-clear="#in" type="button">Clear</button></div></div>
          <div class="col"><label class="l" for="out">Outline</label><textarea id="out" class="md" spellcheck="false" readonly style="min-height:320px"></textarea></div>
        </div>
        <div class="status" id="st"></div>
        <div id="lint"></div>
        <div class="opts"><label>JSON sample for <select id="msg"></select></label><label><input type="checkbox" id="camel" checked> lowerCamelCase names (proto3 JSON)</label></div>
        <div class="col"><label class="l" for="json">Sample</label><textarea id="json" class="md" spellcheck="false" readonly></textarea><div class="btns"><button class="btn" data-copy="#json" type="button">Copy sample</button></div></div>`;
      const $ = s => root.querySelector(s);
      const names = model => { const l = []; const walk = (m, p) => { l.push(p + m.name); m.messages.forEach(n => walk(n, p + m.name + ".")); }; model.messages.forEach(m => walk(m, "")); return l; };
      function run() {
        const src = $("#in").value;
        if (!src.trim()) { $("#out").value = ""; $("#json").value = ""; $("#msg").innerHTML = ""; $("#lint").innerHTML = ""; DT.status($("#st"), "", "Paste a .proto file."); return; }
        try {
          const model = lib.parseProto(src), list = names(model), keep = $("#msg").value;
          $("#out").value = lib.protoOutline(model);
          $("#msg").innerHTML = list.map(n => `<option>${DT.esc(n)}</option>`).join(""); if (list.includes(keep)) $("#msg").value = keep;
          const problems = lib.protoLint(model);
          const count = (n => n.length)(list);
          DT.status($("#st"), problems.length ? "warn" : "ok", `${model.syntax} · ${count} message${count === 1 ? "" : "s"}, ${model.services.length} service${model.services.length === 1 ? "" : "s"}${model.imports.length ? " · imports not loaded: types from them show as null in the sample" : ""}`);
          $("#lint").innerHTML = problems.length ? `<ul class="hint">${problems.map(p => `<li>${DT.esc(p)}</li>`).join("")}</ul>` : "";
          $("#json").value = list.length ? JSON.stringify(lib.protoSample(model, $("#msg").value, { camel: $("#camel").checked }), null, 2) : "";
        } catch (e) { $("#out").value = ""; $("#json").value = ""; $("#lint").innerHTML = ""; DT.status($("#st"), "err", e.message); }
      }
      $("#ex").onclick = () => { $("#in").value = EXAMPLE; run(); };
      $("#in").addEventListener("input", DT.debounce(run, 150)); $("#msg").onchange = $("#camel").onchange = run;
      run();
    },
  });
})();
