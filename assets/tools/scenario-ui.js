/* Panels shared by the NATS and CAL explorers:
     lib.scenarioUi(host, opts)   record, edit and play a sequence of messages
     lib.responderUi(host, opts)  answer incoming messages automatically (a stand-in for a service)
   The logic is in scenario.js; these only build the forms. Both persist to localStorage under opts.storeKey. */
(function () {
  const lib = DT.lib, esc = DT.esc;
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage blocked */ } },
  };

  /* opts: { storeKey, word: "subject" | "topic", send(topic, text) -> Promise, recent() -> [{t, topic, text}] (for "capture from feed"),
             sample(topic) -> text, optional (a starting message for a new step) } */
  lib.scenarioUi = function (host, opts) {
    const word = opts.word || "topic";
    let sc = store.get(opts.storeKey, null) || { name: "", vars: {}, steps: [] }, editing = -1, stopFlag = false, running = false;
    host.innerHTML = `
      <div class="hint" style="margin:0 0 8px">A scenario is a list of messages sent in order with a delay before each. Use <code>{{uuid}}</code>, <code>{{now}}</code>, <code>{{counter}}</code>, <code>{{rand:1-100}}</code>, <code>{{pick:a|b}}</code> and <code>{{var:name}}</code> in the ${word} or the text. Variables are the JSON object below.</div>
      <div class="two">
        <div class="col"><div class="opts"><label>${word} <input type="text" id="sctop" class="mono" style="width:240px" spellcheck="false"></label><label>delay before (ms) <input type="number" id="scdel" class="mono" value="0" min="0" style="width:90px"></label></div>
          <textarea id="sctxt" class="md" spellcheck="false" placeholder="message text"></textarea>
          <div class="btns"><button class="btn primary" id="scadd" type="button">Add step</button><button class="btn" id="scupd" type="button" hidden>Update step</button><button class="btn" id="sccan" type="button" hidden>Cancel edit</button><button class="btn" id="sccap" type="button" title="Turn the messages in the live feed into steps, keeping their timing">Capture from feed</button></div></div>
        <div class="col"><label class="l" for="scvars">Variables (JSON)</label><textarea id="scvars" class="sm mono" spellcheck="false">{}</textarea>
          <div class="opts"><label>Speed <select id="scspd" class="mono"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="10">10×</option><option value="0">no delays</option></select></label><label><input type="checkbox" id="scloop"> loop</label>
            <button class="btn primary" id="scrun" type="button">Run</button><button class="btn" id="scstop" type="button" hidden>Stop</button></div></div>
      </div>
      <div class="status" id="scst"></div>
      <div class="tscroll" style="max-height:30vh"><table class="nl"><tbody id="sclist"></tbody></table></div>
      <div class="btns"><button class="btn" id="scexp" type="button">Export JSON</button><button class="btn" id="scimp" type="button">Import JSON…</button><button class="btn" id="scclr" type="button">Clear all</button></div>`;
    const $ = s => host.querySelector(s), st = (k, m) => DT.status($("#scst"), k, m);
    const save = () => { sc.vars = parseVars(true) || sc.vars; store.set(opts.storeKey, sc); };
    function parseVars(quiet) { try { const v = JSON.parse($("#scvars").value || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) return v; throw new Error("must be a JSON object"); } catch (e) { if (!quiet) throw new Error("Variables: " + e.message); return null; } }
    $("#scvars").value = JSON.stringify(sc.vars || {});
    const draw = () => {
      $("#sclist").innerHTML = sc.steps.map((s, i) => `<tr data-i="${i}"><td class="t">${i + 1}</td><td class="t">+${s.delay} ms</td><td class="s">${esc(s.topic)}</td><td class="p">${esc(s.text.replace(/\s+/g, " ").slice(0, 90))}</td><td class="t"><a data-a="edit">edit</a> <a data-a="up">↑</a> <a data-a="down">↓</a> <a data-a="del">delete</a></td></tr>`).join("") || `<tr><td class="t">No steps yet. Fill in the form and press Add step.</td></tr>`;
      save();
    };
    const readForm = () => {
      const topic = $("#sctop").value.trim(), text = $("#sctxt").value, delay = Number($("#scdel").value || 0);
      if (!topic) throw new Error(`Enter a ${word}.`);
      if (!text.trim()) throw new Error("Enter the message text.");
      if (!(delay >= 0)) throw new Error("The delay must be 0 or more milliseconds.");
      const vars = parseVars(); lib.templateCheck(topic, { vars }); lib.templateCheck(text, { vars });
      return { delay, topic, text, note: "" };
    };
    const clearForm = () => { editing = -1; $("#scadd").hidden = false; $("#scupd").hidden = true; $("#sccan").hidden = true; };
    $("#scadd").onclick = () => { try { sc.steps.push(readForm()); $("#sctxt").value = ""; draw(); st("", ""); } catch (e) { st("err", e.message); } };
    $("#scupd").onclick = () => { try { sc.steps[editing] = readForm(); clearForm(); draw(); st("", ""); } catch (e) { st("err", e.message); } };
    $("#sccan").onclick = clearForm;
    $("#sclist").onclick = e => {
      const a = e.target.closest("a[data-a]"), tr = e.target.closest("tr[data-i]"); if (!a || !tr) return; const i = +tr.dataset.i;
      if (a.dataset.a === "del") sc.steps.splice(i, 1);
      else if (a.dataset.a === "up" && i > 0) [sc.steps[i - 1], sc.steps[i]] = [sc.steps[i], sc.steps[i - 1]];
      else if (a.dataset.a === "down" && i < sc.steps.length - 1) [sc.steps[i + 1], sc.steps[i]] = [sc.steps[i], sc.steps[i + 1]];
      else if (a.dataset.a === "edit") { editing = i; const s = sc.steps[i]; $("#sctop").value = s.topic; $("#sctxt").value = s.text; $("#scdel").value = s.delay; $("#scadd").hidden = true; $("#scupd").hidden = false; $("#sccan").hidden = false; }
      draw();
    };
    $("#sccap").onclick = () => {
      const recent = (opts.recent ? opts.recent() : []).slice(-50);
      if (!recent.length) return st("warn", "Nothing in the live feed yet.");
      let prev = recent[0].t;
      for (const m of recent) { sc.steps.push({ delay: Math.max(0, Math.round(m.t - prev)), topic: m.topic, text: m.text, note: "" }); prev = m.t; }
      draw(); st("ok", `Added ${recent.length} step${recent.length === 1 ? "" : "s"} from the feed, with their original spacing.`);
    };
    $("#scclr").onclick = () => { if (!sc.steps.length || confirm("Remove all steps?")) { sc.steps = []; clearForm(); draw(); } };
    $("#scexp").onclick = () => { try { sc.vars = parseVars(); } catch (e) { return st("err", e.message); } DT.download("scenario.json", lib.scenarioStringify(sc), "application/json"); };
    $("#scimp").onclick = () => {
      const f = document.createElement("input"); f.type = "file"; f.accept = ".json,application/json";
      f.onchange = () => { const r = new FileReader(); r.onload = () => { try { sc = lib.scenarioParse(String(r.result)); $("#scvars").value = JSON.stringify(sc.vars || {}); draw(); st("ok", `Imported ${sc.steps.length} step${sc.steps.length === 1 ? "" : "s"}.`); } catch (e) { st("err", e.message); } }; r.readAsText(f.files[0]); };
      f.click();
    };
    $("#scstop").onclick = () => { stopFlag = true; };
    $("#scrun").onclick = async () => {
      if (running) return;
      if (!sc.steps.length) return st("warn", "Add a step first.");
      try { sc.vars = parseVars(); } catch (e) { return st("err", e.message); }
      running = true; stopFlag = false; $("#scrun").hidden = true; $("#scstop").hidden = false;
      try {
        const r = await lib.scenarioRun(sc, (topic, text) => opts.send(topic, text), {
          speed: +$("#scspd").value, loop: $("#scloop").checked, isStopped: () => stopFlag || !host.isConnected,
          onStep: p => st(p.failed ? "warn" : "", `Step ${p.i} of ${p.of}${p.rounds ? ` (round ${p.rounds + 1})` : ""}: ${p.sent} sent${p.failed ? `, ${p.failed} failed (${p.lastError})` : ""}`),
        });
        st(r.failed ? "warn" : "ok", `${r.stopped ? "Stopped. " : "Done. "}${r.sent} message${r.sent === 1 ? "" : "s"} sent${r.failed ? `, ${r.failed} failed (last: ${r.lastError})` : ""}.`);
      } catch (e) { st("err", e.message); }
      running = false; $("#scrun").hidden = false; $("#scstop").hidden = true;
    };
    if (opts.sample) $("#sctop").addEventListener("change", () => { if (!$("#sctxt").value) { const s = opts.sample($("#sctop").value.trim()); if (s) $("#sctxt").value = s; } });
    draw();
    return { stop: () => { stopFlag = true; }, get scenario() { return sc; } };
  };

  /* opts: { storeKey, word, withMessage: bool (CAL: match on a message name), reply(topic, text, incoming) -> Promise, topics() -> datalist values } */
  lib.responderUi = function (host, opts) {
    const word = opts.word || "topic", RATE = 50;
    let rules = store.get(opts.storeKey, []).filter(r => r && r.match && r.reply), counter = 0, log = [], sentSec = { s: 0, n: 0 };
    const recent = new Map();                                                                // reply text recently sent, so a rule cannot answer itself
    host.innerHTML = `
      <div class="hint" style="margin:0 0 8px">Answers incoming messages automatically, so you can test a client or a consumer without the real service. The first enabled rule that matches replies. In replies use <code>{{in:FieldName}}</code> to copy a field from the incoming message, plus <code>{{uuid}}</code>, <code>{{now}}</code>, <code>{{counter}}</code>, <code>{{rand:A-B}}</code>${word === "subject" ? ", <code>{{replyto}}</code>" : ""}.</div>
      <div class="two">
        <div class="col"><label class="l">When a message arrives</label>
          <div class="opts"><label>on ${word} <input type="text" id="rmt" class="mono" placeholder="pattern, e.g. cmd.> (blank = any)" style="width:220px" spellcheck="false"></label>${opts.withMessage ? `<label>message <input type="text" id="rmm" class="mono" placeholder="any" style="width:150px" spellcheck="false"></label>` : ""}</div>
          <div class="opts"><label>and where <input type="text" id="rmq" class="mono" placeholder="optional field query, e.g. Kind = Ping" style="width:300px" spellcheck="false"></label></div>
          <label class="l" for="rname" style="margin-top:6px">Rule name</label><input type="text" id="rname" class="mono" placeholder="optional" spellcheck="false"></div>
        <div class="col"><label class="l">Reply with</label>
          <div class="opts"><label>${word} <input type="text" id="rrt" class="mono" placeholder="${word === "subject" ? "blank = the request's reply-to" : "e.g. status.{{in:Id}}"}" style="width:240px" spellcheck="false"></label><label>after (ms) <input type="number" id="rrd" class="mono" value="0" min="0" style="width:80px"></label></div>
          <textarea id="rrx" class="md" spellcheck="false" placeholder="reply text"></textarea></div>
      </div>
      <div class="btns"><button class="btn primary" id="radd" type="button">Add rule</button></div>
      <div class="status" id="rst"></div>
      <div class="tscroll" style="max-height:24vh"><table class="nl"><tbody id="rlist"></tbody></table></div>
      <details class="hint" open><summary>Replies sent <span id="rn"></span></summary><div class="tscroll" style="max-height:22vh"><table class="nl"><tbody id="rlog"></tbody></table></div></details>`;
    const $ = s => host.querySelector(s), st = (k, m) => DT.status($("#rst"), k, m);
    const save = () => store.set(opts.storeKey, rules.map(r => ({ id: r.id, name: r.name, enabled: r.enabled, match: r.match, reply: r.reply, hits: 0 })));
    const draw = () => {
      $("#rlist").innerHTML = rules.map((r, i) => `<tr data-i="${i}"><td class="t"><input type="checkbox" data-a="on" aria-label="Enabled" ${r.enabled !== false ? "checked" : ""}></td><td class="s">${esc(r.name || "rule " + (i + 1))}</td><td class="p">on ${esc(r.match.topic || "any")}${r.match.message ? " · " + esc(r.match.message) : ""}${r.match.query ? " where " + esc(r.match.query) : ""} → ${esc(r.reply.topic || "(reply-to)")} after ${r.reply.delay || 0} ms</td><td class="t">${r.hits || 0} sent</td><td class="t"><a data-a="del">delete</a></td></tr>`).join("") || `<tr><td class="t">No rules yet.</td></tr>`;
      $("#rlog").innerHTML = log.slice(-100).reverse().map(l => `<tr><td class="t">${new Date(l.t).toISOString().slice(11, 23)}</td><td class="s">${esc(l.rule)}</td><td class="s">${esc(l.topic)}</td><td class="p">${esc(l.text.replace(/\s+/g, " ").slice(0, 100))}</td></tr>`).join("") || `<tr><td class="t">Nothing sent yet.</td></tr>`;
      $("#rn").textContent = log.length ? `(${log.length})` : "";
    };
    $("#radd").onclick = () => {
      try {
        const rule = { id: Math.random().toString(36).slice(2, 8), name: $("#rname").value.trim(), enabled: true, hits: 0,
          match: { topic: $("#rmt").value.trim(), message: opts.withMessage ? $("#rmm").value.trim() : "", query: $("#rmq").value.trim() },
          reply: { topic: $("#rrt").value.trim(), text: $("#rrx").value, delay: Number($("#rrd").value || 0) } };
        if (rule.match.topic && !lib.natsSubjectValid(rule.match.topic)) throw new Error(`The ${word} pattern is not valid.`);
        if (rule.match.query) { const q = lib.fieldQuery(rule.match.query); if (!q.ok) throw new Error(q.error); }
        if (!rule.reply.text.trim()) throw new Error("Enter the reply text.");
        if (!rule.reply.topic && word !== "subject") throw new Error(`Enter the ${word} to reply on.`);
        lib.templateCheck(rule.reply.topic, { hasIncoming: true }); lib.templateCheck(rule.reply.text, { hasIncoming: true });
        if (!(rule.reply.delay >= 0)) throw new Error("The delay must be 0 or more milliseconds.");
        rules.push(rule); save(); draw(); st("", ""); $("#rrx").value = "";
      } catch (e) { st("err", e.message); }
    };
    $("#rlist").onclick = e => {
      const tr = e.target.closest("tr[data-i]"); if (!tr) return; const i = +tr.dataset.i;
      if (e.target.dataset.a === "del") { rules.splice(i, 1); save(); draw(); }
      else if (e.target.dataset.a === "on") { rules[i].enabled = e.target.checked; save(); }
    };
    draw();
    return {
      /* incoming: { topic, message, text, replyTo }. Returns true when a rule answered. */
      handle(m) {
        if (!rules.length) return false;
        const now = Date.now();
        for (const [k, t] of recent) if (now - t > 3000) recent.delete(k);
        if (recent.has(m.topic + "\u0000" + m.text)) return false;                         // one of our own replies coming back
        const rule = lib.responderFind(rules, m); if (!rule) return false;
        const sec = Math.floor(now / 1000); if (sentSec.s !== sec) sentSec = { s: sec, n: 0 };
        if (++sentSec.n > RATE) return false;                                              // runaway protection
        let out; try { out = lib.responderBuild(rule, m, { counter: ++counter }); } catch (e) { st("err", `${rule.name || "rule"}: ${e.message}`); return false; }
        if (!out.topic) return false;
        const fire = async () => {
          recent.set(out.topic + "\u0000" + out.text, Date.now());
          try { await opts.reply(out.topic, out.text, m); rule.hits = (rule.hits || 0) + 1; log.push({ t: Date.now(), rule: rule.name || rule.id, topic: out.topic, text: out.text }); if (log.length > 300) log.splice(0, log.length - 300); draw(); }
          catch (e) { st("err", `Reply failed: ${e.message}`); }
        };
        if (out.delay > 0) setTimeout(fire, out.delay); else fire();
        return true;
      },
      get count() { return rules.length; },
    };
  };
})();
