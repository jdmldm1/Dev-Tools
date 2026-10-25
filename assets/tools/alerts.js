/* Alert rules for live traffic, shared by the NATS and CAL explorers.
     rate     average messages per second over the last 5 s is above `value`
     silence  nothing matching for more than `value` seconds
     match    a payload contains `value` (text, or /regex/flags)
     field    a payload satisfies a field query (see lib.fieldQuery), e.g. Latitude > 34
     invalid  a message fails validation against the loaded schema
   `subject` is a NATS-style pattern (* one token, > the rest; for CAL it matches the topic); `type` optionally restricts to one message name.
   Event rules (match, field, invalid) keep a history of what triggered them. */
(function () {
  const lib = DT.lib;
  const EVENT = new Set(["match", "field", "invalid"]), KINDS = new Set(["rate", "silence", "match", "field", "invalid"]);
  const HOLD = 10000;                                           // an event rule stays "firing" this long after its last event

  const textTest = value => {
    const r = /^\/(.+)\/([a-z]*)$/.exec(value);
    if (r) { const re = new RegExp(r[1], r[2].includes("i") ? r[2] : r[2] + "i"); return t => re.test(t); }
    const v = value.toLowerCase(); return t => t.toLowerCase().includes(v);
  };

  lib.Alerts = class {
    constructor(rules = [], now = Date.now()) { this.rules = []; this.state = new Map(); this.history = []; rules.forEach(r => this.add(r, now)); }
    add(rule, now = Date.now()) {
      const kind = rule.kind;
      if (!KINDS.has(kind)) throw new Error("Unknown alert type.");
      const subject = String(rule.subject || "").trim() || ">";
      if (!lib.natsSubjectValid(subject)) throw new Error("Enter a valid subject pattern, for example orders.* or uci.>");
      const r = { id: rule.id || Math.random().toString(36).slice(2, 8), subject, kind, value: rule.value, type: rule.type ? String(rule.type).trim() : "" };
      if (kind === "rate" || kind === "silence") {
        r.value = Number(rule.value);
        if (!(r.value > 0)) throw new Error("The threshold must be a positive number.");
      } else if (kind === "match") {
        r.value = String(rule.value || "").trim();
        if (!r.value) throw new Error("Enter the text to look for (or a /regex/).");
        try { r._test = textTest(r.value); } catch (e) { throw new Error("Bad regular expression: " + e.message); }
      } else if (kind === "field") {
        const q = lib.fieldQuery(rule.value);
        if (!q.ok) throw new Error(q.error);
        r.value = String(rule.value).trim(); r._query = q;
      } else r.value = "";
      this.rules.push(r); this.state.set(r.id, { secs: new Map(), last: 0, armed: now, firing: false, lastEvent: 0, events: 0 });
      return r;
    }
    remove(id) { this.rules = this.rules.filter(r => r.id !== id); this.state.delete(id); }
    /* ctx (all optional, lazy): { type, text: () => string, fields: () => Map, invalid: () => boolean | undefined } */
    record(subject, now = Date.now(), ctx = {}) {
      const sec = Math.floor(now / 1000);
      for (const r of this.rules) {
        if (!lib.natsSubjectMatch(r.subject, subject)) continue;
        if (r.type && ctx.type !== r.type) continue;
        const st = this.state.get(r.id);
        if (r.kind === "rate" || r.kind === "silence") { st.secs.set(sec, (st.secs.get(sec) || 0) + 1); st.last = now; continue; }
        let hit = false, detail = "";
        if (r.kind === "match") { const t = ctx.text ? ctx.text() : ""; hit = r._test(t); if (hit) detail = t.replace(/\s+/g, " ").slice(0, 120); }
        else if (r.kind === "field") {
          const raw = ctx.text ? ctx.text() : "", fields = ctx.fields ? ctx.fields() : lib.payloadFields(raw).fields;
          hit = r._query.test(fields, { raw, topic: subject });
          if (hit) detail = raw.replace(/\s+/g, " ").slice(0, 120);
        } else if (r.kind === "invalid") { hit = ctx.invalid ? ctx.invalid() === true : false; if (hit) detail = ctx.reason ? ctx.reason() : "failed schema validation"; }
        if (hit) {
          st.events++; st.last = now;
          if (now - st.lastEvent >= 1000 || !st.lastEvent) this.history.push({ t: now, ruleId: r.id, subject, type: ctx.type || "", kind: r.kind, detail });   // at most one history line per rule per second
          st.lastEvent = now;
          if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
        }
      }
    }
    /* -> { firing: [{rule, text}], started: [...], cleared: [...] } (started / cleared are the changes since the last call) */
    evaluate(now = Date.now()) {
      const res = { firing: [], started: [], cleared: [] }, sec = Math.floor(now / 1000);
      for (const r of this.rules) {
        const st = this.state.get(r.id); let bad = false, text = "";
        for (const k of st.secs.keys()) if (k < sec - 10) st.secs.delete(k);
        const scope = r.subject + (r.type ? " · " + r.type : "");
        if (r.kind === "rate") {
          let n = 0; for (let i = sec - 5; i < sec; i++) n += st.secs.get(i) || 0;
          const avg = n / 5; bad = avg > r.value; text = `${scope}: ${avg.toFixed(avg < 10 ? 1 : 0)} msg/s (limit ${r.value})`;
        } else if (r.kind === "silence") {
          const since = (now - Math.max(st.last, st.armed)) / 1000; bad = since > r.value; text = `${scope}: silent for ${Math.floor(since)} s (limit ${r.value} s)`;
        } else {
          bad = st.lastEvent > 0 && now - st.lastEvent < HOLD;
          const what = r.kind === "match" ? `contains ${r.value}` : r.kind === "field" ? r.value : "invalid message";
          text = `${scope}: ${what} (${st.events} so far)`;
        }
        const item = { rule: r, text };
        if (bad) { res.firing.push(item); if (!st.firing) res.started.push(item); } else if (st.firing) res.cleared.push(item);
        st.firing = bad;
      }
      return res;
    }
    describe(r) {
      return r.kind === "rate" ? `rate > ${r.value} msg/s` : r.kind === "silence" ? `silent > ${r.value} s` : r.kind === "match" ? `contains ${r.value}` : r.kind === "field" ? `where ${r.value}` : "schema-invalid";
    }
  };
  lib.NatsAlerts = lib.Alerts;                                  // the name used before CAL shared it

  /* Panel: add / list / remove rules, a banner while any are firing, and a history. hooks: { toast(msg), hasSchema() } */
  lib.alertsUi = function (host, { alerts, topicWord = "subject", withType = false, hasSchema = () => true, onChange = () => {} }) {
    const esc = DT.esc;
    host.innerHTML = `
      <div class="opts" style="margin-top:8px"><label>Alert on <input type="text" id="asub" class="mono" placeholder="${topicWord} pattern, e.g. orders.* (blank = all)" style="width:220px"></label>
        ${withType ? `<label>message <input type="text" id="atype" class="mono" placeholder="any" style="width:130px"></label>` : ""}
        <label><select id="akind"><option value="rate">rate above</option><option value="silence">silent for</option><option value="match">payload contains</option><option value="field">field query</option><option value="invalid">fails schema</option></select></label>
        <input type="text" id="aval" class="mono" value="100" style="width:170px"><span id="aunit" class="hint">msg/s</span>
        <button class="btn" id="aadd" type="button">Add alert</button></div>
      <div class="status" id="ast"></div><div class="chip-row" id="alist"></div>
      <details class="hint" id="ahist"><summary>Alert history <span id="ahn"></span></summary><div class="tscroll" style="max-height:20vh"><table class="nl"><tbody id="ahrows"></tbody></table></div></details>
      <div id="abanner"></div>`;
    const $ = s => host.querySelector(s);
    const UNITS = { rate: ["msg/s", "100"], silence: ["seconds", "30"], match: ["text or /regex/", "ERROR"], field: ["e.g. Latitude > 34 and SystemID = alpha", "Latitude > 34"], invalid: ["", ""] };
    const sync = () => { const k = $("#akind").value; $("#aunit").textContent = UNITS[k][0]; $("#aval").value = UNITS[k][1]; $("#aval").hidden = k === "invalid"; };
    $("#akind").onchange = sync;
    const draw = () => {
      $("#alist").innerHTML = alerts.rules.map(r => `<span class="chip" data-id="${r.id}" title="Click to remove">${esc(r.subject)}${r.type ? " · " + esc(r.type) : ""} · ${esc(alerts.describe(r))} ×</span>`).join("");
      onChange();
    };
    const hist = () => {
      const h = alerts.history.slice(-100).reverse();
      $("#ahn").textContent = alerts.history.length ? `(${alerts.history.length})` : "";
      $("#ahrows").innerHTML = h.map(e => `<tr><td class="t">${new Date(e.t).toISOString().slice(11, 23)}</td><td class="s">${esc(e.subject)}</td><td class="ty">${esc(e.type)}</td><td class="p">${esc(e.kind)}: ${esc(e.detail)}</td></tr>`).join("") || `<tr><td class="t">Nothing has fired yet.</td></tr>`;
    };
    $("#aadd").onclick = () => {
      try {
        if ($("#akind").value === "invalid" && !hasSchema()) throw new Error("Load a schema first: \"fails schema\" needs it.");
        alerts.add({ subject: $("#asub").value, type: withType ? $("#atype").value : "", kind: $("#akind").value, value: $("#aval").value });
        DT.status($("#ast"), "", ""); $("#asub").value = ""; draw();
      } catch (e) { DT.status($("#ast"), "err", e.message); }
    };
    $("#alist").onclick = e => { const c = e.target.closest(".chip"); if (c) { alerts.remove(c.dataset.id); draw(); render({ firing: alerts.evaluate().firing }); } };
    function render(res) { $("#abanner").innerHTML = res.firing.length ? `<div class="status err" role="alert">${res.firing.map(f => esc(f.text)).join("<br>")}</div>` : ""; }
    sync(); draw(); hist();
    return {
      record: (subject, ctx) => { if (alerts.rules.length) alerts.record(subject, Date.now(), ctx); },
      tick() {
        if (!alerts.rules.length) { if ($("#abanner").innerHTML) render({ firing: [] }); return; }
        const r = alerts.evaluate(); render(r); r.started.forEach(s => DT.toast("Alert: " + s.text));
        if ($("#ahist").open) hist();
      },
      redraw: draw,
    };
  };
})();
