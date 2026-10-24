(function () {
  const lib = DT.lib;

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const ALIASES = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };
  const SPEC = [
    { key: "second", min: 0, max: 59 },
    { key: "minute", min: 0, max: 59 },
    { key: "hour", min: 0, max: 23 },
    { key: "dom", label: "day of month", min: 1, max: 31 },
    { key: "month", min: 1, max: 12, names: MONTHS },
    { key: "dow", label: "day of week", min: 0, max: 7, names: DAYS },
  ];

  function parseField(text, spec) {
    const set = new Set();
    const val = t => {
      const l = t.toLowerCase();
      if (spec.names && l in spec.names) return spec.names[l];
      if (!/^\d+$/.test(t)) throw new Error(`"${t}" is not valid in the ${spec.label || spec.key} field`);
      return +t;
    };
    for (const part of text.split(",")) {
      if (!part) throw new Error(`Empty list item in ${spec.label || spec.key} field`);
      const [range, stepTxt] = part.split("/");
      const hasStep = stepTxt !== undefined, step = hasStep ? +stepTxt : 1;
      if (hasStep && (!/^\d+$/.test(stepTxt) || step < 1)) throw new Error(`Bad step "/${stepTxt}" in ${spec.label || spec.key} field`);
      let lo, hi;
      if (range === "*" || range === "?") { lo = spec.min; hi = spec.key === "dow" ? 6 : spec.max; }
      else if (range.includes("-")) { const [a, b] = range.split("-"); lo = val(a); hi = val(b); }
      else { lo = val(range); hi = hasStep ? (spec.key === "dow" ? 6 : spec.max) : lo; }
      if (lo < spec.min || hi > spec.max || lo > hi) throw new Error(`${spec.label || spec.key} value out of range (${spec.min}-${spec.max}): ${part}`);
      for (let v = lo; v <= hi; v += step) set.add(spec.key === "dow" && v === 7 ? 0 : v);
    }
    return { text, set: [...set].sort((a, b) => a - b), star: text[0] === "*" || text[0] === "?" };
  }

  /* Returns { fields: {second?, minute, hour, dom, month, dow}, hasSeconds }. Accepts 5 or 6 fields and @aliases. */
  lib.parseCron = function (expr) {
    let e = expr.trim().replace(/\s+/g, " ");
    if (!e) throw new Error("Enter a cron expression.");
    if (e.toLowerCase() === "@reboot") throw new Error("@reboot runs at startup and has no schedule.");
    if (ALIASES[e.toLowerCase()]) e = ALIASES[e.toLowerCase()];
    if (/[LW#]/.test(e.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)\b/gi, ""))) throw new Error("Quartz-only symbols (L, W, #) are not supported; use standard 5-field cron.");
    const parts = e.split(" ");
    if (parts.length !== 5 && parts.length !== 6) throw new Error(`Expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}.`);
    const hasSeconds = parts.length === 6;
    const specs = hasSeconds ? SPEC : SPEC.slice(1);
    const fields = {};
    specs.forEach((sp, i) => { fields[sp.key] = parseField(parts[i], sp); });
    if (!hasSeconds) fields.second = { text: "0", set: [0], star: false };
    return { fields, hasSeconds };
  };

  /* Next n run times after `from`. utc=true evaluates the schedule in UTC, else in local time. */
  lib.cronNext = function (expr, from = new Date(), n = 10, utc = false) {
    const { fields: f } = lib.parseCron(expr);
    const get = utc ? { y: d => d.getUTCFullYear(), m: d => d.getUTCMonth(), d: d => d.getUTCDate() } : { y: d => d.getFullYear(), m: d => d.getMonth(), d: d => d.getDate() };
    const mk = utc ? (y, m, d, H, M, S) => new Date(Date.UTC(y, m, d, H, M, S)) : (y, m, d, H, M, S) => new Date(y, m, d, H, M, S);
    const out = [];
    let day = mk(get.y(from), get.m(from), get.d(from), 0, 0, 0);
    for (let guard = 0; guard < 366 * 8 && out.length < n; guard++, day = mk(get.y(day), get.m(day), get.d(day) + 1, 0, 0, 0)) {
      const month = (utc ? day.getUTCMonth() : day.getMonth()) + 1;
      if (!f.month.set.includes(month)) continue;
      const dom = f.dom.set.includes(utc ? day.getUTCDate() : day.getDate()), dow = f.dow.set.includes(utc ? day.getUTCDay() : day.getDay());
      const ok = f.dom.star || f.dow.star ? dom && dow : dom || dow;
      if (!ok) continue;
      for (const H of f.hour.set) for (const M of f.minute.set) for (const S of f.second.set) {
        const t = mk(get.y(day), get.m(day), get.d(day), H, M, S);
        if (t > from) { out.push(t); if (out.length >= n) return out; }
      }
    }
    return out;
  };

  const list = (arr, fmt = x => x) => arr.length === 1 ? fmt(arr[0]) : arr.slice(0, -1).map(fmt).join(", ") + " and " + fmt(arr[arr.length - 1]);
  const isRange = (set) => set.length > 2 && set.every((v, i) => i === 0 || v === set[i - 1] + 1);
  const pad = n => String(n).padStart(2, "0");

  lib.cronDescribe = function (expr) {
    const { fields: f, hasSeconds } = lib.parseCron(expr);
    const step = (fld, spec) => { const m = /^(\*|\d+-\d+)\/(\d+)$/.exec(fld.text); return m ? +m[2] : 0; };
    const parts = [];
    const mins = f.minute, hrs = f.hour;
    if (hasSeconds && !(f.second.set.length === 1 && f.second.set[0] === 0)) parts.push(f.second.star ? "every second" : step(f.second) ? `every ${step(f.second)} seconds` : `at second ${list(f.second.set)}`);
    if (mins.star && hrs.star && !step(mins)) parts.push(hasSeconds ? "of every minute" : "every minute");
    else if (mins.set.length === 1 && hrs.set.length === 1 && !step(hrs)) parts.push(`at ${pad(hrs.set[0])}:${pad(mins.set[0])}`);
    else {
      parts.push(mins.star && !step(mins) ? "every minute" : step(mins) ? `every ${step(mins)} minutes` : isRange(mins.set) ? `every minute from ${mins.set[0]} through ${mins.set.at(-1)}` : `at minute ${list(mins.set)}`);
      parts.push(hrs.star && !step(hrs) ? "of every hour" : step(hrs) ? `of every ${step(hrs)}th hour` : isRange(hrs.set) ? `between ${pad(hrs.set[0])}:00 and ${pad(hrs.set.at(-1))}:59` : `past hour ${list(hrs.set)}`);
    }
    const domStr = f.dom.star ? "" : `on day ${list(f.dom.set)} of the month`;
    const dowStr = f.dow.star ? "" : isRange(f.dow.set) ? `${DAY_NAMES[f.dow.set[0]]} through ${DAY_NAMES[f.dow.set.at(-1)]}` : `on ${list(f.dow.set, d => DAY_NAMES[d])}`;
    if (domStr && dowStr) parts.push(`${domStr} or ${dowStr.startsWith("on ") ? dowStr : "on " + dowStr}`);
    else if (domStr) parts.push(domStr);
    else if (dowStr) parts.push(dowStr.startsWith("on ") ? dowStr : "on " + dowStr);
    if (!f.month.star) parts.push(`in ${list(f.month.set, m => MONTH_NAMES[m])}`);
    const s = parts.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  DT.register({
    id: "cron", name: "Cron Expression Explainer", group: "Time & Numbers",
    desc: "Translate a cron expression into plain English, see what each field expands to, and preview the next run times. Supports 5-field, 6-field (with seconds) and @aliases.",
    keywords: "crontab schedule scheduler job every minute kubernetes cronjob github actions",
    render(root) {
      root.innerHTML = `
        <div class="opts"><input type="text" id="in" class="mono" style="max-width:360px" value="*/15 9-17 * * 1-5" aria-label="Cron expression" spellcheck="false">
          <label>Evaluate in <select id="tz"><option value="local">Local time</option><option value="utc">UTC</option></select></label></div>
        <div class="chip-row" id="ex">${["* * * * *", "*/5 * * * *", "0 * * * *", "30 2 * * *", "0 9 * * 1-5", "0 0 1 * *", "0 0 * * 0", "15 14 1 * *", "0 22 * * 1-5", "@daily"].map(x => `<span class="chip" data-x="${x}">${x}</span>`).join("")}</div>
        <div class="status" id="st"></div>
        <div class="panel" id="desc" style="font-size:18px"></div>
        <div id="fields"></div>
        <div class="panel"><div class="lbl" style="margin-bottom:6px">Next runs</div><div id="next"></div></div>
        <p class="hint">Format: <code>minute hour day-of-month month day-of-week</code>. When both day-of-month and day-of-week are restricted, a run happens if either matches (standard cron behaviour). Day names (MON) and month names (JAN) work. GitHub Actions cron is UTC.</p>`;
      const $ = s => root.querySelector(s);
      function run() {
        const e = $("#in").value;
        try {
          const p = lib.parseCron(e);
          $("#desc").textContent = lib.cronDescribe(e);
          DT.status($("#st"), "ok", "Valid");
          const names = p.hasSeconds ? ["second", "minute", "hour", "day of month", "month", "day of week"] : ["minute", "hour", "day of month", "month", "day of week"];
          const keys = p.hasSeconds ? ["second", "minute", "hour", "dom", "month", "dow"] : ["minute", "hour", "dom", "month", "dow"];
          const raw = e.trim().startsWith("@") ? null : e.trim().split(/\s+/);
          $("#fields").innerHTML = `<table class="kv"><thead><tr><th>Field</th><th>Value</th><th>Runs on</th></tr></thead><tbody>${keys.map((k, i) => {
            const fl = p.fields[k], shown = fl.set.length > 24 ? fl.set.slice(0, 24).join(", ") + ` … (${fl.set.length} values)` : fl.set.join(", ");
            const label = k === "month" ? fl.set.map(m => MONTH_NAMES[m].slice(0, 3)).join(", ") : k === "dow" ? fl.set.map(d => DAY_NAMES[d].slice(0, 3)).join(", ") : shown;
            return `<tr><td class="k">${names[i]}</td><td class="v">${DT.esc(raw ? raw[i] : fl.text)}</td><td class="v">${DT.esc(label)}</td></tr>`;
          }).join("")}</tbody></table>`;
          const runs = lib.cronNext(e, new Date(), 10, $("#tz").value === "utc");
          $("#next").innerHTML = runs.length ? DT.kv(runs.map((d, i) => [`#${i + 1}`, $("#tz").value === "utc" ? d.toISOString().replace("T", " ").replace(".000Z", " UTC") : d.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: p.hasSeconds ? "2-digit" : undefined })])) : '<span class="hint">No run within the next 8 years.</span>';
        } catch (err) { $("#desc").textContent = ""; $("#fields").innerHTML = ""; $("#next").innerHTML = ""; DT.status($("#st"), "err", err.message); }
      }
      $("#in").addEventListener("input", DT.debounce(run, 120)); $("#tz").onchange = run;
      $("#ex").addEventListener("click", e => { const c = e.target.closest("[data-x]"); if (c) { $("#in").value = c.dataset.x; run(); } });
      run();
    },
  });
})();
