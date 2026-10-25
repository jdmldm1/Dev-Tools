/* Message templates, scripted scenarios and auto-responders, shared by the NATS and CAL explorers.

   Template variables (inside {{ }}):
     uuid  now  epoch  epochMs  counter           generated per message ("now" is ISO 8601 UTC without milliseconds)
     rand:1-100  pick:a|b|c                      a random integer, or one of the choices
     var:name                                    from the scenario's variables
     in:Path                                     a field of the message being answered (a trailing path, e.g. in:SystemID)
     topic                                       the topic or subject of the message being answered
   Scenario: [{ delay (ms before this step), topic, text, note }] played in order, optionally looped.
   Responder rule: { id, name, enabled, match: { topic, message, query }, reply: { topic, text, delay } }. */
(function () {
  const lib = DT.lib;
  const uuid4 = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));

  lib.templateVars = text => [...String(text).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(m => m[1]);

  /* ctx: { counter, vars: {}, fields: Map, topic, now: Date } */
  lib.template = function (text, ctx = {}) {
    const now = ctx.now || new Date();
    return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
      const [name, ...rest] = expr.split(":"), arg = rest.join(":");
      switch (name) {
        case "uuid": return uuid4();
        case "now": return now.toISOString().replace(/\.\d+Z$/, "Z");
        case "epoch": return String(Math.floor(now.getTime() / 1000));
        case "epochMs": return String(now.getTime());
        case "counter": return String(ctx.counter || 0);
        case "topic": case "subject": return ctx.topic === undefined ? "" : String(ctx.topic);
        case "rand": {
          const m = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(arg); if (!m) throw new Error(`{{${expr}}}: use rand:MIN-MAX, for example rand:1-100`);
          const lo = +m[1], hi = +m[2]; return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
        }
        case "pick": { const c = arg.split("|"); if (!arg) throw new Error(`{{${expr}}}: use pick:a|b|c`); return c[Math.floor(Math.random() * c.length)]; }
        case "var": { const v = ctx.vars && ctx.vars[arg]; if (v === undefined) throw new Error(`{{${expr}}}: variable "${arg}" is not defined`); return String(v); }
        case "in": {
          if (!ctx.fields) throw new Error(`{{${expr}}}: there is no incoming message to read from`);
          const want = arg.replace(/\[\d+\]/g, "").toLowerCase();
          for (const [p, v] of ctx.fields) { const q = p.replace(/\[\d+\]/g, "").toLowerCase(); if (q === want || q.endsWith("." + want)) return String(v); }
          throw new Error(`{{${expr}}}: the incoming message has no field "${arg}"`);
        }
        default: throw new Error(`Unknown variable {{${expr}}}. Known: uuid, now, epoch, epochMs, counter, rand:A-B, pick:a|b, var:name, in:Path, topic.`);
      }
    });
  };
  /* Throws the first template problem without needing real input (unknown names, bad arguments, undefined variables). */
  lib.templateCheck = (text, { vars = {}, hasIncoming = false } = {}) => {
    for (const expr of lib.templateVars(text)) {
      const [name, ...rest] = expr.split(":"), arg = rest.join(":");
      if (["uuid", "now", "epoch", "epochMs", "counter", "topic", "subject"].includes(name)) continue;
      if (name === "rand") { if (!/^-?\d+\s*-\s*-?\d+$/.test(arg)) throw new Error(`{{${expr}}}: use rand:MIN-MAX, for example rand:1-100`); }
      else if (name === "pick") { if (!arg) throw new Error(`{{${expr}}}: use pick:a|b|c`); }
      else if (name === "var") { if (!(arg in vars)) throw new Error(`{{${expr}}}: variable "${arg}" is not defined`); }
      else if (name === "in") { if (!hasIncoming) throw new Error(`{{${expr}}}: there is no incoming message to read from`); if (!arg) throw new Error(`{{${expr}}}: name a field, for example in:SystemID`); }
      else throw new Error(`Unknown variable {{${expr}}}.`);
    }
  };

  /* ---- scenarios ---- */
  lib.scenarioParse = function (json) {
    let o; try { o = JSON.parse(json); } catch (e) { throw new Error("Not valid JSON: " + e.message); }
    const steps = Array.isArray(o) ? o : o && o.steps;
    if (!Array.isArray(steps)) throw new Error("A scenario is a JSON array of steps, or { \"steps\": [...] }.");
    return { name: (o && o.name) || "", vars: (o && typeof o.vars === "object" && o.vars) || {}, steps: steps.map((s, i) => {
      if (!s || typeof s.topic !== "string" || !s.topic.trim()) throw new Error(`Step ${i + 1} needs a topic.`);
      if (typeof s.text !== "string") throw new Error(`Step ${i + 1} needs a text (the message).`);
      const delay = s.delay === undefined ? 0 : Number(s.delay);
      if (!(delay >= 0)) throw new Error(`Step ${i + 1}: delay must be 0 or more milliseconds.`);
      return { delay, topic: s.topic.trim(), text: s.text, note: typeof s.note === "string" ? s.note : "" };
    }) };
  };
  lib.scenarioStringify = sc => JSON.stringify({ name: sc.name || "", vars: sc.vars || {}, steps: sc.steps }, null, 2);

  /* Plays steps through send(topic, text, step). Resolves { sent, failed, rounds, stopped, lastError }. */
  lib.scenarioRun = async function (sc, send, { speed = 1, loop = false, isStopped, onStep, sleep = ms => new Promise(r => setTimeout(r, ms)), counter = 0 } = {}) {
    let sent = 0, failed = 0, rounds = 0, lastError = "", n = counter, stopped = false;
    do {
      for (let i = 0; i < sc.steps.length; i++) {
        if (isStopped && isStopped()) return { sent, failed, rounds, stopped: true, lastError };
        const st = sc.steps[i], wait = speed > 0 ? st.delay / speed : 0;
        if (wait > 0) await sleep(wait);
        if (isStopped && isStopped()) return { sent, failed, rounds, stopped: true, lastError };
        n++;
        try {
          const ctx = { counter: n, vars: sc.vars || {} };
          await send(lib.template(st.topic, ctx), lib.template(st.text, ctx), st);
          sent++;
        } catch (e) { failed++; lastError = e && e.message || String(e); }
        if (onStep) onStep({ i: i + 1, of: sc.steps.length, sent, failed, rounds, lastError });
      }
      rounds++;
      if (loop && !sc.steps.length) break;
    } while (loop && !(stopped = !!(isStopped && isStopped())));
    return { sent, failed, rounds, stopped, lastError };
  };

  /* ---- responders ---- */
  /* m: { topic, message, text }. First enabled rule whose topic pattern, message name and field query all match. */
  lib.responderFind = function (rules, m) {
    let fields = null;
    for (const r of rules) {
      if (r.enabled === false) continue;
      const mt = r.match || {};
      if (mt.topic && !lib.natsSubjectMatch(mt.topic, m.topic)) continue;
      if (mt.message && mt.message !== m.message) continue;
      if (mt.query) {
        const q = lib.fieldQuery(mt.query); if (!q.ok) continue;
        fields = fields || lib.payloadFields(m.text).fields;
        if (!q.test(fields, { raw: m.text, topic: m.topic })) continue;
      }
      return r;
    }
    return null;
  };
  /* -> { topic, text, delay } with the templates filled in from the incoming message. */
  lib.responderBuild = function (rule, m, { counter = 0, vars = {} } = {}) {
    const fields = lib.payloadFields(m.text).fields, ctx = { counter, vars, fields, topic: m.topic };
    const rp = rule.reply || {};
    return { topic: lib.template(rp.topic || "", ctx), text: lib.template(rp.text || "", ctx), delay: Math.max(0, Number(rp.delay) || 0) };
  };
})();
