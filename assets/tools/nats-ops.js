/* NATS Explorer operations: saved connection profiles. Alerts (alerts.js) are mounted beside them.
   Profiles never contain credentials: only the URL, subscriptions, the feed filter and the hide-internal switch. */
(function () {
  const lib = DT.lib;

  lib.natsSubjectValid = subject => !lib.natsSubjectProblem(String(subject), true);

  /* ---- profiles ---- */
  lib.natsProfiles = {
    KEY: "dt.nats.profiles",
    clean(list) {
      const out = [];
      for (const p of Array.isArray(list) ? list : []) {
        if (!p || typeof p.name !== "string" || !p.name.trim() || typeof p.url !== "string" || !/^wss?:\/\/\S+$/i.test(p.url)) continue;
        const subs = (Array.isArray(p.subs) ? p.subs : []).filter(s => s && typeof s.subject === "string" && lib.natsSubjectValid(s.subject)).map(s => ({ subject: s.subject, queue: typeof s.queue === "string" ? s.queue : "" }));
        out.push({ name: p.name.trim().slice(0, 60), url: p.url, subs, hide: p.hide !== false, filter: typeof p.filter === "string" ? p.filter.slice(0, 200) : "" });
      }
      return out;
    },
    parse(json) { try { return this.clean(JSON.parse(json)); } catch (_) { return []; } },
    upsert(list, profile) { const c = this.clean([profile])[0]; if (!c) throw new Error("A profile needs a name and a ws:// or wss:// URL."); return list.filter(p => p.name !== c.name).concat(c).sort((a, b) => a.name.localeCompare(b.name)); },
    remove(list, name) { return list.filter(p => p.name !== name); },
  };

  /* ---- panel ----
     api: { getUrl, setUrl, getSubs() -> [{subject, queue}], connected() -> bool, resubscribe(subs), setHide(bool), getHide(),
            getFilter(), setFilter(text), hasSchema() } */
  lib.natsOps = function (host, api) {
    const esc = DT.esc;
    let profiles = [], pendingSubs = null;
    const alerts = new lib.Alerts();
    const read = () => { try { return lib.natsProfiles.parse(localStorage.getItem(lib.natsProfiles.KEY) || "[]"); } catch (_) { return []; } };
    const write = () => { try { localStorage.setItem(lib.natsProfiles.KEY, JSON.stringify(profiles)); } catch (_) { /* storage blocked */ } };
    profiles = read();
    host.innerHTML = `
      <details class="hint" id="ops"><summary><b>Profiles &amp; alerts</b> <span id="opsn"></span></summary>
        <div class="opts"><label>Profile <select id="pf" class="mono"></select></label>
          <button class="btn" id="pfload" type="button">Load</button><button class="btn" id="pfsave" type="button">Save current as…</button><button class="btn" id="pfdel" type="button">Delete</button>
          <button class="btn" id="pfexp" type="button">Export</button><button class="btn" id="pfimp" type="button">Import</button></div>
        <div class="hint">A profile remembers the URL, your subscriptions, the feed filter and the hide-internal switch. Passwords, tokens and keys are never saved.</div>
        <div id="alertsHost"></div>
      </details>`;
    const $ = s => host.querySelector(s);
    const ui = lib.alertsUi($("#alertsHost"), { alerts, hasSchema: api.hasSchema || (() => false), onChange: () => fillProfiles() });
    function fillProfiles(sel) {
      $("#pf").innerHTML = profiles.length ? profiles.map(p => `<option>${esc(p.name)}</option>`).join("") : `<option value="">(none saved)</option>`;
      if (sel) $("#pf").value = sel;
      $("#opsn").textContent = profiles.length || alerts.rules.length ? `· ${profiles.length} profile${profiles.length === 1 ? "" : "s"}, ${alerts.rules.length} alert${alerts.rules.length === 1 ? "" : "s"}` : "";
    }
    fillProfiles();

    $("#pfload").onclick = () => {
      const p = profiles.find(x => x.name === $("#pf").value); if (!p) return;
      api.setUrl(p.url); api.setHide(p.hide); if (api.setFilter) api.setFilter(p.filter || "");
      if (api.connected()) { if (p.subs.length) api.resubscribe(p.subs); DT.toast(`Loaded "${p.name}". Reconnect to switch servers.`); }
      else { pendingSubs = p.subs.length ? p.subs : null; DT.toast(`Loaded "${p.name}". Press Connect.`); }
    };
    $("#pfsave").onclick = () => {
      const name = (prompt("Profile name", $("#pf").value || "") || "").trim(); if (!name) return;
      const subs = api.getSubs(), plain = subs.length === 1 && subs[0].subject === ">" && !subs[0].queue;
      try { profiles = lib.natsProfiles.upsert(profiles, { name, url: api.getUrl(), subs: plain ? [] : subs, hide: api.getHide(), filter: api.getFilter ? api.getFilter() : "" }); write(); fillProfiles(name); DT.toast(`Saved "${name}"`); }
      catch (e) { DT.toast(e.message); }
    };
    $("#pfdel").onclick = () => { const n = $("#pf").value; if (!n) return; profiles = lib.natsProfiles.remove(profiles, n); write(); fillProfiles(); };
    $("#pfexp").onclick = () => DT.download("nats-profiles.json", JSON.stringify(profiles, null, 2), "application/json");
    $("#pfimp").onclick = () => {
      const f = document.createElement("input"); f.type = "file"; f.accept = ".json,application/json";
      f.onchange = () => { const r = new FileReader(); r.onload = () => { const got = lib.natsProfiles.parse(String(r.result)); got.forEach(p => { profiles = lib.natsProfiles.upsert(profiles, p); }); write(); fillProfiles(); DT.toast(`Imported ${got.length} profile${got.length === 1 ? "" : "s"}`); }; r.readAsText(f.files[0]); };
      f.click();
    };
    return {
      /* the subscriptions to open after connecting: those of a loaded profile, once, else just ">" */
      takeSubs() { const s = pendingSubs; pendingSubs = null; return s || [{ subject: ">", queue: "" }]; },
      record: ui.record, tick: ui.tick, alerts,
    };
  };
})();
