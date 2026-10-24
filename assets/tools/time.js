(function () {
  const lib = DT.lib;

  /* Accepts epoch seconds / ms / µs / ns, ISO 8601, RFC 2822, "now", or anything Date.parse understands. */
  lib.parseTimestamp = function (input) {
    const s = String(input).trim();
    if (!s || /^now$/i.test(s)) return { date: new Date(), unit: "now" };
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = parseFloat(s), a = Math.abs(n);
      const [mult, unit] = a < 1e11 ? [1000, "seconds"] : a < 1e14 ? [1, "milliseconds"] : a < 1e17 ? [1e-3, "microseconds"] : [1e-6, "nanoseconds"];
      return { date: new Date(n * mult), unit };
    }
    const d = new Date(s);
    if (isNaN(d)) throw new Error("Could not parse that as a timestamp or date.");
    return { date: d, unit: "date string" };
  };

  /* Format a Date in an IANA zone ("UTC", "America/Chicago") or the local zone (tz = ""). */
  lib.inZone = function (date, tz) {
    const opts = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" };
    if (tz) opts.timeZone = tz;
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", opts).formatToParts(date).map(x => [x.type, x.value]));
    let off = (p.timeZoneName || "GMT").replace("GMT", "") || "+00:00";
    if (off === "Z") off = "+00:00";
    return { text: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`, iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`, offset: off };
  };

  lib.isoWeek = function (date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return { week: Math.ceil(((d - y0) / 864e5 + 1) / 7), year: d.getUTCFullYear() };
  };

  lib.humanDuration = function (ms) {
    const neg = ms < 0; let s = Math.floor(Math.abs(ms) / 1000);
    const parts = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]].map(([u, v]) => { const c = Math.floor(s / v); s -= c * v; return c ? c + u : ""; }).filter(Boolean);
    return (neg ? "-" : "") + (parts.join(" ") || "0s");
  };

  const ZONES = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland"];

  DT.register({
    id: "time", name: "Timestamp Converter", group: "Time & Numbers",
    desc: "Convert Unix epoch (seconds, milliseconds, microseconds) and date strings to every common format and time zone, and measure the gap between two moments.",
    keywords: "epoch unix date iso 8601 timezone utc datetime difference",
    render(root) {
      const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      root.innerHTML = `
        <div class="panel"><span class="lbl">Now</span> <span class="mono" id="now"></span> <button class="mini" id="usenow" type="button">use now</button></div>
        <div class="opts">
          <input type="text" id="in" class="mono" style="max-width:380px" placeholder="1766000000, 1766000000000, 2026-10-24T14:30:00Z, now" aria-label="Timestamp or date">
          <label>Zone <select id="tz"><option value="">Local (${DT.esc(localTz)})</option>${ZONES.map(z => `<option>${z}</option>`).join("")}</select></label>
        </div>
        <div class="status" id="st"></div>
        <div id="res"></div>
        <div class="panel"><div class="lbl" style="margin-bottom:8px">Difference between two moments</div>
          <div class="opts"><input type="text" id="a" class="mono" placeholder="start (any format)" style="max-width:260px"><input type="text" id="b" class="mono" placeholder="end (blank = now)" style="max-width:260px"></div>
          <div id="diff" class="mono"></div></div>`;
      const $ = s => root.querySelector(s);
      const tick = () => { const n = Date.now(); $("#now").textContent = `${Math.floor(n / 1000)} s · ${n} ms`; };
      tick(); const iv = setInterval(() => { if (!document.body.contains(root)) return clearInterval(iv); tick(); }, 1000);
      function convert() {
        const v = $("#in").value;
        if (!v.trim()) { $("#res").innerHTML = ""; DT.status($("#st"), "", ""); return; }
        try {
          const { date, unit } = lib.parseTimestamp(v), tz = $("#tz").value;
          const z = lib.inZone(date, tz), loc = lib.inZone(date, ""), utc = lib.inZone(date, "UTC"), wk = lib.isoWeek(date);
          const dayOfYear = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5);
          DT.status($("#st"), "ok", `Interpreted as ${unit}`);
          $("#res").innerHTML = DT.kv([
            ["Unix seconds", String(Math.floor(date.getTime() / 1000))],
            ["Unix milliseconds", String(date.getTime())],
            ["ISO 8601 (UTC)", date.toISOString()],
            [`ISO 8601 (${tz || "local"})`, z.iso],
            ["Readable (" + (tz || "local") + ")", `${z.text} ${z.offset}`],
            ["Local time", `${loc.text} ${loc.offset}`],
            ["UTC time", utc.text],
            ["RFC 2822 / HTTP date", date.toUTCString()],
            ["Relative", lib.relTime ? lib.relTime(date.getTime() - Date.now()) : ""],
            ["Day / week", `${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz || undefined }).format(date)} · day ${dayOfYear} · ISO week ${wk.year}-W${String(wk.week).padStart(2, "0")}`],
          ]);
        } catch (e) { $("#res").innerHTML = ""; DT.status($("#st"), "err", e.message); }
      }
      function diff() {
        const a = $("#a").value, b = $("#b").value;
        if (!a.trim()) { $("#diff").textContent = ""; return; }
        try {
          const A = lib.parseTimestamp(a).date, B = lib.parseTimestamp(b || "now").date, ms = B - A;
          $("#diff").textContent = `${lib.humanDuration(ms)}  ·  ${(ms / 864e5).toFixed(3)} days  ·  ${(ms / 36e5).toFixed(2)} hours  ·  ${Math.round(ms / 1000).toLocaleString()} seconds`;
        } catch (e) { $("#diff").textContent = e.message; }
      }
      $("#in").addEventListener("input", DT.debounce(convert, 150));
      $("#tz").onchange = convert;
      $("#usenow").onclick = () => { $("#in").value = String(Math.floor(Date.now() / 1000)); convert(); };
      $("#a").addEventListener("input", DT.debounce(diff, 150)); $("#b").addEventListener("input", DT.debounce(diff, 150));
      $("#in").value = String(Math.floor(Date.now() / 1000)); convert();
    },
  });
})();
