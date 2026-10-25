(function () {
  const lib = DT.lib;
  const R = 6371008.8;                                   // mean Earth radius (m)
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

  /* Parse one coordinate (decimal degrees, DM, DMS, hemisphere letters, compact DDMMSS, or "…rad"). Returns degrees. */
  lib.parseCoord = function (text, axis = "lat") {
    let s = String(text).trim();
    if (!s) throw new Error("empty");
    const limit = axis === "lat" ? 90 : 180, hem = /[NSEW]/i.exec(s);
    if (hem) {
      const h = hem[0].toUpperCase();
      if (axis === "lat" && !/[NS]/.test(h)) throw new Error("Latitude uses N or S.");
      if (axis === "lon" && !/[EW]/.test(h)) throw new Error("Longitude uses E or W.");
    }
    let neg = /^\s*-/.test(s) || (hem && /[SW]/i.test(hem[0]));
    if (/rad\s*$/i.test(s)) {
      const v = parseFloat(s); if (!isFinite(v)) throw new Error("Bad radian value.");
      const d = deg(v); if (Math.abs(d) > limit + 1e-9) throw new Error(`Out of range (±${limit}°).`); return d;
    }
    const nums = s.replace(/[NSEW]/gi, " ").match(/\d+(?:\.\d+)?|\.\d+/g);
    if (!nums) throw new Error("No number found.");
    let d;
    if (nums.length === 1) {
      const raw = nums[0];
      if (hem && !raw.includes(".") && /^\d{6,7}$/.test(raw)) {        // compact DDMMSS / DDDMMSS
        const dd = raw.length - 4; d = +raw.slice(0, dd) + +raw.slice(dd, dd + 2) / 60 + +raw.slice(dd + 2) / 3600;
      } else if (hem && /^\d{6,7}\.\d+$/.test(raw)) {
        const i = raw.indexOf("."), dd = i - 4; d = +raw.slice(0, dd) + +raw.slice(dd, dd + 2) / 60 + +raw.slice(dd + 2) / 3600;
      } else d = +raw;
    } else if (nums.length === 2) { if (+nums[1] >= 60) throw new Error("Minutes must be < 60."); d = +nums[0] + +nums[1] / 60; }
    else if (nums.length === 3) { if (+nums[1] >= 60 || +nums[2] >= 60) throw new Error("Minutes and seconds must be < 60."); d = +nums[0] + +nums[1] / 60 + +nums[2] / 3600; }
    else throw new Error("Too many parts; use D, D M or D M S.");
    if (d > limit + 1e-9) throw new Error(`Out of range (±${limit}°).`);
    return neg ? -d : d;
  };

  lib.formatCoord = function (d, axis) {
    const h = axis === "lat" ? (d < 0 ? "S" : "N") : (d < 0 ? "W" : "E"), a = Math.abs(d);
    const deg0 = Math.floor(a), minF = (a - deg0) * 60, min0 = Math.floor(minF), sec = (minF - min0) * 60;
    // round, then carry (59.9999 seconds must become 1 minute, not "60 seconds")
    let secR = +sec.toFixed(3), minR = min0, degR = deg0;
    if (secR >= 60) { secR = 0; minR++; }
    if (minR >= 60) { minR = 0; degR++; }
    let dmMin = +minF.toFixed(5), dmDeg = deg0;
    if (dmMin >= 60) { dmMin = 0; dmDeg++; }
    return {
      dd: d.toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0"),
      dm: `${dmDeg}° ${dmMin}′ ${h}`,
      dms: `${degR}° ${minR}′ ${secR}″ ${h}`,
      rad: rad(d).toFixed(10),
    };
  };

  lib.haversine = (la1, lo1, la2, lo2) => {
    const p1 = rad(la1), p2 = rad(la2), dp = p2 - p1, dl = rad(lo2 - lo1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  };
  lib.bearing = (la1, lo1, la2, lo2) => {
    const p1 = rad(la1), p2 = rad(la2), dl = rad(lo2 - lo1);
    return (deg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360;
  };
  lib.destination = (la, lo, brgDeg, distM) => {
    const d = distM / R, b = rad(brgDeg), p1 = rad(la), l1 = rad(lo);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
  };

  /* ---- Units: factors are to the category base unit ---- */
  const CATS = {
    length: { base: "m", units: { m: 1, km: 1000, nmi: 1852, mi: 1609.344, ft: 0.3048, yd: 0.9144, in: 0.0254, "FL (100 ft)": 30.48 } },
    speed: { base: "m/s", units: { "m/s": 1, kt: 1852 / 3600, "km/h": 1 / 3.6, mph: 0.44704, "ft/s": 0.3048, "ft/min": 0.00508 } },
    angle: { base: "rad", units: { rad: 1, deg: Math.PI / 180, mrad: 0.001, arcmin: Math.PI / 10800, arcsec: Math.PI / 648000, rev: 2 * Math.PI } },
    time: { base: "s", units: { s: 1, ms: 0.001, "µs": 1e-6, min: 60, h: 3600, day: 86400 } },
    pressure: { base: "Pa", units: { Pa: 1, hPa: 100, kPa: 1000, inHg: 3386.389, psi: 6894.757, atm: 101325, mmHg: 133.322368 } },
    temperature: { base: "K", units: { "°C": 0, "°F": 0, K: 0 } },
    mass: { base: "kg", units: { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.028349523125, t: 1000 } },
  };
  lib.unitCategories = CATS;
  lib.convertUnit = function (cat, value, from) {
    const c = CATS[cat]; if (!c || !(from in c.units)) throw new Error("Unknown unit.");
    const out = {};
    if (cat === "temperature") {
      const K = from === "°C" ? value + 273.15 : from === "°F" ? (value - 32) * 5 / 9 + 273.15 : value;
      return { "°C": K - 273.15, "°F": (K - 273.15) * 9 / 5 + 32, K };
    }
    const base = value * c.units[from];
    for (const [u, f] of Object.entries(c.units)) out[u] = base / f;
    return out;
  };

  const fmtNum = n => String(+n.toPrecision(8));

  DT.register({
    id: "geo", name: "Coordinates, Distance & Units", group: "XML & Mission Systems",
    desc: "Convert latitude / longitude between decimal degrees, degrees-minutes-seconds and radians, compute distance and bearing between points (WGS-84 sphere approximation), and convert aviation and SI units.",
    keywords: "latitude longitude dms radians haversine bearing distance nautical miles knots flight level fl meters feet geodetic wgs84 uci units",
    render(root) {
      root.innerHTML = `
        <div class="panel"><div class="lbl" style="margin-bottom:8px">Coordinate</div>
          <div class="opts"><label>Latitude <input type="text" id="lat" class="mono" value="34°03′08″N" style="width:200px"></label><label>Longitude <input type="text" id="lon" class="mono" value="118 14 37 W" style="width:200px"></label></div>
          <div class="hint">Accepts 34.05, -118.24, 34°03′08″N, 34 3.13 N, N34 03 08, 340308N / 1181437W, or 0.5942 rad.</div>
          <div class="status" id="cst"></div><div id="cout"></div></div>
        <div class="panel"><div class="lbl" style="margin-bottom:8px">Distance & bearing between two points</div>
          <div class="opts"><label>A <input type="text" id="alat" class="mono" placeholder="lat" value="34.0522" style="width:130px"><input type="text" id="alon" aria-label="Point A longitude" class="mono" placeholder="lon" value="-118.2437" style="width:130px"></label>
            <label>B <input type="text" id="blat" class="mono" placeholder="lat" value="36.1699" style="width:130px"><input type="text" id="blon" aria-label="Point B longitude" class="mono" placeholder="lon" value="-115.1398" style="width:130px"></label></div>
          <div class="status" id="dst"></div><div id="dout"></div>
          <div class="opts"><span class="lbl">Project from A</span><label>bearing° <input type="number" id="pb" value="45" step="any" style="width:90px"></label><label>distance <input type="number" id="pd" value="100" step="any" style="width:110px"></label><select id="pu" class="mono"><option>km</option><option>nmi</option><option>m</option><option>mi</option><option>ft</option></select></div>
          <div id="pout"></div></div>
        <div class="panel"><div class="lbl" style="margin-bottom:8px">Units</div>
          <div class="opts"><select id="cat" aria-label="Unit category" class="mono">${Object.keys(CATS).map(c => `<option>${c}</option>`).join("")}</select><input type="number" id="val" aria-label="Value to convert" value="250" step="any" class="mono" style="width:140px"><select id="from" aria-label="From unit" class="mono"></select></div>
          <div id="uout"></div></div>`;
      const $ = s => root.querySelector(s);
      function coord() {
        try {
          const la = lib.parseCoord($("#lat").value, "lat"), lo = lib.parseCoord($("#lon").value, "lon"), a = lib.formatCoord(la, "lat"), b = lib.formatCoord(lo, "lon");
          DT.status($("#cst"), "", "");
          $("#cout").innerHTML = DT.kv([["Decimal degrees", `${a.dd}, ${b.dd}`], ["Degrees + decimal minutes", `${a.dm}   ${b.dm}`], ["Degrees-minutes-seconds", `${a.dms}   ${b.dms}`], ["Radians", `${a.rad}, ${b.rad}`], ["Geo URI", `geo:${a.dd},${b.dd}`]]);
        } catch (e) { $("#cout").innerHTML = ""; DT.status($("#cst"), "err", e.message); }
      }
      function dist() {
        try {
          const g = (id, ax) => lib.parseCoord($("#" + id).value, ax), la1 = g("alat", "lat"), lo1 = g("alon", "lon"), la2 = g("blat", "lat"), lo2 = g("blon", "lon");
          const d = lib.haversine(la1, lo1, la2, lo2), b1 = lib.bearing(la1, lo1, la2, lo2), b2 = (lib.bearing(la2, lo2, la1, lo1) + 180) % 360;
          DT.status($("#dst"), "", "");
          $("#dout").innerHTML = DT.kv([["Distance", `${fmtNum(d / 1000)} km · ${fmtNum(d / 1852)} nmi · ${fmtNum(d / 1609.344)} mi · ${fmtNum(d)} m`], ["Initial bearing A→B", `${b1.toFixed(3)}° (${rad(b1).toFixed(6)} rad)`], ["Final bearing at B", `${b2.toFixed(3)}°`]]);
          const dd = +$("#pd").value * CATS.length.units[$("#pu").value], p = lib.destination(la1, lo1, +$("#pb").value, dd);
          $("#pout").innerHTML = DT.kv([["Destination", `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`]]);
        } catch (e) { $("#dout").innerHTML = ""; $("#pout").innerHTML = ""; DT.status($("#dst"), "err", e.message === "empty" ? "Fill in both points." : e.message); }
      }
      function units() {
        const c = $("#cat").value;
        if ($("#from").dataset.cat !== c) { $("#from").innerHTML = Object.keys(CATS[c].units).map(u => `<option>${DT.esc(u)}</option>`).join(""); $("#from").dataset.cat = c; }
        const v = parseFloat($("#val").value);
        if (!isFinite(v)) { $("#uout").innerHTML = ""; return; }
        $("#uout").innerHTML = DT.kv(Object.entries(lib.convertUnit(c, v, $("#from").value)).map(([u, x]) => [u, fmtNum(x)]));
      }
      ["lat", "lon"].forEach(i => $("#" + i).addEventListener("input", DT.debounce(coord, 150)));
      ["alat", "alon", "blat", "blon", "pb", "pd"].forEach(i => $("#" + i).addEventListener("input", DT.debounce(dist, 150))); $("#pu").onchange = dist;
      $("#cat").onchange = () => { units(); }; $("#val").addEventListener("input", units); $("#from").onchange = units;
      coord(); dist(); units();
    },
  });
})();
