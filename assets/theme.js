/* Theme preference: "dark" (default), "light", or "auto" (follow the system). Runs in <head> so the page never flashes the wrong theme. */
(function () {
  const KEY = "dt-theme", mq = window.matchMedia && matchMedia("(prefers-color-scheme: light)");
  let pref = "dark";
  try { pref = localStorage.getItem(KEY) || "dark"; } catch (_) { /* storage blocked */ }
  const resolve = p => p === "auto" ? (mq && mq.matches ? "light" : "dark") : p;
  const apply = () => { document.documentElement.setAttribute("data-theme", resolve(pref)); };
  window.DevTheme = {
    get: () => pref,
    set(p) { pref = p; try { localStorage.setItem(KEY, p); } catch (_) { /* ignore */ } apply(); },
    cycle() { const n = { dark: "light", light: "auto", auto: "dark" }[pref] || "dark"; this.set(n); return n; },
  };
  if (mq && mq.addEventListener) mq.addEventListener("change", () => { if (pref === "auto") apply(); });
  apply();
})();
