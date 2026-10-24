(function () {
  const lib = DT.lib;

  /* mode is a number 0-0o7777: special bits (setuid 4, setgid 2, sticky 1) in the top octal digit. */
  lib.modeToSymbolic = function (mode) {
    const bit = (m, i) => (m >> i) & 1;
    const trio = (shift, special, ch) => {
      const r = bit(mode, shift + 2) ? "r" : "-", w = bit(mode, shift + 1) ? "w" : "-", x = bit(mode, shift);
      const sp = bit(mode, special);
      const xc = sp ? (x ? ch : ch.toUpperCase()) : (x ? "x" : "-");
      return r + w + xc;
    };
    return trio(6, 11, "s") + trio(3, 10, "s") + trio(0, 9, "t");
  };
  lib.modeToOctal = mode => mode.toString(8).padStart(3, "0");
  lib.octalToMode = function (text) {
    const s = String(text).trim();
    if (!/^[0-7]{3,4}$/.test(s)) throw new Error("Use 3 or 4 octal digits, e.g. 755 or 4755.");
    return parseInt(s, 8);
  };
  lib.symbolicToMode = function (text) {
    let s = String(text).trim();
    if (s.length === 10 && /^[-dl]/.test(s)) s = s.slice(1);           // accept an ls -l string like -rwxr-xr-x
    if (!/^[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/.test(s)) throw new Error("Use nine characters like rwxr-xr-x.");
    let mode = 0;
    for (let i = 0; i < 9; i++) {
      const c = s[i], bit = 1 << (8 - i), col = i % 3;
      if ((col === 0 && c === "r") || (col === 1 && c === "w") || (col === 2 && "xst".includes(c))) mode |= bit;
    }
    if ("sS".includes(s[2])) mode |= 0o4000;
    if ("sS".includes(s[5])) mode |= 0o2000;
    if ("tT".includes(s[8])) mode |= 0o1000;
    return mode;
  };

  DT.register({
    id: "chmod", name: "chmod Calculator", group: "Network & Security",
    desc: "Toggle read / write / execute for owner, group and others (plus setuid, setgid and sticky) and get the octal and symbolic modes, or paste either form to decode it.",
    keywords: "permissions unix linux octal 755 644 rwx file mode setuid sticky",
    render(root) {
      const who = ["Owner", "Group", "Others"], perms = ["Read", "Write", "Execute"];
      root.innerHTML = `
        <div class="panel"><div class="grid-perm"><span></span>${perms.map(p => `<span class="lbl">${p}</span>`).join("")}
          ${who.map((w, wi) => `<span class="lbl">${w}</span>${perms.map((p, pi) => `<input type="checkbox" data-bit="${8 - wi * 3 - pi}" aria-label="${w} ${p}">`).join("")}`).join("")}</div>
          <div class="opts" style="margin-top:14px"><label><input type="checkbox" data-bit="11"> setuid</label><label><input type="checkbox" data-bit="10"> setgid</label><label><input type="checkbox" data-bit="9"> sticky</label></div></div>
        <div class="two"><div class="col"><label class="l" for="oct">Octal</label><input type="text" id="oct" class="mono" maxlength="4" spellcheck="false"></div>
          <div class="col"><label class="l" for="sym">Symbolic</label><input type="text" id="sym" class="mono" maxlength="10" spellcheck="false"></div></div>
        <div class="status" id="st"></div><div id="cmds"></div>
        <div class="chip-row" id="common">${[["644", "files"], ["755", "scripts, dirs"], ["600", "private keys"], ["700", "private dirs"], ["664", "group-writable"], ["777", "everyone (avoid)"], ["4755", "setuid"], ["1777", "/tmp"]].map(([o, d]) => `<span class="chip" data-o="${o}">${o} · ${d}</span>`).join("")}</div>`;
      const $ = s => root.querySelector(s), boxes = [...root.querySelectorAll("[data-bit]")];
      let mode = 0o755;
      function paint(skip) {
        boxes.forEach(b => b.checked = !!((mode >> +b.dataset.bit) & 1));
        if (skip !== "oct") $("#oct").value = lib.modeToOctal(mode);
        if (skip !== "sym") $("#sym").value = lib.modeToSymbolic(mode);
        const o = lib.modeToOctal(mode);
        $("#cmds").innerHTML = DT.kv([["chmod", `chmod ${o} <file>`], ["chmod (symbolic)", `chmod u=${lib.modeToSymbolic(mode).slice(0, 3).replace(/-/g, "")},g=${lib.modeToSymbolic(mode).slice(3, 6).replace(/-/g, "")},o=${lib.modeToSymbolic(mode).slice(6).replace(/-/g, "")} <file>`], ["ls -l", "-" + lib.modeToSymbolic(mode)], ["Recursive dirs only", `find . -type d -exec chmod ${o} {} +`]]);
      }
      boxes.forEach(b => b.onchange = () => { mode = boxes.reduce((m, x) => x.checked ? m | (1 << +x.dataset.bit) : m, 0); DT.status($("#st"), "", ""); paint(); });
      $("#oct").addEventListener("input", () => { try { mode = lib.octalToMode($("#oct").value); DT.status($("#st"), "", ""); paint("oct"); } catch (e) { DT.status($("#st"), "err", e.message); } });
      $("#sym").addEventListener("input", () => { try { mode = lib.symbolicToMode($("#sym").value); DT.status($("#st"), "", ""); paint("sym"); } catch (e) { DT.status($("#st"), "err", e.message); } });
      $("#common").addEventListener("click", e => { const c = e.target.closest("[data-o]"); if (c) { mode = lib.octalToMode(c.dataset.o); paint(); } });
      paint();
    },
  });
})();
