/* Message Builder: a form generated from the loaded schema. Pick a message, fill it in (enumerations as dropdowns, optional parts behind
   checkboxes, choices as radio sets, repeating members as lists, abstract types as a subtype picker) and watch the XML and OMS JSON and
   the validation result update. Optional parts are only built when switched on, so even very large messages open quickly. */
(function () {
  const lib = DT.lib, esc = DT.esc;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const XSI = "http://www.w3.org/2001/XMLSchema-instance";
  const MAX_DEPTH = 16;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => (Math.random() * 16 | 0).toString(16)));
  const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch (_) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } } };

  DT.register({
    id: "msgbuilder", name: "Message Builder", group: "UCI",
    desc: "Compose a UCI message from a form generated from the loaded schema: enumerations as dropdowns with their meanings, optional parts behind checkboxes, choices, repeating lists and subtype pickers. Live XML and OMS JSON output with validation, a one-click header fill, and a hand-off to the NATS or CAL explorer's publisher.",
    keywords: "uci message builder form compose create edit generate xml json validate publish header enum choice optional schema",
    render(root) {
      const $ = s => root.querySelector(s);
      let model = lib.sharedSchema.model, current = null, rootNode = null, timer = 0, outTab = "xml";

      root.innerHTML = `
        <div class="panel">${lib.schemaPanelHtml("the form")}</div>
        <div id="bw" hidden>
          <div class="opts"><input type="text" id="msg" class="mono" list="msglist" placeholder="message name, e.g. SystemStatus" spellcheck="false" style="width:300px" autocomplete="off"><datalist id="msglist"></datalist>
            <label title="Switch on every optional part (large for big messages)"><input type="checkbox" id="all"> include all optional parts</label><button class="btn" id="build" type="button">Build form</button><button class="btn" id="hdr" type="button" title="System id, service id, timestamp and mode of the MessageHeader">Fill header</button><button class="btn" id="reset" type="button">Reset</button></div>
          <div class="status" id="bst"></div>
          <div class="xg" style="grid-template-columns:minmax(360px,1.1fr) minmax(320px,.9fr)"><div id="form" class="mb"></div>
            <div class="left" style="position:sticky;top:8px"><div id="vbadge" style="margin-bottom:6px"></div><div class="tabs"><button class="tab on" data-o="xml" type="button">XML</button><button class="tab" data-o="json" type="button">OMS JSON</button><button class="tab" data-o="err" type="button">Problems</button></div>
              <pre class="out" id="out" style="max-height:56vh;overflow:auto"></pre>
              <div class="btns"><button class="btn" id="copy" type="button">Copy</button><button class="btn" id="dl" type="button">Download</button><button class="btn" id="tonats" type="button">Publish in NATS Explorer</button><button class="btn" id="tocal" type="button">Publish in CAL Explorer</button></div></div></div>
        </div>
        <div class="hint" id="nomodel">Load the schema above to build messages from it.</div>`;
      DT.wire(root);

      const sp = lib.schemaPanel(root, m => {
        model = m; $("#bw").hidden = !m; $("#nomodel").hidden = !!m;
        $("#msglist").innerHTML = m ? [...m.elements.keys()].sort().map(k => `<option value="${esc(k)}">`).join("") : "";
        if (!m) { $("#form").innerHTML = ""; current = null; }
      });

      /* ---------- the form ---------- */
      const concretes = typeName => {
        const out = [], seen = new Set(), q = [typeName];
        while (q.length) { const n = q.shift(); if (seen.has(n)) continue; seen.add(n); const t = model.types.get(n); if (t && !t.abstract && t.kind === "complex") out.push(n); q.push(...(model.derived.get(n) || [])); }
        return out;
      };
      const changed = () => { clearTimeout(timer); timer = setTimeout(update, 120); };
      const docOf = (m, t) => lib.uciFirstPara(m.doc || (t && t.doc) || "");

      /* a simple value: returns { el, text() } */
      function leaf(typeName, path, initial) {
        const info = lib.xsdSimpleInfo(model, typeName), box = el("span", "mb-leaf");
        let input;
        const sample = initial !== undefined ? initial : (() => { try { return lib.xsdSampleValue(model, info); } catch (_) { return ""; } })();
        if (info.enumeration && info.enumeration.length) {
          input = el("select", "mono"); const docs = new Map(); for (let t = model.types.get(typeName); t; t = t.base ? model.types.get(t.base) : null) if (t.facets && t.facets.enumeration) { t.facets.enumeration.forEach(e => docs.set(e.value, e.doc)); break; }
          for (const v of info.enumeration) { const o = el("option", "", v); o.value = v; if (docs.get(v)) o.title = lib.uciFirstPara(docs.get(v)); input.append(o); }
          input.value = info.enumeration.includes(sample) ? sample : info.enumeration[0];
          const hint = el("span", "hint"); const show = () => { hint.textContent = docs.get(input.value) ? "— " + lib.uciFirstPara(docs.get(input.value)).slice(0, 140) : ""; }; input.addEventListener("change", show); show(); box.append(input, hint);
        } else if (info.builtin === "boolean") {
          input = el("select", "mono"); for (const v of ["true", "false"]) { const o = el("option", "", v); o.value = v; input.append(o); } input.value = sample === "false" || sample === "0" ? "false" : "true"; box.append(input);
        } else {
          const long = +info.facets.maxLength > 200 && !/\d/.test(info.builtin);
          input = el(long ? "textarea" : "input", "mono"); if (!long) input.type = "text"; else input.rows = 2;
          input.value = sample; input.spellcheck = false;
          const f = info.facets, range = [f.minInclusive ?? f.minExclusive, f.maxInclusive ?? f.maxExclusive].filter(x => x !== undefined);
          input.placeholder = info.builtin + (range.length === 2 ? ` ${range[0]}..${range[1]}` : "") + (f.maxLength ? ` max ${f.maxLength}` : "");
          box.append(input);
          if (/dateTime/.test(info.builtin)) { const b = el("button", "mini", "now"); b.type = "button"; b.onclick = () => { input.value = nowIso(); input.dispatchEvent(new Event("input", { bubbles: true })); }; box.append(b); }
          if (/UniversallyUniqueIdentifier|UUID/i.test(typeName) || /^[0-9a-f]{8}-/.test(sample)) { const b = el("button", "mini", "new id"); b.type = "button"; b.onclick = () => { input.value = uuid(); input.dispatchEvent(new Event("input", { bubbles: true })); }; box.append(b); }
        }
        input.dataset.path = path; input.addEventListener("input", changed); input.addEventListener("change", changed);
        return { el: box, text: () => input.value, input };
      }

      /* the content of one element of a complex type: { el, attrs(), kids() } */
      function group(typeName, path, depth) {
        const holder = el("div", "mb-group");
        const t = model.types.get(typeName);
        let sub = null, xsiType = "";
        const build = tn => {
          holder.querySelectorAll(":scope > .mb-body").forEach(x => x.remove());
          sub = body(tn, path, depth); sub.el.classList.add("mb-body"); holder.append(sub.el); xsiType = tn !== typeName ? tn : "";
        };
        if (t && t.abstract) {
          const opts = concretes(typeName);
          if (!opts.length) { holder.append(el("div", "hint", `${typeName} is abstract and the schema defines no concrete subtype.`)); return { el: holder, attrs: () => [], kids: () => [] }; }
          const sel = el("select", "mono"); for (const o of opts) { const op = el("option", "", o); op.value = o; sel.append(op); }
          const row = el("div", "mb-sub"); row.append(el("span", "hint", "type: "), sel); holder.append(row);
          sel.onchange = () => { build(sel.value); changed(); };
          build(opts[0]);
        } else build(typeName);
        return { el: holder, attrs: () => (xsiType ? [["xsi:type", xsiType]] : []).concat(sub.attrs()), kids: () => sub.kids() };
      }

      function body(typeName, path, depth) {
        const out = el("div"), t = model.types.get(typeName);
        if (!t || t.kind !== "complex") return { el: out, attrs: () => [], kids: () => [] };
        if (depth > MAX_DEPTH) { out.append(el("div", "hint", "Nested too deeply to edit here.")); return { el: out, attrs: () => [], kids: () => [] }; }
        const members = lib.xsdMembers(model, typeName), fields = [], attrFields = [];
        // consecutive members of one choice form a "one of" set
        for (let i = 0; i < members.length; i++) {
          const m = members[i];
          if (m.kind === "attribute") { attrFields.push(attributeField(m, path)); continue; }
          if (m.kind !== "element") continue;
          if (m.choice) {
            const alts = [m]; while (i + 1 < members.length && members[i + 1].choice && members[i + 1].choice.id === m.choice.id) alts.push(members[++i]);
            fields.push(choiceField(alts, path, depth));
          } else fields.push(elementField(m, path, depth));
        }
        for (const f of fields) out.append(f.el);
        for (const f of attrFields) out.append(f.el);
        return { el: out, attrs: () => attrFields.flatMap(f => f.attr()), kids: () => fields.flatMap(f => f.nodes()) };
      }

      function attributeField(m, path) {
        const row = el("div", "mb-row"), lf = leaf(m.type, path + "/@" + m.name), on = el("input"); on.type = "checkbox"; on.checked = m.min >= 1; if (m.min >= 1) on.disabled = true;
        row.append(on, el("span", "mb-name", "@" + m.name), lf.el); on.onchange = changed;
        return { el: row, attr: () => (on.checked ? [[m.name, lf.text()]] : []) };
      }

      /* one named instance: leaf or complex */
      function instance(m, path, depth) {
        const t = model.types.get(m.type), complex = t && t.kind === "complex" && !t.simpleContent;
        const p = path + "/" + m.name;
        if (!complex) { const lf = leaf(m.type, p), box = el("div", "mb-inst"); box.append(lf.el); return { el: box, node: () => ({ t: "el", name: m.name, attrs: [], kids: [{ t: "text", v: lf.text() }] }) }; }
        const g = group(m.type, p, depth + 1), box = el("div", "mb-inst mb-complex"); box.append(g.el);
        return { el: box, node: () => ({ t: "el", name: m.name, attrs: g.attrs(), kids: g.kids() }) };
      }

      function label(m, extra) {
        const l = el("div", "mb-label"), t = model.types.get(m.type);
        const n = el("span", "mb-name", m.name); l.append(n);
        l.append(el("span", "ty", " : " + m.type), el("span", "oc", ` [${lib.xsdFmtOccurs(m.min, m.max)}]`));
        const d = docOf(m, t);
        if (d) { n.style.cursor = "pointer"; n.title = d; const note = el("div", "mb-doc", d); note.hidden = true; n.onclick = () => { note.hidden = !note.hidden; }; l.append(note); }
        if (extra) l.append(extra);
        return l;
      }

      function elementField(m, path, depth) {
        const wrap = el("div", "mb-el");
        if (m.max > 1) {                                                       // a list
          const list = el("div", "mb-list"), items = [];
          const add = () => { const it = instance(m, path, depth), row = el("div", "mb-item"), rm = el("button", "mini", "remove"); rm.type = "button";
            rm.onclick = () => { if (items.length > m.min) { items.splice(items.indexOf(rec), 1); row.remove(); counter(); changed(); } };
            const rec = { it, row }; row.append(it.el, rm); items.push(rec); list.append(row); counter(); };
          const addBtn = el("button", "mini", "+ add"); addBtn.type = "button"; addBtn.onclick = () => { if (items.length < m.max) { add(); changed(); } };
          const count = el("span", "hint");
          const counter = () => { count.textContent = ` ${items.length} item${items.length === 1 ? "" : "s"}`; addBtn.disabled = items.length >= m.max; list.querySelectorAll(".mb-item > .mini").forEach(b => { b.disabled = items.length <= m.min; }); };
          wrap.append(label(m, el("span", "mb-ctl", ""))); wrap.lastChild.append(addBtn, count); wrap.append(list);
          for (let i = 0; i < m.min; i++) add();
          counter();
          return { el: wrap, nodes: () => items.map(r => r.it.node()) };
        }
        if (m.min === 0) {                                                     // optional: built when switched on
          const on = el("input"); on.type = "checkbox"; let inst = null; const holder = el("div", "mb-opt"); holder.hidden = true;
          const l = label(m); l.prepend(on);
          const turn = () => { if (on.checked && !inst) { inst = instance(m, path, depth); holder.append(inst.el); } holder.hidden = !on.checked; changed(); };
          on.onchange = turn; wrap.append(l, holder);
          wrap.setOn = v => { if (on.checked !== v) { on.checked = v; turn(); } };
          optionalToggles.push(wrap);
          return { el: wrap, nodes: () => (on.checked && inst ? [inst.node()] : []) };
        }
        const inst = instance(m, path, depth);
        wrap.append(label(m), inst.el);
        return { el: wrap, nodes: () => [inst.node()] };
      }

      function choiceField(alts, path, depth) {
        const wrap = el("div", "mb-choice"), optional = alts.some(a => a.min === 0), name = "ch" + Math.random().toString(36).slice(2);
        wrap.append(el("div", "hint", `one of ${alts.length}${optional ? " (optional)" : ""}`));
        const rows = [];
        const sel = i => { rows.forEach((r, k) => { r.radio.checked = k === i || (i === -1 && optional && k === 0); r.holder.hidden = k !== i; if (k === i && !r.inst && r.alt) { r.inst = instOf(r.alt); r.holder.append(r.inst.el); } }); changed(); };
        const instOf = a => a.max > 1 ? (() => { const f = elementField({ ...a, min: Math.max(1, a.min) }, path, depth); return { el: f.el, node: f.nodes }; })() : instance(a, path, depth);
        if (optional) { const none = el("label", "mb-alt"); const r = el("input"); r.type = "radio"; r.name = name; r.checked = true; r.onchange = () => sel(-1); none.append(r, el("span", "hint", " none")); wrap.append(none); rows.push({ radio: r, holder: el("div"), alt: null }); rows[0].holder.hidden = true; }
        alts.forEach(a => {
          const row = el("div", "mb-alt"), r = el("input"); r.type = "radio"; r.name = name; const holder = el("div", "mb-opt"); holder.hidden = true;
          const l = el("label"); l.append(r, el("span", "mb-name", " " + a.name), el("span", "ty", " : " + a.type)); const d = docOf(a, model.types.get(a.type)); if (d) l.title = d;
          row.append(l, holder); wrap.append(row);
          const rec = { radio: r, holder, alt: a, inst: null }; rows.push(rec);
          r.onchange = () => sel(rows.indexOf(rec));
        });
        sel(optional ? -1 : 0);
        if (optional) rows[0].radio.checked = true;
        return { el: wrap, nodes: () => { const r = rows.find(x => x.radio.checked && x.alt); if (!r || !r.inst) return []; const v = r.inst.node(); return Array.isArray(v) ? v : [v]; } };
      }
      let optionalToggles = [];

      function buildForm() {
        const name = $("#msg").value.trim(), decl = model && model.elements.get(name);
        if (!decl) return DT.status($("#bst"), "err", name ? `"${name}" is not a message in the loaded schema.${model && lib.uciSuggest(model, name).length ? " Closest: " + lib.uciSuggest(model, name).join(", ") + "." : ""}` : "Enter a message name.");
        optionalToggles = [];
        DT.status($("#bst"), "", "Building…");
        const t0 = performance.now();
        const f = $("#form"); f.innerHTML = "";
        const head = el("div", "mb-root"); head.append(el("b", "", name), el("span", "hint", " : " + decl.type));
        const d = lib.uciFirstPara(decl.doc || (model.types.get(decl.type) || {}).doc); if (d) head.append(el("div", "doc-block", d));
        f.append(head);
        const g = group(decl.type, "/" + name, 0); f.append(g.el);
        const file = model.files.find(x => x.name === decl.file);
        rootNode = { name, decl, ns: file ? file.targetNamespace : "", g };
        current = name;
        if ($("#all").checked) setAllOptional(true);
        DT.status($("#bst"), "ok", `Built ${name} in ${Math.round(performance.now() - t0)} ms.`);
        update();
      }
      function setAllOptional(v) { let n = 0; for (let guard = 0; guard < 6; guard++) { const todo = optionalToggles.filter(w => !w.querySelector("input[type=checkbox]").checked); if (!todo.length || n > 3000) break; todo.forEach(w => { w.setOn(v); n++; }); } }

      /* ---------- output ---------- */
      function xmlText() {
        if (!rootNode) return "";
        const attrs = [["xmlns", rootNode.ns], ["xmlns:xsi", XSI]].filter(a => a[1]).concat(rootNode.g.attrs());
        return lib.xmlSerialize({ decl: 'xml version="1.0" encoding="UTF-8"', root: { t: "el", name: rootNode.name, attrs, kids: rootNode.g.kids() } });
      }
      function update() {
        if (!rootNode) return;
        const xml = xmlText(); let json = "", v = null;
        try { json = lib.owpXmlToJson(model, xml, 2); } catch (e) { json = "// " + e.message; }
        try { v = lib.xsdValidate(model, xml); } catch (e) { v = { ok: false, errors: [{ message: e.message, path: "" }] }; }
        $("#vbadge").innerHTML = v.ok ? `<span class="badge ok">schema-valid</span>` : `<span class="badge err">${v.errors.length}${v.truncated ? "+" : ""} problem${v.errors.length === 1 ? "" : "s"}</span>`;
        update.data = { xml, json, v };
        showOut();
      }
      function showOut() {
        const d = update.data; if (!d) return;
        root.querySelectorAll(".tabs .tab[data-o]").forEach(b => b.classList.toggle("on", b.dataset.o === outTab));
        $("#out").textContent = outTab === "xml" ? d.xml : outTab === "json" ? d.json : (d.v.ok ? "No problems: the message is valid against the loaded schema." : d.v.errors.map(e => `${e.path || "(document)"}\n    ${e.message}`).join("\n"));
      }
      root.querySelector(".tabs").onclick = e => { const b = e.target.closest(".tab[data-o]"); if (b) { outTab = b.dataset.o; showOut(); } };
      $("#build").onclick = buildForm;
      $("#msg").addEventListener("keydown", e => { if (e.key === "Enter") buildForm(); });
      $("#msg").addEventListener("change", () => { if (model && model.elements.has($("#msg").value.trim())) buildForm(); });
      $("#all").onchange = () => { if (current) { if ($("#all").checked) setAllOptional(true); else optionalToggles.forEach(w => w.setOn(false)); update(); } };
      $("#reset").onclick = () => { if (current) buildForm(); };
      $("#hdr").onclick = () => {
        if (!current) return;
        let sys = store.get("dt.builder.sys", ""); if (!sys) { sys = uuid(); store.set("dt.builder.sys", sys); }
        const set = (suffix, v) => root.querySelectorAll(`#form [data-path$="${suffix}"]`).forEach(i => { if (i.tagName === "SELECT" ? [...i.options].some(o => o.value === v) : true) { i.value = v; } });
        set("/MessageHeader/SystemID/UUID", sys); set("/MessageHeader/SystemID", sys); set("/MessageHeader/ServiceID/UUID", uuid()); set("/MessageHeader/Timestamp", nowIso()); set("/MessageHeader/Mode", "LIVE");
        update();
      };
      $("#copy").onclick = e => { if (update.data) DT.copy(outTab === "json" ? update.data.json : update.data.xml, e.target); };
      $("#dl").onclick = () => { if (update.data) DT.download(`${current}.${outTab === "json" ? "json" : "xml"}`, outTab === "json" ? update.data.json : update.data.xml, outTab === "json" ? "application/json" : "application/xml"); };
      const handoff = (to, kind) => { if (!update.data) return; lib.handoff = { kind, name: current, text: kind === "json" ? update.data.json : update.data.xml }; location.hash = "#" + to; };
      $("#tonats").onclick = () => handoff("nats", "xml");
      $("#tocal").onclick = () => handoff("cal", "json");

      sp.start();
      if (model) { $("#bw").hidden = false; $("#nomodel").hidden = true; $("#msglist").innerHTML = [...model.elements.keys()].sort().map(k => `<option value="${esc(k)}">`).join(""); }
    },
  });
})();
