/* Collapsible <details class="grp" data-g="Name"> groups with remembered open/closed state.
   Groups.bind(container, ns, dflt)     restore saved state and save whenever the user toggles a group
   Groups.setAll(container, ns, open)   expand / collapse everything (and remember it)
   Groups.restore(container, ns, dflt)  put every group back to its remembered state (used after a search)
   Groups.set(el, open)                 change a group programmatically (NOT remembered)
   Groups.open(el)                      open el's group and its parents (NOT remembered)

   The "toggle" event fires asynchronously, so programmatic changes are tagged on the element
   (not with a global flag) and the handler skips exactly the event that change causes. */
(function () {
  const key = ns => "dt.groups." + ns;
  const read = ns => { try { return JSON.parse(localStorage.getItem(key(ns)) || "{}"); } catch (_) { return {}; } };
  const write = (ns, s) => { try { localStorage.setItem(key(ns), JSON.stringify(s)); } catch (_) { /* storage unavailable: state just won't persist */ } };

  function set(d, open) { if (d.open !== open) { d._prog = open; d.open = open; } }

  window.Groups = {
    set,
    bind(container, ns, dflt = false) {
      const state = read(ns);
      container.querySelectorAll("details.grp").forEach(d => {
        set(d, d.dataset.g in state ? state[d.dataset.g] : dflt);
        d.addEventListener("toggle", () => {
          if (d._prog !== undefined && d._prog === d.open) { d._prog = undefined; return; }   // caused by code, not by the user
          const s = read(ns); s[d.dataset.g] = d.open; write(ns, s);
        });
      });
    },
    setAll(container, ns, open) {
      const s = {};
      container.querySelectorAll("details.grp").forEach(d => { s[d.dataset.g] = open; set(d, open); });
      write(ns, s);
    },
    restore(container, ns, dflt = false) {
      const state = read(ns);
      container.querySelectorAll("details.grp").forEach(d => set(d, d.dataset.g in state ? state[d.dataset.g] : dflt));
    },
    open(el) { for (let d = el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) set(d, true); },
  };
})();
