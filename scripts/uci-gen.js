// Shared by the demo scripts: loads a UCI schema and builds schema-valid sample messages with live-looking values.
const fs = require("fs"), path = require("path");
const pick = a => a[Math.floor(Math.random() * a.length)];

/* The schema from UCI_SCHEMA_DIR, else the Downloads copy, else the small demo schema. -> { model, dir, names } */
function loadUciSchema(lib) {
  const dir = [process.env.UCI_SCHEMA_DIR, "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL"].filter(Boolean).find(d => fs.existsSync(d));
  const files = dir ? fs.readdirSync(dir).filter(f => /\.xsd$/i.test(f)).map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), "utf8") }))
    : [{ name: "nats-demo.xsd", text: fs.readFileSync(path.join(__dirname, "../tests/fixtures/nats-demo.xsd"), "utf8") }];
  const model = lib.xsdModel(files);
  const names = (dir ? ["SystemStatus", "SubsystemStatus", "EntityMetadata", "MissionPlan", "MissionPlanStatus", "ActivityPlan", "ActivityPlanStatus", "MissionPlanCommand", "MissionPlanCommandStatus", "PositionReport"] : ["StatusReport"]).filter(n => model.elements.has(n));
  return { model, dir, names };
}

const systems = [["alpha", "123e4567-e89b-12d3-a456-4266141740a1"], ["bravo", "123e4567-e89b-12d3-a456-4266141740b2"], ["charlie", "123e4567-e89b-12d3-a456-4266141740c3"]];

function createUciGenerator(lib, model) {
  const enumValues = typeName => { for (let t = model.types.get(typeName); t; t = t.base ? model.types.get(t.base) : null) if (t.facets && t.facets.enumeration) return t.facets.enumeration.map(e => e.value); return null; };
    /* A schema-valid sample with live-looking values; broken: true makes it fail validation (a bad enum value, or a missing header field). */
    function uciMessage(name, sysId, { broken = false } = {}) {
      const d = lib.uciDecode(model, lib.uciSample(model, name, { all: Math.random() < 0.25 }));
      const enumLeaves = [];
      const walk = (e, n) => {
        const kids = e.kids.filter(k => k.t === "el");
        if (!kids.length) {
          const tx = e.kids.find(k => k.t === "text"); if (!tx || !n) return;
          const old = tx.v.trim(), info = n.type ? lib.xsdSimpleInfo(model, n.type) : null, ens = n.type ? enumValues(n.type) : null;
          let v = old;
          if (/\/MessageHeader\/Mode$/.test(n.path)) v = "LIVE";
        else if (/\/(Latitude|Longitude)$/.test(n.path)) v = old;                  // positions stay as generated: random ones would scatter unrelated messages over the map
          else if (ens && ens.length) { v = pick(ens); enumLeaves.push(tx); }
          else if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(old)) v = /SystemID/.test(n.path) ? sysId : crypto.randomUUID();
          else if (info && info.builtin === "dateTime") v = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          else if (info && ["double", "float", "decimal"].includes(info.builtin) && isFinite(parseFloat(old))) { const x = parseFloat(old); v = String(+(x + (Math.random() - 0.5) * Math.max(1, Math.abs(x)) * 0.2).toFixed(4)); }
          else if (info && /int|long|short|byte/i.test(info.builtin) && isFinite(parseInt(old, 10))) v = String(parseInt(old, 10) + Math.floor(Math.random() * 5));
          if (v !== old && info && lib.xsdCheckValue(model, info, v)) v = old;      // keep only values the schema accepts
          tx.v = v; return;
        }
        kids.forEach((k, i) => walk(k, n && n.kids[i]));
      };
      walk(d.element, d.node);
      if (broken) {
        if (enumLeaves.length) pick(enumLeaves).v = "NOT_A_VALID_VALUE";
        else { const hdr = d.element.kids.find(k => k.t === "el" && /MessageHeader/.test(k.name)); if (hdr) hdr.kids = hdr.kids.filter(k => !(k.t === "el" && /Timestamp/.test(k.name))); }
      }
      return lib.xmlSerialize(d.tree);
    }
  /* A PositionReport (radians in, as UCI stores them) for one moving system: the same id in the header and the body. */
  function positionMessage(entityId, lat, lon, alt) {
    const d = lib.uciDecode(model, lib.uciSample(model, "PositionReport")), root = d.element;
    const find = (e, n) => e && e.kids.find(k => k.t === "el" && k.name.replace(/^[^:]+:/, "") === n);
    const set = (e, v) => { if (!e) return; const t = e.kids.find(k => k.t === "text"); if (t) t.v = String(v); else e.kids.push({ t: "text", v: String(v) }); };
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z"), hdr = find(root, "MessageHeader"), data = find(root, "MessageData"), pos = find(find(data, "InertialState"), "Position");
    set(find(find(hdr, "SystemID"), "UUID"), entityId); set(find(hdr, "Timestamp"), now); set(find(find(data, "SystemID"), "UUID"), entityId);
    set(find(pos, "Latitude"), lat.toFixed(6)); set(find(pos, "Longitude"), lon.toFixed(6)); set(find(pos, "Altitude"), Math.round(alt)); set(find(pos, "Timestamp"), now);
    return lib.xmlSerialize(d.tree);
  }
  return { uciMessage, positionMessage };
}

module.exports = { loadUciSchema, createUciGenerator, systems, pick };
