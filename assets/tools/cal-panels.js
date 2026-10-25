/* The extra tabs and panels of the CAL Explorer: subscription presets, message-level alerts, scenarios and a responder.
   cal.js creates the containers and calls lib.calPanels(ctx). The logic is shared with the NATS Explorer (alerts.js, scenario.js, scenario-ui.js). */
(function () {
  const lib = DT.lib, esc = DT.esc;

  /* ---- presets: a named set of subscriptions (plus the connection details and feed filter), without anything secret ---- */
  lib.calPresets = {
    KEY: "dt.cal.presets",
    clean(list) {
      const out = [];
      for (const p of Array.isArray(list) ? list : []) {
        if (!p || typeof p.name !== "string" || !p.name.trim()) continue;
        const subs = (Array.isArray(p.subs) ? p.subs : []).filter(s => s && lib.owpToken.test(String(s.topic || "")) && lib.owpMessageName.test(String(s.message || ""))).map(s => ({ topic: s.topic, message: s.message, group: typeof s.group === "string" ? s.group : "" }));
        const conn = p.conn && typeof p.conn === "object" ? { url: /^wss?:\/\/\S+$/i.test(p.conn.url || "") ? p.conn.url : "", service: String(p.conn.service || ""), schema: String(p.conn.schema || ""), versions: String(p.conn.versions || "") } : null;
        out.push({ name: p.name.trim().slice(0, 60), subs, conn, filter: typeof p.filter === "string" ? p.filter.slice(0, 200) : "" });
      }
      return out;
    },
    parse(json) { try { return this.clean(JSON.parse(json)); } catch (_) { return []; } },
    upsert(list, preset) { const c = this.clean([preset])[0]; if (!c) throw new Error("A preset needs a name."); return list.filter(p => p.name !== c.name).concat(c).sort((a, b) => a.name.localeCompare(b.name)); },
    remove(list, name) { return list.filter(p => p.name !== name); },
  };

  /* ctx: { root, $, client, status, getModel(), msgs(), subs() -> [{topic, messageName, group}], applySubs(list) -> Promise, getConn(), setConn(c), getFilter(), setFilter(t) } */
  lib.calPanels = function (ctx) {
    const { root, $, client } = ctx;
    let presets = [];
    const read = () => { try { return lib.calPresets.parse(localStorage.getItem(lib.calPresets.KEY) || "[]"); } catch (_) { return []; } };
    const write = () => { try { localStorage.setItem(lib.calPresets.KEY, JSON.stringify(presets)); } catch (_) { /* storage blocked */ } };
    presets = read();

    /* presets bar (inside the Live tab) */
    const ph = $("#x-presets");
    ph.innerHTML = `<div class="opts" style="margin:0 0 4px"><label>Preset <select id="cps" class="mono"></select></label><button class="btn" id="cpload" type="button">Load</button><button class="btn" id="cpsave" type="button">Save current as…</button><button class="btn" id="cpdel" type="button">Delete</button><button class="btn" id="cpexp" type="button">Export</button><button class="btn" id="cpimp" type="button">Import</button><span class="hint">subscriptions, connection details and filter; nothing secret</span></div>`;
    const p$ = s => ph.querySelector(s);
    const fill = sel => { p$("#cps").innerHTML = presets.length ? presets.map(p => `<option>${esc(p.name)}</option>`).join("") : `<option value="">(none saved)</option>`; if (sel) p$("#cps").value = sel; };
    fill();
    p$("#cpsave").onclick = () => {
      const name = (prompt("Preset name", p$("#cps").value || "") || "").trim(); if (!name) return;
      try { presets = lib.calPresets.upsert(presets, { name, subs: ctx.subs().map(s => ({ topic: s.topic, message: s.messageName, group: s.group || "" })), conn: ctx.getConn(), filter: ctx.getFilter() }); write(); fill(name); DT.toast(`Saved "${name}"`); }
      catch (e) { DT.toast(e.message); }
    };
    p$("#cpload").onclick = async () => {
      const p = presets.find(x => x.name === p$("#cps").value); if (!p) return;
      if (p.conn && p.conn.url) ctx.setConn(p.conn);
      ctx.setFilter(p.filter || "");
      if (!client.connected) { DT.toast(`Loaded "${p.name}": connection details and filter. Connect, then load it again to subscribe.`); return; }
      const r = await ctx.applySubs(p.subs);
      DT.toast(`Loaded "${p.name}": ${r.added} subscribed${r.failed.length ? ", " + r.failed.length + " refused" : ""}`);
    };
    p$("#cpdel").onclick = () => { const n = p$("#cps").value; if (!n) return; presets = lib.calPresets.remove(presets, n); write(); fill(); };
    p$("#cpexp").onclick = () => DT.download("cal-presets.json", JSON.stringify(presets, null, 2), "application/json");
    p$("#cpimp").onclick = () => {
      const f = document.createElement("input"); f.type = "file"; f.accept = ".json,application/json";
      f.onchange = () => { const r = new FileReader(); r.onload = () => { const got = lib.calPresets.parse(String(r.result)); got.forEach(p => { presets = lib.calPresets.upsert(presets, p); }); write(); fill(); DT.toast(`Imported ${got.length} preset${got.length === 1 ? "" : "s"}`); }; r.readAsText(f.files[0]); };
      f.click();
    };

    /* alerts */
    const alerts = new lib.Alerts();
    const aui = lib.alertsUi($("#x-alr"), { alerts, topicWord: "topic", withType: true, hasSchema: () => !!ctx.getModel() });

    /* scenario and responder */
    const scn = lib.scenarioUi($("#x-scn"), { storeKey: "dt.cal.scenario", word: "topic", send: (topic, text) => client.publish(topic, text),
      recent: () => ctx.msgs().slice(-50).map(m => ({ t: m.t, topic: m.topic, text: m.text })) });
    const responder = lib.responderUi($("#x-resp"), { storeKey: "dt.cal.responder", word: "topic", withMessage: true, reply: (topic, text) => client.publish(topic, text) });

    return {
      /* every message received: m = { topic, message, text } */
      onMsg(m) {
        aui.record(m.topic, { type: m.message, text: () => m.text,
          invalid: () => { const model = ctx.getModel(); if (!model) return undefined; const v = lib.owpValidate(model, m.text); return v.errors && v.errors.length && !v.name ? undefined : !v.ok; },
          reason: () => { const model = ctx.getModel(), v = model && lib.owpValidate(model, m.text); return v && v.errors[0] ? v.errors[0].message : "failed schema validation"; } });
        if (responder.count) responder.handle({ topic: m.topic, message: m.message, text: m.text });
      },
      tick() { aui.tick(); },
      close() { scn.stop(); },
    };
  };
})();
