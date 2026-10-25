/* NATS Explorer operations: saved connection profiles and subject alerts.
   Pure logic lives on DT.lib (tested in Node); lib.natsOps(host, api) builds the panel inside the explorer.
   Profiles never contain credentials: only the URL, subscriptions and the hide-internal switch. */
(function () {
  const lib = DT.lib;

  /* NATS subject match: tokens split on ".", "*" matches one token, ">" matches the rest (one or more tokens). */
  lib.natsSubjectMatch = function (pattern, subject) {
    const p = String(pattern).split("."), s = String(subject).split(".");
    for (let i = 0; i < p.length; i++) {
      if (p[i] === ">") return s.length > i;
      if (i >= s.length) return false;
      if (p[i] !== "*" && p[i] !== s[i]) return false;
    }
    return p.length === s.length;
  };
  lib.natsSubjectValid = subject => /^(?:[^\s.*>]+|\*)(?:\.(?:[^\s.*>]+|\*))*(?:\.>)?$|^>$/.test(String(subject));

  /* ---- profiles ---- */
  lib.natsProfiles = {
    KEY: "dt.nats.profiles",
    clean(list) {
      const out = [];
      for (const p of Array.isArray(list) ? list : []) {
        if (!p || typeof p.name !== "string" || !p.name.trim() || typeof p.url !== "string" || !/^wss?:\/\/\S+$/i.test(p.url)) continue;
        const subs = (Array.isArray(p.subs) ? p.subs : []).filter(s => s && typeof s.subject === "string" && lib.natsSubjectValid(s.subject)).map(s => ({ subject: s.subject, queue: typeof s.queue === "string" ? s.queue : "" }));
        out.push({ name: p.name.trim().slice(0, 60), url: p.url, subs, hide: p.hide !== false });
      }
      return out;
    },
    parse(json) { try { return this.clean(JSON.parse(json)); } catch (_) { return []; } },
    upsert(list, profile) { const c = this.clean([profile])[0]; if (!c) throw new Error("A profile needs a name and a ws:// or wss:// URL."); return list.filter(p => p.name !== c.name).concat(c).sort((a, b) => a.name.localeCompare(b.name)); },
    remove(list, name) { return list.filter(p => p.name !== name); },
  };

  /* ---- alerts ----
     rule: { id, subject, kind: "rate" | "silence", value }
       rate     fires while the average over the last 5 seconds is above `value` messages per second
       silence  fires when nothing matching has arrived for `value` seconds (counted from when the rule was armed) */
  lib.NatsAlerts = class {
    constructor(rules = [], now = Date.now()) { this.rules = []; this.state = new Map(); rules.forEach(r => this.add(r, now)); }
    add(rule, now = Date.now()) {
      if (!lib.natsSubjectValid(rule.subject) || !rule.subject) throw new Error("Enter a valid subject pattern, for example orders.* or uci.>");
      const value = Number(rule.value);
      if (!(value > 0)) throw new Error("The threshold must be a positive number.");
      if (rule.kind !== "rate" && rule.kind !== "silence") throw new Error("Unknown alert type.");
      const r = { id: rule.id || Math.random().toString(36).slice(2, 8), subject: rule.subject, kind: rule.kind, value };
      this.rules.push(r); this.state.set(r.id, { secs: new Map(), last: 0, armed: now, firing: false }); return r;
    }
    remove(id) { this.rules = this.rules.filter(r => r.id !== id); this.state.delete(id); }
    record(subject, now = Date.now()) {
      const sec = Math.floor(now / 1000);
      for (const r of this.rules) if (lib.natsSubjectMatch(r.subject, subject)) { const st = this.state.get(r.id); st.secs.set(sec, (st.secs.get(sec) || 0) + 1); st.last = now; }
    }
    /* -> { firing: [{rule, text}], started: [...], cleared: [...] } where started/cleared are the changes since the last call. */
    evaluate(now = Date.now()) {
      const res = { firing: [], started: [], cleared: [] }, sec = Math.floor(now / 1000);
      for (const r of this.rules) {
        const st = this.state.get(r.id); let bad = false, text = "";
        for (const k of st.secs.keys()) if (k < sec - 10) st.secs.delete(k);
        if (r.kind === "rate") {
          let n = 0; for (let i = sec - 5; i < sec; i++) n += st.secs.get(i) || 0;
          const avg = n / 5; bad = avg > r.value; text = `${r.subject}: ${avg.toFixed(avg < 10 ? 1 : 0)} msg/s (limit ${r.value})`;
        } else {
          const since = (now - Math.max(st.last, st.armed)) / 1000; bad = since > r.value; text = `${r.subject}: silent for ${Math.floor(since)} s (limit ${r.value} s)`;
        }
        const item = { rule: r, text };
        if (bad) { res.firing.push(item); if (!st.firing) res.started.push(item); } else if (st.firing) res.cleared.push(item);
        st.firing = bad;
      }
      return res;
    }
  };

  /* ---- panel ----
     api: { getUrl, setUrl, getSubs() -> [{subject, queue}], connected() -> bool, resubscribe(subs), setHide(bool), getHide() } */
  lib.natsOps = function (host, api) {
    const esc = DT.esc;
    let profiles = [], pendingSubs = null, alerts = new lib.NatsAlerts();
    const read = () => { try { return lib.natsProfiles.parse(localStorage.getItem(lib.natsProfiles.KEY) || "[]"); } catch (_) { return []; } };
    const write = () => { try { localStorage.setItem(lib.natsProfiles.KEY, JSON.stringify(profiles)); } catch (_) { /* storage blocked */ } };
    profiles = read();
    host.innerHTML = `
      <details class="hint" id="ops"><summary><b>Profiles &amp; alerts</b> <span id="opsn"></span></summary>
        <div class="opts"><label>Profile <select id="pf" class="mono"></select></label>
          <button class="btn" id="pfload" type="button">Load</button><button class="btn" id="pfsave" type="button">Save current as…</button><button class="btn" id="pfdel" type="button">Delete</button>
          <button class="btn" id="pfexp" type="button">Export</button><button class="btn" id="pfimp" type="button">Import</button></div>
        <div class="hint">A profile remembers the URL, your subscriptions and the hide-internal switch. Passwords and tokens are never saved.</div>
        <div class="opts" style="margin-top:8px"><label>Alert on <input type="text" id="asub" class="mono" placeholder="subject, e.g. orders.* or uci.&gt;" style="width:220px"></label>
          <label><select id="akind"><option value="rate">rate above</option><option value="silence">silent for</option></select></label>
          <input type="number" id="aval" class="mono" value="100" min="1" style="width:80px"><span id="aunit" class="hint">msg/s</span>
          <button class="btn" id="aadd" type="button">Add alert</button></div>
        <div class="status" id="ast"></div><div class="chip-row" id="alist"></div>
      </details>
      <div id="abanner"></div>`;
    const $ = s => host.querySelector(s);
    const fillProfiles = sel => { $("#pf").innerHTML = profiles.length ? profiles.map(p => `<option>${esc(p.name)}</option>`).join("") : `<option value="">(none saved)</option>`; if (sel) $("#pf").value = sel; $("#opsn").textContent = profiles.length || alerts.rules.length ? `· ${profiles.length} profile${profiles.length === 1 ? "" : "s"}, ${alerts.rules.length} alert${alerts.rules.length === 1 ? "" : "s"}` : ""; };
    const drawAlerts = () => { $("#alist").innerHTML = alerts.rules.map(r => `<span class="chip" data-id="${r.id}" title="Click to remove">${esc(r.subject)} · ${r.kind === "rate" ? "&gt; " + r.value + " msg/s" : "silent &gt; " + r.value + " s"} ×</span>`).join(""); fillProfiles(); };
    fillProfiles();

    $("#pfload").onclick = () => {
      const p = profiles.find(x => x.name === $("#pf").value); if (!p) return;
      api.setUrl(p.url); api.setHide(p.hide);
      if (api.connected()) { if (p.subs.length) api.resubscribe(p.subs); DT.toast(`Loaded "${p.name}". Reconnect to switch servers.`); }
      else { pendingSubs = p.subs.length ? p.subs : null; DT.toast(`Loaded "${p.name}". Press Connect.`); }
    };
    $("#pfsave").onclick = () => {
      const name = (prompt("Profile name", $("#pf").value || "") || "").trim(); if (!name) return;
      const subs = api.getSubs(), plain = subs.length === 1 && subs[0].subject === ">" && !subs[0].queue;
      try { profiles = lib.natsProfiles.upsert(profiles, { name, url: api.getUrl(), subs: plain ? [] : subs, hide: api.getHide() }); write(); fillProfiles(name); DT.toast(`Saved "${name}"`); }
      catch (e) { $("#ast").textContent = e.message; }
    };
    $("#pfdel").onclick = () => { const n = $("#pf").value; if (!n) return; profiles = lib.natsProfiles.remove(profiles, n); write(); fillProfiles(); };
    $("#pfexp").onclick = () => DT.download("nats-profiles.json", JSON.stringify(profiles, null, 2), "application/json");
    $("#pfimp").onclick = () => {
      const f = document.createElement("input"); f.type = "file"; f.accept = ".json,application/json";
      f.onchange = () => { const r = new FileReader(); r.onload = () => { const got = lib.natsProfiles.parse(String(r.result)); got.forEach(p => { profiles = lib.natsProfiles.upsert(profiles, p); }); write(); fillProfiles(); DT.toast(`Imported ${got.length} profile${got.length === 1 ? "" : "s"}`); }; r.readAsText(f.files[0]); };
      f.click();
    };
    $("#akind").onchange = () => { $("#aunit").textContent = $("#akind").value === "rate" ? "msg/s" : "seconds"; $("#aval").value = $("#akind").value === "rate" ? 100 : 30; };
    $("#aadd").onclick = () => {
      try { alerts.add({ subject: $("#asub").value.trim(), kind: $("#akind").value, value: $("#aval").value }); $("#ast").textContent = ""; $("#asub").value = ""; drawAlerts(); }
      catch (e) { $("#ast").textContent = e.message; $("#ast").className = "status err"; }
    };
    $("#alist").onclick = e => { const c = e.target.closest(".chip"); if (c) { alerts.remove(c.dataset.id); drawAlerts(); render({ firing: alerts.evaluate().firing }); } };
    function render(res) {
      $("#abanner").innerHTML = res.firing.length ? `<div class="status err" role="alert">${res.firing.map(f => esc(f.text)).join("<br>")}</div>` : "";
    }
    return {
      /* the subscriptions to open after connecting: those of a loaded profile, once, else just ">" */
      takeSubs() { const s = pendingSubs; pendingSubs = null; return s || [{ subject: ">", queue: "" }]; },
      record(subject) { if (alerts.rules.length) alerts.record(subject); },
      tick() { if (!alerts.rules.length) { if ($("#abanner").innerHTML) render({ firing: [] }); return; } const r = alerts.evaluate(); render(r); r.started.forEach(s => DT.toast("Alert: " + s.text)); },
      alerts,
    };
  };
})();
