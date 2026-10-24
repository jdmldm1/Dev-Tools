/* Graphical composition view for the XSD explorer.
   Pure layout + SVG generation on DT.lib (testable without a DOM), then lib.xsdDiagramMount() for the interactive part.

   A diagram is a left-to-right tree: the root (message or type) on the left, its members to the right, expandable one level at a time.
   Compositors are explicit: members that are alternatives of an xs:choice hang off a "choice" node. Optional members use dashed
   edges, repeating ones carry an occurrence badge, enumerations expand into their values, and recursion is marked instead of followed.

   Node ids are paths of child indexes ("0", "0.3", "0.3.1"), stable for a given schema, so expansion state can be kept and
   search results can name the branches to open. */
(function () {
  const lib = DT.lib;

  /* ---- the tree itself ---------------------------------------------------------------------------- */

  /* Raw (unassigned) children of a node. */
  function rawChildren(model, node) {
    if (node.kind === "choice") return node.items;
    if (node.kind === "enumval" || node.kind === "more" || node.kind === "attr" || node.recursive) return [];
    const t = model.types.get(node.type);
    if (!t) return [];
    if (t.kind === "complex" && !t.simpleContent) {
      const out = [], choices = new Map();
      for (const m of lib.xsdMembers(model, node.type)) {
        if (m.kind === "group") continue;
        const d = { kind: m.kind === "attribute" ? "attr" : "member", name: m.name, type: m.type, min: m.min, max: m.max, doc: m.doc || "", inherited: m.inherited, from: m.from, version: m.version || "", use: m.use };
        if (m.kind === "any") { d.name = "(any element)"; d.type = "xs:any"; }
        if (m.choice && m.kind === "element") {
          const key = m.from + "#" + m.choice.id;
          let c = choices.get(key);
          if (!c) { c = { kind: "choice", name: "choice", type: "", min: 1, max: 1, items: [], of: m.choice.of, inherited: m.inherited, from: m.from, doc: "Exactly one of these alternatives is present." }; choices.set(key, c); out.push(c); }
          c.items.push(d);
        } else out.push(d);
      }
      return out;
    }
    const en = t.facets && t.facets.enumeration;
    if (en && en.length) {
      const vals = en.slice(0, 20).map(v => ({ kind: "enumval", name: v.value, type: "", min: 1, max: 1, doc: v.doc || "" }));
      if (en.length > 20) vals.push({ kind: "more", name: `+${en.length - 20} more values`, type: "", min: 1, max: 1, doc: "Open the type to see every value." });
      return vals;
    }
    return [];
  }

  /* Children with ids, depth, ancestry and recursion flags assigned. */
  function kidsOf(model, node) {
    const raw = rawChildren(model, node);
    return raw.map((c, i) => {
      const kid = { ...c, id: node.id + "." + i, depth: node.depth + 1 };
      kid.anc = (c.kind === "member" || c.kind === "attr") && c.type ? node.anc.concat(c.type) : node.anc;
      if (c.kind === "member" && c.type && node.anc.includes(c.type)) kid.recursive = true;
      return kid;
    });
  }
  const makeRoot = (model, typeName, rootName) => {
    const t = model.types.get(typeName), el = model.elements.get(rootName);
    return { id: "0", kind: "root", name: rootName, type: typeName, min: 1, max: 1, depth: 0, anc: [typeName], doc: (el && el.doc) || (t && t.doc) || "", version: (el && el.version) || (t && t.version) || "" };
  };
  const hasKids = (model, n) => !n.recursive && n.kind !== "enumval" && n.kind !== "more" && n.kind !== "attr" && (n.kind === "choice" || kidsCount(model, n) > 0);
  function kidsCount(model, n) {
    if (n.recursive) return 0;
    const t = model.types.get(n.type);
    if (!t) return 0;
    if (t.kind === "complex" && !t.simpleContent) return lib.xsdMembers(model, n.type).filter(m => m.kind !== "group").length;
    return t.facets && t.facets.enumeration ? t.facets.enumeration.length : 0;
  }

  /* Ids to expand so that the first `depth` levels are open (root counts as level 0), within a node budget. By default a
     message's inherited members (shared header and security markings) stay collapsed so its own payload is what you see. */
  lib.xsdDiagramDefaultExpansion = function (model, typeName, rootName, { depth = 2, budget = 400, skipInherited = true } = {}) {
    const open = new Set(["0"]);
    let n = 0;
    // `d` is the level of `node`'s children (root's children are level 1). A child opens only if its own children would still be within `depth`.
    (function walk(node, d) {
      if (n > budget) return;
      for (const k of kidsOf(model, node)) {
        n++;
        if (k.kind === "choice") { walk(k, d); continue; }                 // a choice is structure, not a level
        if (d >= depth) continue;
        if (skipInherited && d === 1 && k.inherited) continue;
        if (k.recursive || !hasKids(model, k)) continue;
        open.add(k.id); walk(k, d + 1);
      }
    })(makeRoot(model, typeName, rootName), 1);
    return open;
  };

  /* Ids of nodes whose name or type contains `term`, plus every ancestor id, searching the whole (cycle-safe) tree. */
  lib.xsdDiagramFind = function (model, typeName, rootName, term, { maxDepth = 14, limit = 80, budget = 60000 } = {}) {
    const q = term.trim().toLowerCase(), hits = [], open = new Set(["0"]);
    if (!q) return { hits, open };
    let visited = 0;
    (function walk(node) {
      if (hits.length >= limit || visited > budget || node.depth >= maxDepth) return;
      for (const k of kidsOf(model, node)) {
        visited++;
        if (k.kind !== "choice" && k.kind !== "more" && ((k.name || "") + " " + (k.type || "")).toLowerCase().includes(q)) {
          hits.push({ id: k.id, name: k.name, type: k.type, kind: k.kind });
          const parts = k.id.split(".");                                    // ids are index paths, so the ancestors are the prefixes
          for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join("."));
        }
        if (!k.recursive) walk(k);
      }
    })(makeRoot(model, typeName, rootName));
    return { hits, open, truncated: hits.length >= limit || visited > budget };
  };

  /* ---- layout -------------------------------------------------------------------------------------- */

  const ROW_H = 38, SMALL_H = 24, VGAP = 7, HGAP = 64, PAD = 24;
  const CW_NAME = 7.4, CW_TYPE = 6.5;
  const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;
  const occText = n => n.min === 1 && n.max === 1 ? "" : `${n.min}..${n.max === Infinity ? "∞" : n.max}`;

  /* expanded: Set of node ids (root is always open). Returns { nodes, edges, width, height, stats }. */
  lib.xsdDiagramLayout = function (model, typeName, rootName, expanded, { maxNodes = 2500 } = {}) {
    const root = makeRoot(model, typeName, rootName);
    let count = 1, truncated = false;
    const withKids = n => {
      n.hasKids = hasKids(model, n);
      n.open = n.kind === "root" || n.kind === "choice" ? true : expanded.has(n.id);
      n.vis = [];
      if (n.hasKids && n.open) {
        for (const k of kidsOf(model, n)) {
          if (count >= maxNodes) { truncated = true; break; }
          count++;
          n.vis.push(withKids(k));
        }
      }
      return n;
    };
    withKids(root);

    // geometry: text drives widths, widths drive column positions
    const levels = [];
    (function size(n) {
      n.label = n.kind === "choice" ? "choice" : (n.kind === "attr" ? "@" : "") + clip(n.name, 40);
      n.sub = n.kind === "root" ? n.type : n.kind === "choice" ? "" : n.kind === "enumval" || n.kind === "more" ? "" : clip(n.type || "", 46);
      n.h = n.kind === "choice" || n.kind === "enumval" || n.kind === "more" ? SMALL_H : ROW_H;
      n.w = Math.max(n.label.length * CW_NAME + 22, n.sub.length * CW_TYPE + 22, n.kind === "choice" ? 64 : 40) + (n.hasKids && n.kind !== "choice" ? 14 : 0);
      (levels[n.depth] = levels[n.depth] || []).push(n);
      n.vis.forEach(size);
    })(root);
    const xs = []; let x = PAD;
    levels.forEach((lv, d) => { xs[d] = x; x += Math.max(...(lv || [{ w: 0 }]).map(n => n.w)) + HGAP; });
    let cursor = PAD;
    (function place(n) {
      n.x = xs[n.depth];
      if (!n.vis.length) { n.y = cursor; cursor += n.h + VGAP; return; }
      n.vis.forEach(place);
      const a = n.vis[0], b = n.vis[n.vis.length - 1];
      n.y = (a.y + a.h / 2 + b.y + b.h / 2) / 2 - n.h / 2;
    })(root);

    const nodes = [], edges = [];
    (function flat(n, parent) {
      n.cls = n.kind === "root" ? "root" : n.kind === "choice" ? "choice" : n.kind === "attr" ? "attr" : n.kind === "enumval" || n.kind === "more" ? "val" : n.recursive ? "rec" : classify(model, n);
      n.optional = n.kind !== "root" && n.min === 0;
      n.badge = n.kind === "root" ? "" : occText(n);
      nodes.push(n);
      if (parent) {
        const x1 = parent.x + parent.w, y1 = parent.y + parent.h / 2, x2 = n.x, y2 = n.y + n.h / 2, xm = (x1 + x2) / 2;
        edges.push({ from: parent.id, to: n.id, d: `M${x1} ${y1} C${xm} ${y1} ${xm} ${y2} ${x2} ${y2}`, optional: n.optional && n.parentKind !== "choice", repeat: n.max > 1, badge: n.badge, bx: x2 - 6, by: y2 });
      }
      n.vis.forEach(k => { k.parentKind = n.kind; flat(k, n); });
    })(root, null);

    const width = Math.max(...nodes.map(n => n.x + n.w)) + PAD, height = Math.max(cursor, 80) + PAD - VGAP;
    return { nodes, edges, width, height, stats: { visible: nodes.length, truncated, maxNodes } };
  };

  function classify(model, n) {
    const t = model.types.get(n.type);
    if (!t) return "builtin";
    if (t.kind === "simple" || t.simpleContent) return t.facets && t.facets.enumeration ? "enum" : "simple";
    return model.elementsOfType.has(n.type) ? "msg" : "complex";
  }

  /* ---- SVG ------------------------------------------------------------------------------------------ */

  const X = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  lib.xsdDiagramCss = {
    bg: "#0d1117", ink: "#e6edf3", muted: "#8b98a7", line: "#3b4756", surface: "#151b23",
    root: "#58a6ff", complex: "#30363d", simple: "#3fb950", enum: "#bc8cff", choice: "#e3b341", attr: "#39c5cf", rec: "#f85149", builtin: "#6e7681", msg: "#58a6ff", val: "#6e5aa8",
  };
  const STYLE = () => { const c = lib.xsdDiagramCss; return `
    .dg-n rect.box{fill:${c.surface};stroke-width:1.4}
    .dg-n.dg-root rect.box{stroke:${c.root};fill:#12263f;stroke-width:2}
    .dg-n.dg-complex rect.box{stroke:#5d6b7c}
    .dg-n.dg-msg rect.box{stroke:${c.msg}}
    .dg-n.dg-simple rect.box{stroke:${c.simple}}
    .dg-n.dg-builtin rect.box{stroke:${c.builtin}}
    .dg-n.dg-enum rect.box{stroke:${c.enum}}
    .dg-n.dg-attr rect.box{stroke:${c.attr};stroke-dasharray:2 3}
    .dg-n.dg-rec rect.box{stroke:${c.rec};stroke-dasharray:5 3}
    .dg-n.dg-choice rect.box{stroke:${c.choice};fill:#2a2412}
    .dg-n.dg-val rect.box{stroke:${c.val};fill:#1c1730}
    .dg-n.dg-opt rect.box{stroke-dasharray:6 3}
    .dg-n.dg-sel rect.box{stroke:#ffffff;stroke-width:2.4}
    .dg-n.dg-hit rect.box{fill:#3a3a1c;stroke:#e3b341;stroke-width:2.4}
    .dg-n text{font-family:ui-monospace,Consolas,monospace;fill:${c.ink};pointer-events:none}
    .dg-n .nm{font-size:12px;font-weight:600}.dg-n .ty{font-size:10.5px;fill:${c.muted}}
    .dg-n.dg-choice .nm{font-size:11px;fill:${c.choice};font-style:italic}.dg-n.dg-val .nm{font-size:11px;font-weight:400}
    .dg-n .ex circle{fill:${c.bg};stroke:${c.muted};stroke-width:1.2}.dg-n .ex text{font-size:12px;text-anchor:middle;fill:${c.ink}}
    .dg-e{fill:none;stroke:${c.line};stroke-width:1.5}.dg-e.opt{stroke-dasharray:5 4}.dg-e.rep{stroke-width:2.6}
    .dg-b rect{fill:${c.bg};stroke:${c.line}}.dg-b text{font-family:ui-monospace,Consolas,monospace;font-size:10px;fill:#e3b341;text-anchor:middle}`; };

  lib.xsdDiagramStyle = STYLE;

  /* Complete SVG markup for a layout. standalone=true embeds the stylesheet and a background so the file renders anywhere. */
  lib.xsdDiagramSvg = function (layout, { standalone = false, selected = "", hits = null } = {}) {
    const c = lib.xsdDiagramCss;
    const edges = layout.edges.map(e => `<path class="dg-e${e.optional ? " opt" : ""}${e.repeat ? " rep" : ""}" d="${e.d}"/>`).join("");
    const badges = layout.edges.filter(e => e.badge).map(e => {
      const w = e.badge.length * 6 + 10;
      return `<g class="dg-b" transform="translate(${e.bx - w / 2 - 2} ${e.by - 18})"><rect width="${w}" height="14" rx="7"/><text x="${w / 2}" y="10.5">${X(e.badge)}</text></g>`;
    }).join("");
    const nodes = layout.nodes.map(n => {
      const cls = `dg-n dg-${n.cls}${n.optional ? " dg-opt" : ""}${n.id === selected ? " dg-sel" : ""}${hits && hits.has(n.id) ? " dg-hit" : ""}`;
      const tip = [n.kind === "choice" ? "choice: exactly one of the alternatives" : n.name, n.type && `type ${n.type}`, n.inherited && `inherited from ${n.from}`, n.badge && `occurs ${n.badge}`, n.version && `version ${n.version}`, n.doc && "\n" + n.doc.slice(0, 600)].filter(Boolean).join(" · ");
      const ex = n.hasKids && n.kind !== "choice" ? `<g class="ex"><circle cx="${n.w}" cy="${n.h / 2}" r="8"/><text x="${n.w}" y="${n.h / 2 + 4}">${n.open ? "−" : "+"}</text></g>` : "";
      const two = n.h === ROW_H && n.sub;
      return `<g class="${cls}" data-id="${n.id}" transform="translate(${n.x} ${n.y})"><title>${X(tip)}</title><rect class="box" width="${n.w}" height="${n.h}" rx="${n.kind === "choice" ? 12 : 7}"/>` +
        (two ? `<text class="nm" x="10" y="15">${X(n.label)}</text><text class="ty" x="10" y="29">${X(n.sub)}</text>` : `<text class="nm" x="10" y="${n.h / 2 + 4}">${X(n.label)}</text>`) + ex +
        (n.inherited && n.kind !== "choice" ? `<text class="ty" x="${n.w - 4}" y="10" style="text-anchor:end;font-size:9px">↑</text>` : "") + `</g>`;
    }).join("");
    const body = `<g class="dg-edges">${edges}</g><g class="dg-nodes">${nodes}</g><g class="dg-badges">${badges}</g>`;
    if (!standalone) return body;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}" width="${Math.ceil(layout.width)}" height="${Math.ceil(layout.height)}"><style>${STYLE()}</style><rect width="100%" height="100%" fill="${c.bg}"/>${body}</svg>`;
  };

  /* A short plain-text summary of what a node is (for the details panel and tests). */
  lib.xsdDiagramDescribe = function (model, n) {
    const t = model.types.get(n.type), parts = [];
    if (n.kind === "choice") return "Choice: exactly one of " + (n.items || []).map(i => i.name).join(", ");
    if (n.kind === "enumval") return `Enumeration value ${n.name}`;
    parts.push(`${n.kind === "attr" ? "Attribute" : n.kind === "root" ? "Root" : "Member"} ${n.name}`);
    if (n.type) parts.push(`of type ${n.type}`);
    if (n.kind !== "root") parts.push(occText(n) ? `occurs ${occText(n)}` : "occurs exactly once");
    if (t && t.kind === "complex") parts.push(`${lib.xsdMembers(model, n.type).length} members`);
    if (t && t.facets && t.facets.enumeration) parts.push(`${t.facets.enumeration.length} values`);
    return parts.join(", ");
  };

  /* ---- interactive mount ----------------------------------------------------------------------------- */

  /* host: element to fill. ctx: { model, typeName, rootName, open(typeName), state } where `state` is a plain object kept by the caller
     so the diagram survives tab switches ({ expanded:Set, view:{x,y,k}, selected }). */
  lib.xsdDiagramMount = function (host, ctx) {
    const { model, typeName, rootName } = ctx, esc = DT.esc;
    const st = ctx.state;
    if (!st.expanded) st.expanded = lib.xsdDiagramDefaultExpansion(model, typeName, rootName);
    host.innerHTML = `
      <div class="dg-bar">
        <label>Depth <select class="dg-depth">${[1, 2, 3, 4, 5, 6].map(d => `<option ${d === 2 ? "selected" : ""}>${d}</option>`).join("")}</select></label>
        <button class="btn dg-do" type="button">Expand</button><button class="btn dg-reset" type="button">Reset</button><button class="btn dg-collapse" type="button">Collapse all</button>
        <input type="search" class="dg-find mono" placeholder="Find a member or type…" aria-label="Find in diagram">
        <span class="dg-hitnav" hidden><button class="btn dg-prev" type="button" title="Previous match (Shift+Enter)">‹</button><span class="dg-hitn mono"></span><button class="btn dg-next" type="button" title="Next match (Enter)">›</button></span>
        <span class="dg-sp"></span>
        <button class="btn dg-zo" type="button" title="Zoom out">−</button><button class="btn dg-zi" type="button" title="Zoom in">+</button><button class="btn dg-fit" type="button">Fit</button>
        <button class="btn dg-svg" type="button">Save SVG</button><button class="btn dg-png" type="button">Save PNG</button>
      </div>
      <div class="dg-legend"><span><i class="lg lg-root"></i>message / root</span><span><i class="lg lg-complex"></i>complex type</span><span><i class="lg lg-simple"></i>simple</span><span><i class="lg lg-enum"></i>enumeration</span><span><i class="lg lg-choice"></i>choice (one of)</span><span><i class="lg lg-rec"></i>recursive</span><span><i class="lg lg-dash"></i>optional</span><span>↑ inherited</span><span class="hint">click a box to open or close it · drag to pan · wheel to zoom</span></div>
      <div class="dg-note status"></div>
      <div class="dg-view" tabindex="0"><svg class="dg-svg-el" xmlns="http://www.w3.org/2000/svg"><style class="dg-style"></style><g class="dg-vp"></g></svg></div>
      <div class="dg-info panel"></div>`;
    const $ = s => host.querySelector(s), view = $(".dg-view"), svg = $(".dg-svg-el"), vp = $(".dg-vp");
    let layout, hits = null;
    $(".dg-style").textContent = lib.xsdDiagramStyle();

    const applyView = () => { const v = st.view; vp.setAttribute("transform", `translate(${v.x} ${v.y}) scale(${v.k})`); };
    const fit = () => {
      const r = view.getBoundingClientRect(), k = Math.min(1, (r.width - 20) / layout.width, (r.height - 20) / layout.height);
      st.view = { k: Math.max(k, 0.1), x: 10, y: 10 }; applyView();
    };
    function draw() {
      layout = lib.xsdDiagramLayout(model, typeName, rootName, st.expanded);
      vp.innerHTML = lib.xsdDiagramSvg(layout, { selected: st.selected, hits });
      const s = layout.stats;
      DT.status($(".dg-note"), s.truncated ? "warn" : "", `${s.visible.toLocaleString()} boxes shown${s.truncated ? ` (stopped at ${s.maxNodes.toLocaleString()}; collapse some branches)` : ""}.`);
      if (!hits || !hits.size) { hitList = []; $(".dg-hitnav").hidden = true; }
      describe();
    }
    function describe() {
      const n = layout.nodes.find(x => x.id === st.selected) || layout.nodes[0];
      const t = model.types.get(n.type), canOpen = !!t;
      $(".dg-info").innerHTML = `<div class="dg-i-head"><b class="mono">${esc(n.kind === "choice" ? "choice" : n.name)}</b>${n.type ? ` <span class="hint mono">: ${esc(n.type)}</span>` : ""}${canOpen && n.kind !== "root" ? ` <button class="mini dg-open" type="button">open ${esc(n.type)} ↗</button>` : ""}</div>
        <div class="hint">${esc(lib.xsdDiagramDescribe(model, n))}${n.inherited ? ` · inherited from ${esc(n.from)}` : ""}${n.version ? ` · version ${esc(n.version)}` : ""}</div>${n.doc ? `<div class="doc-block" style="margin:8px 0 0;max-height:140px;overflow:auto">${esc(n.doc)}</div>` : ""}`;
      const b = $(".dg-open"); if (b) b.onclick = () => ctx.open(n.type);
    }

    // stepping through search matches: select the match and bring it to the middle of the view at a readable size
    let hitList = [], hitIdx = 0;
    function focusOn(id) {
      const n = layout.nodes.find(x => x.id === id); if (!n) return;
      const r = view.getBoundingClientRect(), k = Math.min(1.1, Math.max(0.85, st.view ? st.view.k : 1));
      st.view = { k, x: r.width / 2 - (n.x + n.w / 2) * k, y: r.height / 2 - (n.y + n.h / 2) * k }; applyView();
    }
    function jump(i) {
      const nav = $(".dg-hitnav");
      if (!hitList.length) { nav.hidden = true; return; }
      hitIdx = (i + hitList.length) % hitList.length;
      st.selected = hitList[hitIdx]; draw();
      $(".dg-hitn").textContent = `${hitIdx + 1}/${hitList.length}`; nav.hidden = false;
      focusOn(st.selected);
    }

    // expansion
    svg.addEventListener("click", e => {
      if (moved) return;
      const g = e.target.closest(".dg-n"); if (!g) return;
      const n = layout.nodes.find(x => x.id === g.dataset.id); if (!n) return;
      st.selected = n.id;
      if (n.hasKids && n.kind !== "choice" && n.kind !== "root") { if (st.expanded.has(n.id)) st.expanded.delete(n.id); else st.expanded.add(n.id); }
      draw();                                                                  // search highlights stay while you open and close boxes
    });
    $(".dg-do").onclick = () => {
      const d = +$(".dg-depth").value;
      st.expanded = lib.xsdDiagramDefaultExpansion(model, typeName, rootName, { depth: d, budget: 2400, skipInherited: false });
      hits = null; draw(); fit();
    };
    $(".dg-reset").onclick = () => { st.expanded = lib.xsdDiagramDefaultExpansion(model, typeName, rootName); st.selected = ""; hits = null; $(".dg-find").value = ""; draw(); fit(); };
    $(".dg-collapse").onclick = () => { st.expanded = new Set(["0"]); hits = null; draw(); fit(); };
    $(".dg-find").addEventListener("input", DT.debounce(() => {
      const q = $(".dg-find").value;
      if (!q.trim()) { hits = null; draw(); return; }
      const r = lib.xsdDiagramFind(model, typeName, rootName, q);
      if (!r.hits.length) { hits = new Set(); draw(); DT.status($(".dg-note"), "warn", `Nothing named or typed "${q}" in this message.`); return; }
      st.expanded = r.open; hits = new Set(r.hits.map(h => h.id)); draw();
      hitList = layout.nodes.filter(n => hits.has(n.id)).map(n => n.id);       // top-to-bottom order, as drawn
      jump(0);
      DT.status($(".dg-note"), "ok", `${r.hits.length}${r.truncated ? "+" : ""} match${r.hits.length === 1 ? "" : "es"} highlighted; their branches are open. Use ‹ › or Enter to step through them.`);
    }, 250));
    $(".dg-find").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); jump(hitIdx + (e.shiftKey ? -1 : 1)); } });
    $(".dg-next").onclick = () => jump(hitIdx + 1); $(".dg-prev").onclick = () => jump(hitIdx - 1);

    // pan and zoom
    let drag = null, moved = false;
    view.addEventListener("pointerdown", e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, vx: st.view.x, vy: st.view.y }; moved = false; });
    window.addEventListener("pointermove", e => {
      if (!drag || !host.isConnected) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; view.classList.add("grabbing"); }
      if (moved) { st.view.x = drag.vx + dx; st.view.y = drag.vy + dy; applyView(); }
    });
    window.addEventListener("pointerup", () => { drag = null; view.classList.remove("grabbing"); setTimeout(() => { moved = false; }, 0); });
    const zoom = (f, cx, cy) => {
      const r = view.getBoundingClientRect(), px = (cx ?? r.left + r.width / 2) - r.left, py = (cy ?? r.top + r.height / 2) - r.top, v = st.view;
      const k = Math.min(3, Math.max(0.1, v.k * f)), s = k / v.k;
      st.view = { k, x: px - (px - v.x) * s, y: py - (py - v.y) * s }; applyView();
    };
    view.addEventListener("wheel", e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });
    $(".dg-zi").onclick = () => zoom(1.25); $(".dg-zo").onclick = () => zoom(0.8); $(".dg-fit").onclick = fit;

    // export
    const standalone = () => lib.xsdDiagramSvg(layout, { standalone: true, hits });
    $(".dg-svg").onclick = () => DT.download(`${rootName}-diagram.svg`, standalone(), "image/svg+xml");
    $(".dg-png").onclick = () => {
      const svgText = standalone(), scale = Math.min(2, 8000 / Math.max(layout.width, layout.height));
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas"); cv.width = Math.ceil(layout.width * scale); cv.height = Math.ceil(layout.height * scale);
        const c2 = cv.getContext("2d"); c2.drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(b => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${rootName}-diagram.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
      };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
    };

    draw();
    if (!st.view) fit(); else applyView();
    return { redraw: draw, fit, layout: () => layout };
  };
})();
