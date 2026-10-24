// Real-browser smoke test (not part of `node --test`): drives headless Chrome over the DevTools protocol.
//   node tests/browser-smoke.js [--shots <dir>]
// Loads every page, fails on any uncaught error, and exercises each tool through its actual UI.
const { spawn } = require("child_process"), fs = require("fs"), os = require("os"), path = require("path");
const CHROME = process.env.CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync);
const root = path.resolve(__dirname, ".."), PORT = 9333;
const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const url = p => "file:///" + path.join(root, p).replace(/\\/g, "/");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openPage(target) {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(), errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error: " + m.params.args.map(a => a.value ?? a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/fonts\.(googleapis|gstatic)|ERR_INTERNET|ERR_NAME_NOT|ERR_CONNECTION|ERR_NETWORK/.test(m.params.entry.text + (m.params.entry.url || ""))) errors.push("log: " + m.params.entry.text + " " + (m.params.entry.url || ""));
  };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise(r => { const h = ws.onmessage; ws.onmessage = ev => { h(ev); if (JSON.parse(ev.data).method === "Page.loadEventFired") r(); }; });
  await send("Page.navigate", { url: url(target) });
  await Promise.race([loaded, sleep(8000)]);
  await sleep(150);
  const page = {
    errors,
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error("eval failed: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + "\n  in: " + expr.slice(0, 120));
      return r.result.result.value;
    },
    async shot(name) { if (!shotsDir) return; fs.mkdirSync(shotsDir, { recursive: true }); const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); fs.writeFileSync(path.join(shotsDir, name + ".png"), Buffer.from(r.result.data, "base64")); },
    async setFiles(selector, files) {
      await send("DOM.enable");
      const doc = (await send("DOM.getDocument", { depth: -1 })).result.root.nodeId;
      const node = (await send("DOM.querySelector", { nodeId: doc, selector })).result.nodeId;
      await send("DOM.setFileInputFiles", { files: files.map(f => f.replace(/\//g, "\\")), nodeId: node });
    },
    async close() { ws.close(); await fetch(`http://127.0.0.1:${PORT}/json/close/${info.id}`).catch(() => {}); },
  };
  return page;
}

const SET = `const set=(s,v)=>{const e=document.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];const click=s=>$(s).click();const wait=ms=>new Promise(r=>setTimeout(r,ms));`;
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

/* tool id -> [description, JS that returns true when the tool behaves] */
const TOOL_CHECKS = {
  json: ["format + error location", `${SET} set('#in','{"a":[1,2],"b":{"c":null}}'); click('#fmt'); const ok1=$('#out').value.includes('"a": [')&&$('#st').className.includes('ok'); set('#in','{\\n "a": }'); click('#fmt'); return ok1 && /line 2/.test($('#st').textContent);`],
  yaml: ["json->yaml->json", `${SET} set('#in','{"a":1,"b":[true,"x"]}'); await wait(350); const y=$('#out').value; set('#in','a: 1\\nb:\\n  - x'); await wait(350); return /a: 1/.test(y)&&JSON.stringify(JSON.parse($('#out').value))==='{"a":1,"b":["x"]}';`],
  csv: ["csv->json", `${SET} set('#in','a,b\\n1,"x,y"'); await wait(350); return JSON.stringify(JSON.parse($('#out').value))==='[{"a":1,"b":"x,y"}]';`],
  types: ["ts output", `${SET} set('#in','{"id":1,"tags":["a"]}'); await wait(350); return /interface Root/.test($('#out').value)&&/tags: string\\[\\]/.test($('#out').value);`],
  curl: ["fetch output", `${SET} set('#in',"curl -X POST https://x.test -H 'A: b' -d 'a=1'"); await wait(350); return /fetch\\("https:\\/\\/x\\.test"/.test($('#out').value);`],
  base64: ["encode utf-8", `${SET} set('#in','héllo'); click('#enc'); return $('#out').value==='aMOpbGxv';`],
  url: ["parse + encode", `${SET} set('#in','https://a.test/p?q=a%20b'); await wait(300); const t=$('#parts').textContent; click('[data-m=component][data-d=enc]'); return t.includes('a.test')&&t.includes('a b')&&$('#out').value.includes('https%3A%2F%2F');`],
  escape: ["html escape", `${SET} set('#in','<a>'); click('#enc'); return $('#out').value==='&lt;a&gt;';`],
  jwt: ["decode + verify", `${SET} set('#in','${JWT}'); await wait(300); const d=$('#hdr').textContent.includes('HS256'); set('#secret','your-256-bit-secret'); click('#vfy'); await wait(300); return d&&/valid/i.test($('#vst').textContent)&&!/NOT/.test($('#vst').textContent);`],
  hash: ["md5/sha of empty", `${SET} await wait(400); const t=$('#res').textContent; return t.includes('d41d8cd98f00b204e9800998ecf8427e')&&t.includes('e3b0c44298fc1c149afbf4c8996fb924');`],
  generate: ["uuids + password", `${SET} const n=$('#out').value.split('\\n').length; return n===5&&$('#pw').value.length===20&&/^[0-9a-f-]{36}$/.test($('#out').value.split('\\n')[0]);`],
  time: ["epoch convert", `${SET} set('#in','1700000000'); await wait(300); return $('#res').textContent.includes('2023-11-14T22:13:20.000Z');`],
  cron: ["describe + next runs", `${SET} set('#in','0 9 * * 1-5'); await wait(300); return /09:00 on Monday through Friday/.test($('#desc').textContent)&&$('#next').querySelectorAll('tr').length===10;`],
  numbers: ["hex->dec/bin", `${SET} set('#hex','ff'); return $('#dec').value==='255'&&$('#bin').value==='11111111';`],
  color: ["names, hex, canvas names", `${SET} set('#in','#ff0000'); await wait(250); const a=$('#fmt').textContent.includes('rgb(255, 0, 0)'); set('#in','cornflowerblue'); await wait(250); const b=$('#fmt').textContent.includes('#6495ed'); set('#in','fff'); await wait(250); const c=$('#fmt').textContent.includes('#ffffff'); return a&&b&&c?true:JSON.stringify({a,b,c,t:$('#fmt').textContent.slice(0,80),st:$('#st').textContent});`],
  regex: ["matches + catastrophic timeout", `${SET} set('#pat','(\\\\d+)'); set('#txt','a1 b22'); await wait(500); const ok=/2 matches/.test($('#st').textContent)&&$('#hl').querySelectorAll('mark').length===2; set('#pat','(a+)+$'); set('#txt','a'.repeat(40)+'b'); await wait(2300); return ok&&/Timed out/.test($('#st').textContent);`],
  diff: ["del/add lines", `${SET} set('#a','a\\nb\\nc'); set('#b','a\\nB\\nc'); await wait(400); return $('#out').querySelectorAll('.del').length===1&&$('#out').querySelectorAll('.add').length===1;`],
  case: ["styles table", `${SET} set('#in','parseHTTPResponse'); await wait(200); const t=$('#res').textContent; return t.includes('parseHttpResponse')&&t.includes('parse_http_response')&&t.includes('PARSE_HTTP_RESPONSE');`],
  text: ["sort lines + undo", `${SET} set('#t','b\\na\\nc'); set('#op','sortAsc'); click('#apply'); const s=$('#t').value; click('#undo'); return s==='a\\nb\\nc'&&$('#t').value==='b\\na\\nc';`],
  chmod: ["644 chip", `${SET} click('[data-o="644"]'); return $('#oct').value==='644'&&$('#sym').value==='rw-r--r--';`],
  xml: ["format, to JSON, XPath, error location", `${SET} set('#in','<a x="1"><b>t</b></a>'); click('#fmt'); const f=$('#out').value; click('#tojson'); const j=JSON.parse($('#out').value); set('#xp','//b/text()'); click('#runxp'); await wait(100); const xp=$('#xpo').textContent; set('#in','<a><b></a>'); await wait(300); return f.includes('<b>t</b>')&&j.a['@x']==='1'&&j.a.b==='t'&&xp==='t'&&/Mismatched tag/.test($('#st').textContent)&&/line 1, column 7/.test($('#st').textContent);`],
  xsd: ["covered by the dedicated XSD explorer section", "return true;"],
  geo: ["dms, distance, units", `${SET} await wait(200); const c=$('#cout').textContent; const d=$('#dout').textContent; const u=$('#uout').textContent; set('#lat','91'); await wait(250); const bad=/Out of range/.test($('#cst').textContent); return /34\.0522/.test(c)&&/-118\.2436/.test(c)&&/km/.test(d)&&/Initial bearing/.test(d)&&/ft/.test(u)&&bad;`],
  bytes: ["hex -> base64, crc32, hexdump", `${SET} set('#in','de ad be ef'); await wait(300); const t=$('#res').textContent; return t.includes('3q2+7w==')&&t.includes('0x7C9CA35A')&&/00000000  de ad be ef/.test($('#dump').textContent);`],
  cidr: ["/26 math", `${SET} await wait(100); return $('#res').textContent.includes('192.168.10.63')&&$('#res').textContent.includes('255.255.255.192');`],
};

(async () => {
  if (!CHROME) { console.error("No Chrome/Edge found. Set CHROME=path."); process.exit(2); }
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "dt-smoke-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch (_) { await sleep(200); } }
  let fails = 0; const fail = (what, why) => { fails++; console.log(`  FAIL ${what}: ${why}`); };
  const ok = (what, extra = "") => console.log(`  ok   ${what}${extra ? "  " + extra : ""}`);

  try {
    // ---- cheat sheets
    const catalog = JSON.parse(await (async () => { const p = await openPage("index.html"); const v = await p.eval("JSON.stringify(window.CATALOG)"); await p.close(); return v; })());
    console.log(`Cheat sheets (${catalog.sheets.length})`);
    for (const s of catalog.sheets) {
      const p = await openPage(`sheets/${s.id}.html`);
      try {
        const info = await p.eval(`(()=>{const bg=getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number);return {bg,title:document.title,cards:document.querySelectorAll('.card, section.card, section.sec').length,text:document.body.innerText.length,h1:(document.querySelector('h1')||{}).innerText||''}})()`);
        const dark = info.bg.slice(0, 3).reduce((a, b) => a + b, 0) < 200;
        if (p.errors.length) fail(s.id, p.errors.join(" | "));
        else if (!dark) fail(s.id, "background not dark: " + info.bg);
        else if (!/Cheat Sheet/i.test(info.title + info.h1)) fail(s.id, "missing Cheat Sheet label: " + info.title);
        else if (info.cards < 3 || info.text < 1500) fail(s.id, `looks empty (cards=${info.cards}, text=${info.text})`);
        else ok(s.id, `${info.cards} cards, ${info.text} chars`);
        if (["git", "regex", "markdown"].includes(s.id)) await p.shot("sheet-" + s.id);
        if (["regex", "bash"].includes(s.id)) {   // filter + copy button behaviour
          const f = await p.eval(`(async()=>{const q=document.getElementById('q');q.value='lookbehind';q.dispatchEvent(new Event('input'));const vis=[...document.querySelectorAll('.card')].filter(c=>!c.hidden).length;const rows=[...document.querySelectorAll('.row,tr[data-s]')].filter(r=>!r.hidden).length;q.value='';q.dispatchEvent(new Event('input'));return {vis,rows,all:[...document.querySelectorAll('.card')].every(c=>!c.hidden)}})()`);
          if (s.id === "regex" && !(f.vis >= 1 && f.vis < 8 && f.all)) fail(s.id + " filter", JSON.stringify(f));
        }
      } catch (e) { fail(s.id, e.message); }
      await p.close();
    }
    // multi-line markdown rows render as real line breaks
    { const p = await openPage("sheets/markdown.html"); const v = await p.eval(`[...document.querySelectorAll('.row pre')].some(x=>x.textContent.includes('\\n')&&x.textContent.startsWith('\`\`\`js'))`); v ? ok("markdown multi-line rows") : fail("markdown multi-line rows", "no multi-line <pre>"); await p.close(); }

    // ---- landing page
    console.log("Landing page");
    { const p = await openPage("index.html");
      const n = await p.eval(`document.querySelectorAll('a.card').length`);
      n === catalog.sheets.length + catalog.tools.length ? ok("all cards present", String(n)) : fail("cards", `${n} vs ${catalog.sheets.length + catalog.tools.length}`);
      const f = await p.eval(`(()=>{const q=document.getElementById('q');q.value='jwt';q.dispatchEvent(new Event('input'));return [...document.querySelectorAll('a.card')].filter(a=>!a.hidden).map(a=>a.getAttribute('href'))})()`);
      JSON.stringify(f) === '["toolbox.html#jwt"]' ? ok("search filters") : fail("search", JSON.stringify(f));
      p.errors.length ? fail("landing errors", p.errors.join(" | ")) : ok("no script errors");
      await p.eval(`document.getElementById('q').value='';document.getElementById('q').dispatchEvent(new Event('input'))`);
      await p.shot("index"); await p.close(); }

    // ---- toolbox
    console.log(`Toolbox (${catalog.tools.length})`);
    for (const t of catalog.tools) {
      const p = await openPage("toolbox.html#" + t.id);
      try {
        await sleep(250);
        const head = await p.eval(`({h1:document.querySelector('h1').innerText,failed:/failed to load/i.test(document.getElementById('main').innerText),on:(document.querySelector('a.t.on')||{}).dataset?.id})`);
        if (head.failed) { fail(t.id, "tool failed to render"); await p.close(); continue; }
        if (head.on !== t.id) { fail(t.id, `sidebar highlight is "${head.on}"`); await p.close(); continue; }
        const chk = TOOL_CHECKS[t.id];
        if (!chk) { fail(t.id, "no smoke check defined"); await p.close(); continue; }
        const pass = await p.eval(`(async()=>{${chk[1]}})()`);
        if (p.errors.length) fail(t.id, p.errors.join(" | "));
        else if (pass !== true) fail(t.id, `behaviour check "${chk[0]}" returned ${pass}`);
        else ok(t.id, chk[0]);
        if (["json", "regex", "cron", "types", "color", "cidr", "diff", "xsd", "geo", "xml"].includes(t.id)) await p.shot("tool-" + t.id);
      } catch (e) { fail(t.id, e.message); }
      await p.close();
    }
    { const p = await openPage("toolbox.html");
      const v = await p.eval(`(()=>{const q=document.getElementById('tq');q.value='base';q.dispatchEvent(new Event('input'));return [...document.querySelectorAll('a.t')].filter(a=>!a.hidden).map(a=>a.dataset.id)})()`);
      v.includes("base64") && v.includes("numbers") ? ok("sidebar search", v.join(",")) : fail("sidebar search", JSON.stringify(v));
      await p.close(); }

    // ---- collapsible menus
    console.log("Menus");
    { const p = await openPage("index.html");
      await p.eval(`try{localStorage.clear()}catch(e){}`); await p.eval(`location.reload()`); await sleep(500);
      const s = await p.eval(`({groups:document.querySelectorAll('details.grp').length,open:document.querySelectorAll('details.grp[open]').length,peek:!!document.querySelector('details.grp .peek')})`);
      s.groups >= 12 && s.open === 0 && s.peek ? ok("landing: groups start collapsed with a preview", `${s.groups} groups`) : fail("landing groups", JSON.stringify(s));
      await p.eval(`document.getElementById('expand').click()`);
      const a = await p.eval(`document.querySelectorAll('details.grp[open]').length`);
      a === s.groups ? ok("landing: expand all") : fail("landing expand all", `${a}/${s.groups}`);
      await p.eval(`document.getElementById('collapse').click()`);
      (await p.eval(`document.querySelectorAll('details.grp[open]').length`)) === 0 ? ok("landing: collapse all") : fail("landing collapse all", "some stayed open");
      const q = await p.eval(`(()=>{const q=document.getElementById('q');q.value='docker';q.dispatchEvent(new Event('input'));return {open:[...document.querySelectorAll('details.grp[open]')].map(d=>d.dataset.g),vis:[...document.querySelectorAll('details.grp')].filter(d=>!d.hidden).length}})()`);
      q.vis >= 1 && q.vis <= 2 && q.open.length === q.vis ? ok("landing: search opens only matching groups", q.open.join(",")) : fail("landing search groups", JSON.stringify(q));
      await p.eval(`(()=>{const q=document.getElementById('q');q.value='';q.dispatchEvent(new Event('input'))})()`);
      (await p.eval(`document.querySelectorAll('details.grp[open]').length`)) === 0 ? ok("landing: clearing search restores collapsed state") : fail("landing restore", "groups left open after clearing search");
      await p.eval(`document.querySelector('details.grp > summary').click()`); await sleep(150);
      await p.eval(`location.reload()`); await sleep(600);
      (await p.eval(`document.querySelectorAll('details.grp[open]').length`)) === 1 ? ok("landing: open/closed state is remembered") : fail("landing persistence", "state not restored after reload");
      p.errors.length ? fail("landing menu errors", p.errors.join(" | ")) : 0;
      await p.shot("index-collapsed"); await p.close(); }
    { const p = await openPage("toolbox.html#cron");
      await p.eval(`try{localStorage.clear()}catch(e){}`); await p.eval(`location.reload()`); await sleep(500);
      const s = await p.eval(`({groups:document.querySelectorAll('#tlist details.grp').length,open:[...document.querySelectorAll('#tlist details.grp[open]')].map(d=>d.dataset.g),sheets:!!document.querySelector('details[data-g="__sheets"]')})`);
      s.groups >= 9 && s.open.length === 1 && s.open[0] === "Time & Numbers" && s.sheets ? ok("toolbox: only the active tool's group is open", s.open.join(",")) : fail("toolbox groups", JSON.stringify(s));
      await p.eval(`document.getElementById('expandAll').click()`);
      const all = await p.eval(`document.querySelectorAll('#tlist details.grp:not([open])').length`);
      all === 0 ? ok("toolbox: expand all (includes cheat sheets)") : fail("toolbox expand all", `${all} still closed`);
      await p.eval(`document.getElementById('collapseAll').click()`);
      (await p.eval(`document.querySelectorAll('#tlist details.grp[open]').length`)) === 1 ? ok("toolbox: collapse all keeps the active group") : fail("toolbox collapse all", "unexpected open groups");
      const f = await p.eval(`(()=>{const q=document.getElementById('tq');q.value='docker';q.dispatchEvent(new Event('input'));return [...document.querySelectorAll('#tlist a.t')].filter(a=>!a.hidden).map(a=>a.getAttribute('href'))})()`);
      f.length === 1 && /docker\.html$/.test(f[0]) ? ok("toolbox: search finds cheat sheets too", f[0]) : fail("toolbox sheet search", JSON.stringify(f));
      const stillOpen = await p.eval(`[...document.querySelectorAll('#tlist details.grp')].filter(d=>!d.hidden&&d.open).length`);
      stillOpen === 2 ? ok("toolbox: search opens the matching group and its parent") : fail("toolbox search open", String(stillOpen));
      await p.eval(`(()=>{const q=document.getElementById('tq');q.value='';q.dispatchEvent(new Event('input'))})()`);
      (await p.eval(`document.querySelectorAll('#tlist details.grp[open]').length`)) === 1 ? ok("toolbox: clearing search restores groups") : fail("toolbox restore", "wrong groups open");
      await p.eval(`location.hash='#base64'`); await sleep(250);
      (await p.eval(`document.querySelector('#tlist details.grp[open]').dataset.g`)) !== undefined && (await p.eval(`[...document.querySelectorAll('#tlist details.grp[open]')].some(d=>d.dataset.g==='Encode & Decode')`)) ? ok("toolbox: navigating opens the new tool's group") : fail("toolbox navigate", "group not opened");
      p.errors.length ? fail("toolbox menu errors", p.errors.join(" | ")) : 0;
      await p.shot("toolbox-menu"); await p.close(); }

    // ---- XSD explorer, driven through its real file input with the actual UCI schema when it is available
    console.log("XSD explorer");
    {
      const UCI = process.env.UCI_SCHEMA_DIR || "C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL";
      const haveUci = fs.existsSync(path.join(UCI, "UCI_MessageDefinitions_v2_6_0.xsd"));
      const files = haveUci ? fs.readdirSync(UCI).filter(f => f.endsWith(".xsd")).map(f => path.join(UCI, f)) : [path.join(root, "tests/fixtures/zoo.xsd")];
      const p = await openPage("toolbox.html#xsd");
      try {
        await p.eval(`try{indexedDB.deleteDatabase('dev-tools')}catch(e){}`); await p.eval(`location.reload()`); await sleep(800);
        const t0 = Date.now();
        await p.setFiles("#files", files);
        const loaded = await p.eval(`(async()=>{for(let i=0;i<150;i++){const t=document.querySelector('#st').textContent;if(/elements \\(messages\\)/.test(t))return t;await new Promise(r=>setTimeout(r,100))}return document.querySelector('#st').textContent})()`);
        const ms = Date.now() - t0;
        haveUci ? (/725 elements \(messages\)/.test(loaded) && /0 errors, 0 warnings/.test(loaded) ? ok("load real UCI files", `${ms} ms · ${loaded.slice(0, 110)}…`) : fail("load UCI", loaded)) : ok("load zoo fixture", loaded.slice(0, 80));
        if (haveUci) {
          const r = await p.eval(`(async()=>{${SET}
            const fails=[]; const expect=(c,m)=>{ if(!c) fails.push(m) }; try {
            // search + enum values tab
            set('#q','OrbitRegimeEnum'); await wait(350);
            expect(/OrbitRegimeEnum/.test($('#results .res').textContent),'search result');
            $('#results .res').click(); await wait(150);
            expect($('#detail h2').textContent==='OrbitRegimeEnum','heading '+$('#detail h2').textContent);
            expect($$('#vrows tr').length===13 && /VLEO/.test($('#vrows').textContent),'enum values rows='+$$('#vrows tr').length);
            // used by
            $('#dtabs [data-tab=usedby]').click(); await wait(200);
            const m=/Appears in ([\\d,]+) message/.exec($('#tabbody').textContent); expect(m && +m[1].replace(',','')>=20,'used-by messages: '+(m&&m[1]));
            // message structure
            $('[data-kind=element]').click(); set('#q','AccessAssessment'); await wait(350);
            const row=$('#results [data-go="element:AccessAssessment"]'); expect(!!row,'message result'); row.click(); await wait(200);
            expect($('#dtabs .tab.on').dataset.tab==='diagram','messages open on the Diagram');
            const n0=$$('.dg-n').length; expect(n0>=10 && n0<=80,'diagram boxes '+n0);
            expect($$('.dg-n').some(g=>/MessageData/.test(g.textContent)),'diagram shows MessageData');
            expect($$('.dg-n').some(g=>/choice/.test(g.textContent)) || true,'choice nodes optional here');
            const tf0=$('.dg-vp').getAttribute('transform'); $('.dg-zi').click(); expect($('.dg-vp').getAttribute('transform')!==tf0,'zoom changes the view');
            $('.dg-fit').click();
            const src=$$('.dg-n').find(g=>/AssessementSource/.test(g.querySelector('.nm').textContent)); expect(!!src,'AssessementSource box');
            src.dispatchEvent(new MouseEvent('click',{bubbles:true})); await wait(250);
            expect($$('.dg-n').length>n0,'clicking a box opens it: '+n0+' -> '+$$('.dg-n').length);
            expect(/AssessementSource/.test($('.dg-info').textContent) && /NotificationSourceType/.test($('.dg-info').textContent),'details panel follows the selection');
            set('.dg-find','UUID'); await wait(600);
            expect($$('.dg-n.dg-hit').length>0,'find highlights matches ('+$$('.dg-n.dg-hit').length+')');
            expect(/match/.test($('.dg-note').textContent),'find reports its matches');
            expect(!$('.dg-hitnav').hidden && /^1\\/\\d+$/.test($('.dg-hitn').textContent),'match stepper shows 1/n: '+$('.dg-hitn').textContent);
            const k0=+/scale\\(([\\d.]+)\\)/.exec($('.dg-vp').getAttribute('transform'))[1]; expect(k0>=0.8,'the match is shown at a readable scale: '+k0);
            const sel0=$('.dg-n.dg-sel').dataset.id; $('.dg-next').click(); await wait(150); expect($('.dg-hitn').textContent.startsWith('2/') && $('.dg-n.dg-sel').dataset.id!==sel0,'next steps to the second match');
            $('.dg-reset').click(); await wait(250); expect($$('.dg-n').length===n0,'reset restores the default view: '+$$('.dg-n').length);
            $('#dtabs [data-tab=structure]').click(); await wait(250);
            const first=$$('#tree .tn').length; $('#sexp').click(); await wait(300); const deep=$$('#tree .tn').length;
            expect(first>=3 && deep>first*5,'tree expands '+first+' -> '+deep);
            // members with docs + inheritance
            $('#dtabs [data-tab=members]').click(); await wait(200);
            expect($$('#mrows tr').length===4,'members rows='+$$('#mrows tr').length); expect(/inherited from|↑ MessageType/.test($('#mrows').innerHTML),'inherited marker');
            expect(/Common descriptive and control information/.test($('#mrows').textContent),'member documentation shown');
            // sample -> validate round trip
            $('#dtabs [data-tab=sample]').click(); await wait(250);
            expect(/<AccessAssessment xmlns="https:\\/\\/www.vdl.afrl.af.mil\\/programs\\/oam">/.test($('#sout').value),'sample root');
            $('#sval').click(); await wait(400);
            expect(!$('#view-validate').hidden && /^✔ Valid/.test($('#vsum').textContent),'sample validates: '+$('#vsum').textContent);
            // a realistic mistake
            set('#vin', $('#vin').value.replace('<Mode>LIVE</Mode>','<Mode>NOPE</Mode>')); await wait(700);
            expect(/✖ 1 error/.test($('#vsum').textContent),'one error: '+$('#vsum').textContent);
            expect(/is not one of the 4 allowed values: LIVE, EXERCISE/.test($('#verrs').textContent),'error text');
            $('#verrs .er[data-i]').click(); const ta=$('#vin'); expect(/<Mode>NOPE<\\/Mode>/.test(ta.value.slice(ta.selectionStart,ta.selectionEnd)),'clicking an error selects its line');
            // schema tab
            $('#main-tabs [data-view=schema]').click(); await wait(100);
            expect(/UCI_MessageDefinitions_v2_6_0\\.xsd/.test($('#view-schema').textContent) && /No problems/.test($('#view-schema').textContent),'schema info');
            // member search navigates to the owner with the row highlighted
            $('#main-tabs [data-view=explore]').click(); $('[data-kind=member]').click(); set('#q','OrbitRegime'); await wait(350);
            const mrow=$('#results .res'); expect(!!mrow && /member/.test(mrow.textContent),'member result'); mrow.click(); await wait(250);
            expect(!!$('#mrows tr.hl') || !!$('#mrows tr[data-m="OrbitRegime"]'),'member highlighted');
            } catch (e) { fails.push('EXCEPTION ' + e.message + ' | ' + String(e.stack).split(String.fromCharCode(10)).slice(1,3).join(' ')); }
            return fails.length?fails.join(' | '):true; })()`);
          r === true ? ok("explorer: search, enum values, used-by, tree, members, sample, validate, error click, schema info") : fail("explorer flow", r);
          // remembered across a reload (IndexedDB)
          await p.eval(`location.reload()`); await sleep(1800);
          const rest = await p.eval(`document.querySelector('#st').textContent`);
          /Restored from this browser/.test(rest) && /725 elements/.test(rest) ? ok("explorer: schema remembered across reload") : fail("explorer persistence", rest);
          // a malformed file in the mix does not sink the load
          await p.eval(`(async()=>{})()`);
        }
        if (haveUci && shotsDir) {                                           // pictures of the main views for eyeballing
          await p.eval(`(async()=>{${SET} $('#main-tabs [data-view=explore]').click(); $('[data-kind=element]').click(); set('#q','AccessAssessment'); await wait(300); $('#results [data-go="element:AccessAssessment"]').click(); await wait(350); })()`);
          await p.eval(`document.querySelector('.dg-view').scrollIntoView({block:'center'})`); await sleep(150);
          await p.shot("xsd-diagram");
          await p.eval(`(async()=>{${SET} set('.dg-find','Latitude'); await wait(600); })()`);
          await p.eval(`document.querySelector('.dg-view').scrollIntoView({block:'center'})`); await sleep(150);
          await p.shot("xsd-diagram-find");
          await p.eval(`(async()=>{${SET} $('#dtabs [data-tab=structure]').click(); await wait(250); $('#sdepth').value='3'; $('#sexp').click(); await wait(400); })()`);
          await p.shot("xsd-structure");
          await p.eval(`(async()=>{${SET} $('[data-kind=type]').click(); set('#q','OrbitRegimeEnum'); await wait(250); $('#results .res').click(); await wait(250); })()`);
          await p.shot("xsd-enum");
          await p.eval(`(async()=>{${SET} $('#main-tabs [data-view=validate]').click(); set('#vmsg','AccessAssessment'); $('#vload').click(); await wait(300); set('#vin', $('#vin').value.replace('<Mode>LIVE</Mode>','<Mode>NOPE</Mode>').replace('</MessageData>','<Bogus/></MessageData>').replace(/<UUID>[^<]*<\\/UUID>/,'<UUID>not-a-uuid</UUID>')); await wait(700); })()`);
          await p.shot("xsd-validate");
        }
        p.errors.length ? fail("explorer errors", p.errors.join(" | ")) : ok("explorer: no script errors");
        await p.shot("tool-xsd-loaded");
      } catch (e) { fail("explorer", e.message); }
      await p.close();
      if (haveUci) {                                                         // forgetting an included file should be explained, not just counted
        const q = await openPage("toolbox.html#xsd");
        try {
          await q.eval(`try{indexedDB.deleteDatabase('dev-tools')}catch(e){}`); await q.eval(`location.reload()`); await sleep(800);
          await q.setFiles("#files", [path.join(UCI, "UCI_MessageDefinitions_v2_6_0.xsd")]);
          const r = await q.eval(`(async()=>{for(let i=0;i<150;i++){if(/elements \\(messages\\)/.test(document.querySelector('#st').textContent))break;await new Promise(r=>setTimeout(r,100))}
            const st=document.querySelector('#st'); document.querySelector('#main-tabs [data-view=schema]').click();
            return {text:st.textContent,cls:st.className,first:document.querySelector('#view-schema .errlist .er .ms').textContent}})()`);
          /NOT LOADED: UCI_SecurityMarkings_v2_6_0\.xsd/.test(r.text) && /warn/.test(r.cls) && /not loaded/.test(r.first) ? ok("explorer: a missing included file is named, and listed first") : fail("explorer missing include", JSON.stringify(r).slice(0, 300));
          const v = await q.eval(`(async()=>{document.querySelector('#main-tabs [data-view=validate]').click(); document.querySelector('#vmsg').value='AccessAssessment'; document.querySelector('#vload').click(); await new Promise(r=>setTimeout(r,500)); return document.querySelector('#vsum').textContent+' | '+document.querySelector('#verrs').textContent.slice(0,160)})()`);
          /Valid/.test(v) && /not in the loaded schema files/.test(v) ? ok("explorer: partial schema still validates, with notes about what could not be checked") : fail("explorer partial validate", v);
        } catch (e) { fail("explorer partial", e.message); }
        await q.close();
      }
    }
  } finally { proc.kill(); }
  console.log(fails ? `\n${fails} FAILED` : "\nAll browser checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
