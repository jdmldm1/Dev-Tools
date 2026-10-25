/* Shell add-ons for the toolbox, built on the hooks in toolbox.js:
     share links   "#tool?s=<packed state>" restores a tool's inputs (see DT.lib.packState)
     send to       move a tool's output into another tool's input
     palette       Ctrl/Cmd + K: jump to a tool or sheet, or run an action
     toast         DT.toast(msg), also used for "new version available"
   Everything DOM-related is skipped when there is no document (the Node tests load this file for the codec). */
(function () {
  const DT = window.DT, lib = DT.lib;

  /* ---- state codec: JSON -> deflate-raw (when available) -> base64url, prefixed "z" (deflated) or "j" (plain) ---- */
  lib.packState = async function (obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === "function") {
      const buf = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
      return "z" + lib.bytesToB64(new Uint8Array(buf), true, false);
    }
    return "j" + lib.bytesToB64(raw, true, false);
  };
  lib.unpackState = async function (str) {
    const kind = str[0], bytes = lib.b64ToBytes(str.slice(1));
    if (kind === "j") return JSON.parse(new TextDecoder().decode(bytes));
    if (kind !== "z" || typeof DecompressionStream !== "function") throw new Error("Unsupported share link");
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(buf));
  };

  /* The user-editable fields of a tool: id -> value (boolean for checkboxes). */
  const FIELD = "textarea:not([readonly])[id], select[id], input[id]:not([type=password]):not([type=file]):not([type=button]):not([type=submit])";
  lib.readFields = root => {
    const out = {};
    root.querySelectorAll(FIELD).forEach(el => { if (!el.hasAttribute("data-noshare")) out[el.id] = el.type === "checkbox" || el.type === "radio" ? el.checked : el.value; });
    return out;
  };
  lib.writeFields = (root, state) => {
    for (const id of Object.keys(state)) {
      const el = root.querySelector("#" + CSS.escape(id)); if (!el) continue;
      if (el.type === "checkbox" || el.type === "radio") el.checked = !!state[id]; else el.value = String(state[id]);
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  const shareable = t => t.share !== false && t.group !== "UCI";     // connection tools carry endpoints and captures: never put those in a URL
  const MAX_LINK = 6000;

  /* Rank: name prefix, name substring, then every query word found anywhere. */
  lib.paletteScore = (it, q) => {
    if (!q) return it.kind === "Action" ? 0 : 1;
    const n = it.name.toLowerCase();
    if (n.startsWith(q)) return 100;
    if (n.includes(q)) return 80;
    const words = q.split(/\s+/).filter(Boolean);
    return words.every(w => it.hay.includes(w)) ? 40 : 0;
  };

  if (typeof document === "undefined" || !document) return;

  /* ---- toast ---- */
  let toastTimer;
  DT.toast = function (msg, action) {
    let el = document.getElementById("dt-toast");
    if (!el) { el = document.createElement("div"); el.id = "dt-toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    if (action) { const b = document.createElement("button"); b.type = "button"; b.textContent = action.label; b.onclick = action.run; el.appendChild(b); }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, action ? 12000 : 2400);
  };

  /* ---- share link ---- */
  let current = null, defaults = {};
  async function shareLink() {
    if (!current) return "";
    const now = lib.readFields(document.getElementById("tool")), diff = {};
    for (const k of Object.keys(now)) if (now[k] !== defaults[k]) diff[k] = now[k];
    const base = location.origin + location.pathname + "#" + current.id;
    return Object.keys(diff).length ? base + "?s=" + await lib.packState(diff) : base;
  }
  DT.shareLink = shareLink;
  async function copyShare() {
    if (!current || !shareable(current)) { DT.toast("This tool can't be shared as a link."); return; }
    const url = await shareLink();
    if (url.length > MAX_LINK) { DT.toast("Too much input for a link (" + Math.round(url.length / 1024) + " KB). Copy the text instead."); return; }
    await DT.copy(url); DT.toast("Link copied");
  }

  /* ---- send to ---- */
  const outputOf = root => root.querySelector("#out") || root.querySelector("textarea[readonly]");
  const inputOf = root => root.querySelector("#in") || root.querySelector("textarea:not([readonly])") || root.querySelector("input[type=text]");

  DT.onShow(async (tool, root) => {
    current = tool;
    const bar = document.createElement("div"); bar.className = "dt-tools";
    const out = outputOf(root);
    const targets = DT.tools().filter(t => t.id !== tool.id && t.group !== "UCI" && t.group !== "XML & Mission Systems");
    bar.innerHTML = (shareable(tool) ? `<button type="button" class="mini" id="dt-share">Share link</button>` : "") +
      (out ? `<label class="dt-send">Send output to <select id="dt-sendto" data-noshare aria-label="Send output to another tool"><option value="">…</option>${targets.map(t => `<option value="${t.id}">${DT.esc(t.name)}</option>`).join("")}</select></label>` : "");
    if (bar.innerHTML) root.parentNode.insertBefore(bar, root);
    const sh = bar.querySelector("#dt-share"); if (sh) sh.onclick = copyShare;
    const sel = bar.querySelector("#dt-sendto");
    if (sel) sel.onchange = () => { if (!sel.value) return; DT.pending = out.value; location.hash = "#" + sel.value; };

    defaults = lib.readFields(root);
    const s = DT.route().params.get("s");
    if (s && shareable(tool)) {
      try { lib.writeFields(root, await lib.unpackState(s)); }
      catch (e) { DT.toast("Could not restore that link: " + e.message); }
    } else if (DT.pending != null) {
      const inp = inputOf(root);
      if (inp) { inp.value = DT.pending; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); }
      DT.pending = null;
    }
  });

  /* ---- theme button ---- */
  const themeLabel = () => "theme: " + window.DevTheme.get();
  window.addEventListener("DOMContentLoaded", () => {
    const links = document.querySelector(".mini-links");
    if (links && window.DevTheme) {
      const b = document.createElement("button"); b.type = "button"; b.id = "themeBtn"; b.textContent = themeLabel();
      b.onclick = () => { window.DevTheme.cycle(); b.textContent = themeLabel(); };
      links.appendChild(b);
    }
  });

  /* ---- command palette ---- */
  const sheets = () => (window.CATALOG && window.CATALOG.sheets) || [];
  function items() {
    const list = [];
    DT.tools().forEach(t => list.push({ kind: "Tool", name: t.name, hay: (t.name + " " + t.id + " " + (t.keywords || "") + " " + t.desc).toLowerCase(), run: () => { location.hash = "#" + t.id; } }));
    sheets().forEach(s => list.push({ kind: "Sheet", name: s.title, hay: (s.title + " " + s.id + " " + s.blurb).toLowerCase(), run: () => { location.href = "sheets/" + s.id + ".html"; } }));
    list.push({ kind: "Action", name: "Copy share link for this tool", hay: "share link copy url", run: copyShare });
    list.push({ kind: "Action", name: "Switch theme (auto / light / dark)", hay: "theme dark light mode", run: () => { const n = window.DevTheme.cycle(); const b = document.getElementById("themeBtn"); if (b) b.textContent = themeLabel(); DT.toast("Theme: " + n); } });
    list.push({ kind: "Action", name: "Expand all sidebar groups", hay: "expand sidebar groups", run: () => document.getElementById("expandAll").click() });
    list.push({ kind: "Action", name: "Collapse all sidebar groups", hay: "collapse sidebar groups", run: () => document.getElementById("collapseAll").click() });
    list.push({ kind: "Action", name: "All tools and sheets (overview page)", hay: "overview all index", run: () => { location.href = "all.html"; } });
    return list;
  }
  let pal = null;
  function closePalette() { if (pal) { pal.remove(); pal = null; } }
  function openPalette() {
    if (pal) return;
    const all = items();
    pal = document.createElement("div"); pal.id = "dt-palette";
    pal.innerHTML = `<div class="dt-pbox" role="dialog" aria-modal="true" aria-label="Command palette"><input type="text" id="dt-pq" placeholder="Jump to a tool, sheet or action…" autocomplete="off" aria-controls="dt-plist"><ul id="dt-plist" role="listbox"></ul></div>`;
    document.body.appendChild(pal);
    const input = pal.querySelector("#dt-pq"), ul = pal.querySelector("#dt-plist");
    let shown = [], sel = 0;
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = all.map(it => [lib.paletteScore(it, q), it]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 40).map(x => x[1]);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      ul.innerHTML = shown.map((it, i) => `<li role="option" id="dt-p${i}" data-i="${i}" aria-selected="${i === sel}"><span class="k">${it.kind}</span>${DT.esc(it.name)}</li>`).join("") || `<li class="none">No matches</li>`;
      input.setAttribute("aria-activedescendant", shown.length ? "dt-p" + sel : "");
      const cur = ul.querySelector("[aria-selected=true]"); if (cur) cur.scrollIntoView({ block: "nearest" });
    };
    const choose = i => { const it = shown[i]; closePalette(); if (it) it.run(); };
    input.addEventListener("input", () => { sel = 0; draw(); });
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
      else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
      else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
      else if (e.key === "Tab") e.preventDefault();                       // keep focus in the dialog
    });
    ul.addEventListener("click", e => { const li = e.target.closest("li[data-i]"); if (li) choose(+li.dataset.i); });
    pal.addEventListener("mousedown", e => { if (e.target === pal) closePalette(); });
    draw(); input.focus();
  }
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (pal) closePalette(); else openPalette(); }
  });

  /* ---- offline cache updates ---- */
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (had) DT.toast("A new version is ready.", { label: "Reload", run: () => location.reload() });
    });
  }
})();
