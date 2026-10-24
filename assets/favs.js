/* Starred tools and cheat sheets, remembered in this browser and shared by every page of the site.
   Ids look like "tool:json" and "sheet:git". Favs.list() keeps the order they were starred in.
   Favs.toggle(id) returns the new state; Favs.onChange(fn) fires when another tab changes the list. */
(function () {
  const KEY = "dt.favs";
  const read = () => {
    try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? [...new Set(v.filter(x => typeof x === "string"))] : []; }
    catch (_) { return []; }
  };
  let list = read();
  const listeners = [];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { /* storage unavailable: stars last until the page closes */ } };

  window.Favs = {
    list: () => list.slice(),
    has: id => list.includes(id),
    toggle(id) { list = list.includes(id) ? list.filter(x => x !== id) : [...list, id]; save(); return list.includes(id); },
    onChange: fn => { listeners.push(fn); },
    /* Keep every .star[data-fav] button on the page in step with the list. */
    sync(root = document) {
      root.querySelectorAll(".star[data-fav]").forEach(b => {
        const on = list.includes(b.dataset.fav);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
        b.title = on ? "Remove from favorites" : "Add to favorites";
      });
    },
  };
  window.addEventListener("storage", e => { if (e.key === KEY) { list = read(); listeners.forEach(f => f()); } });
})();
