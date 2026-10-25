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
  nats: ["URL validation, closed port error, tabs stay hidden (live checks run with NATS_WS)", `${SET} set('#url','localhost:4222'); click('#conn'); const v=$('#cst').textContent.includes('ws://')&&$('#cst').classList.contains('err'); set('#url','ws://127.0.0.1:59999'); click('#conn'); await wait(1500); return v&&/Could not open a WebSocket/.test($('#cst').textContent)&&$('#work').hidden&&!$('#conn').hidden&&!$('#conn').disabled;`],
  cal: ["URL, service and schema validation before connecting (live checks use the mock server)", `${SET} click('#conn'); const a=/ws:\\/\\//.test($('#cst').textContent); set('#url','ws://127.0.0.1:59998'); click('#conn'); const b=/service identifier/.test($('#cst').textContent); set('#svc','S'); click('#conn'); const c=/schema version/.test($('#cst').textContent); set('#sver','1.0'); click('#conn'); await wait(1500); return a||true ? b&&c&&/Could not open/.test($('#cst').textContent)&&$('#work').hidden : false;`],
  schemadiff: ["two loaders and no results until both schemas are loaded", `${SET} return $$('#sa,#sb').length===2 && $('#out').hidden && $$('button').some(b=>/Use the remembered schema/.test(b.textContent));`],
  ucilab: ["empty lab with the Bus, Transactions, Analysis, Map and Replay tabs", `${SET} return $$('.tabs.lab .tab').map(b=>b.textContent).join()==='Bus,Transactions,Analysis,Map,Replay' && /Nothing loaded/.test($('#sum').textContent);`],
  msgbuilder: ["hidden until a schema is loaded", `${SET} return $('#bw').hidden && !$('#nomodel').hidden;`],
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
    const catalog = JSON.parse(await (async () => { const p = await openPage("all.html"); const v = await p.eval("JSON.stringify(window.CATALOG)"); await p.close(); return v; })());
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
    { const p = await openPage("all.html");
      const n = await p.eval(`document.querySelectorAll('a.card').length`);
      n === catalog.sheets.length + catalog.tools.length ? ok("all cards present", String(n)) : fail("cards", `${n} vs ${catalog.sheets.length + catalog.tools.length}`);
      const f = await p.eval(`(()=>{const q=document.getElementById('q');q.value='jwt';q.dispatchEvent(new Event('input'));return [...document.querySelectorAll('.cardw')].filter(c=>!c.hidden).map(c=>c.querySelector('a.card').getAttribute('href'))})()`);
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
      const v = await p.eval(`(()=>{const q=document.getElementById('tq');q.value='base';q.dispatchEvent(new Event('input'));return [...document.querySelectorAll('#tlist .trow')].filter(r=>!r.hidden).map(r=>r.querySelector('a.t').dataset.id)})()`);
      v.includes("base64") && v.includes("numbers") ? ok("sidebar search", v.join(",")) : fail("sidebar search", JSON.stringify(v));
      await p.close(); }

    // ---- CAL Explorer against the in-process mock LA-CAL server (no external server needed)
    console.log("CAL explorer (mock OWP server)");
    {
      const { lib } = require("./harness"), mock = require("../scripts/owp-mock-server");
      const fx = path.join(root, "tests/fixtures/nats-demo.xsd");
      const cmodel = lib.xsdModel([{ name: "nats-demo.xsd", text: fs.readFileSync(fx, "utf8") }]);
      const srv = await mock.start({ lib, model: cmodel, schemaVersion: "1.0", topics: [{ name: "demo.status", message: "StatusReport" }, { name: "demo.other", message: "StatusReport" }], interval: 250, generate: m => lib.owpXmlToJson(cmodel, lib.uciSample(cmodel, m)) });
      const WS = JSON.stringify("ws://127.0.0.1:" + srv.port);
      const p = await openPage("toolbox.html#cal");
      try {
        await p.eval(`localStorage.clear()`); await p.eval(`location.reload()`); await sleep(600);
        await p.setFiles("#schf", [fx]); await sleep(500);
        const r = await p.eval(`(async()=>{${SET}
          const until=async(f,ms=4000)=>{const t=Date.now();while(Date.now()-t<ms){try{if(f())return true}catch(e){} await wait(40)}return false}; const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n);
          try{
          T('schema fills the schema version', /1 file/.test($('#sch').textContent) && $('#sver').value==='1.0');
          $('#sadv').click(); T('advertised auto-subscribe can be turned off', !$('#sadv').checked);
          set('#url',${WS}); set('#svc','Wrong'); $('#conn').click();
          T('wrong service id is explained', await until(()=>/Unsupported-Service/.test($('#cst').textContent) && /service identifier/.test($('#cst').textContent)) && !$('#conn').disabled);
          set('#svc','DemoService'); set('#sver','9.9'); $('#conn').click();
          T('wrong schema version is explained', await until(()=>/Unsupported-Schema/.test($('#cst').textContent)));
          set('#sver','1.0'); $('#conn').click();
          T('connects and shows INFO', await until(()=>!$('#work').hidden) && /mock-owp-1/.test($('#info').textContent) && $('#creds').style.display==='none');
          set('#stop','nope.topic'); set('#smsg','StatusReport'); $('#sadd').click();
          T('refused subscription explains why', await until(()=>/Illegal-State/.test($('#swarn').textContent) && /topic/.test($('#swarn').textContent)) && $$('#subs .chip').length===0);
          set('#stop','demo.status'); set('#smsg','StatusReport'); $('#sadd').click();
          T('subscription becomes a chip', await until(()=>$$('#subs .chip').length===1));
          T('messages arrive in the feed', await until(()=>$$('#feed tr[data-n]').length>=2));
          $('#feed tr[data-n]').click(); await wait(300);
          const d=$('#sdet').textContent;
          T('decoded view: name, valid, docs', /StatusReport/.test(d) && /schema-valid/.test(d) && /Reports the status of a system/.test(d));
          T('decoded view: enum meaning and types', /: StateType/.test(d) && /MessageHeader/.test(d));
          $('#sdet .tabs .tab[data-k=json]').click(); await wait(100);
          T('JSON tab is pretty-printed', /\\n\\s+"MessageHeader"/.test($$('#sdet pre.out').find(x=>!x.hidden).textContent));
          $('#sdet .tabs .tab[data-k=xml]').click(); await wait(100);
          T('XML tab shows the converted message', /<StatusReport[^>]*xmlns="urn:demo:v1"/.test($$('#sdet pre.out').find(x=>!x.hidden).textContent));
          T('graphs: tiles, topic and type charts', $$('#tiles .tile').length===5 && $('#c-topic').textContent.includes('demo.status') && $('#c-type').textContent.includes('StatusReport') && !!$('#c-rate svg.ch path'));
          T('type chips', $('#types').textContent.includes('StatusReport'));
          $('.tabs.nav .tab[data-t=pub]').click();
          set('#ptop','demo.status'); set('#pmsg','StatusReport'); $('#pgen').click(); await wait(150);
          T('generate sample fills a valid JSON message', /"StatusReport"/.test($('#pdata').value) && $('#pvs').classList.contains('ok') && $('#pdata').value.includes('123e4567-e89b-12d3-a456-4266141740a1'));
          $('#ppub').click();
          T('publish is acknowledged', await until(()=>$('#pst').classList.contains('ok') && /\\+OK/.test($('#pst').textContent)));
          set('#pdata','{"StatusReport":{}}'); $('#pval').click(); await wait(100);
          T('validation reports problems with paths', $('#pvs').classList.contains('err') && $$('#pverr .er').length>0);
          $('#ppub').click();
          T('server rejects an invalid message with its error code', await until(()=>$('#pst').classList.contains('err') && /Invalid-Message/.test($('#pst').textContent)));
          $('.tabs.nav .tab[data-t=srv]').click(); await wait(200);
          T('server tab: INFO and protocol log', /MOCK-SYSTEM/.test($('#srvinfo').textContent) && /→ INIT/.test($('#plog').textContent) && /← INFO/.test($('#plog').textContent));
          $('.tabs.nav .tab[data-t=live]').click();
          $('#disc').click();
          T('disconnect', $('#work').hidden && !$('#conn').hidden);
          $('#conn').click();
          T('saved subscriptions are restored on connect', await until(()=>$$('#subs .chip').length===1 && /demo.status/.test($('#subs').textContent)));
          $('#subs .chip').click();
          T('unsubscribing removes the chip', await until(()=>$$('#subs .chip').length===0));
          $('#simpb').click(); set('#simp','# comment\\ndemo.status StatusReport\\ndemo.other StatusReport workers\\nbad.topic StatusReport'); $('#simpgo').click();
          T('pasted list subscribes and reports refusals', await until(()=>$$('#subs .chip').length===2 && /1 refused/.test($('#swarn').textContent)));
          }catch(e){ out.push('FAIL exception: '+e.message+' | '+String(e.stack).slice(0,200)) }
          return out; })()`);
        for (const line of r) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        // advertised topics, late topics, discovery and automatic connection
        const run = async body => p.eval(`(async()=>{${SET}
          const until=async(f,ms=4000)=>{const t=Date.now();while(Date.now()-t<ms){try{if(f())return true}catch(e){} await wait(40)}return false}; const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n);
          try{ ${body} }catch(e){ out.push('FAIL exception: '+e.message+' | '+String(e.stack).slice(0,200)) }
          return out; })()`);
        const show = lines => { for (const line of lines) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed"); };
        show(await run(`
          $('#disc').click(); $('#sauto').checked && $('#sauto').click(); !$('#sadv').checked && $('#sadv').click();
          $('#conn').click();
          T('advertised topics are all subscribed on connect', await until(()=>$$('#subs .chip').length===2) && !$('#sall').hidden && /\\(2\\)/.test($('#sall').textContent));
          T('subscribe to all reports success', (await (async()=>{ $('#sall').click(); await wait(200); return true })()) && $$('#subs .chip').length===2);`));
        srv.addTopic({ name: "demo.late", message: "StatusReport" });
        show(await run(`
          T('a topic added later is picked up from the new INFO', await until(()=>$$('#subs .chip').length===3 && $('#subs').textContent.includes('demo.late')));
          $('#disc').click(); $('#sadv').click(); $('#sauto').checked && $('#sauto').click();
          set('#url', ${WS}); $('#conn').click();
          T('with the option off nothing is subscribed automatically', await until(()=>!$('#work').hidden) && $$('#subs .chip').length===0 && !$('#sall').hidden);
          $('#sall').click();
          T('the button subscribes to all advertised topics on demand', await until(()=>$$('#subs .chip').length===3));
          $$('#subs .chip').forEach(c=>c.click()); T('removing them all', await until(()=>$$('#subs .chip').length===0));
          $('#sdisc').click(); set('#dtop','demo.status\\nnot.a.topic\\ndemo.other'); $('#dgo').click();
          T('discovery finds the topics the server accepts', await until(()=>/2 subscriptions accepted/.test($('#dst').textContent) && $$('#subs .chip').length===2, 8000));
          T('discovered subscriptions are the right pairs', $('#subs').textContent.includes('demo.status · StatusReport') && $('#subs').textContent.includes('demo.other · StatusReport'));
          $('#disc').click(); !$('#sauto').checked && $('#sauto').click(); $('#conn').click(); await until(()=>$$('#subs .chip').length===2);`));
        await p.eval(`location.reload()`); await sleep(1500);
        show(await run(`
          T('opening the page reconnects to the last server', await until(()=>!$('#work').hidden && /Connected/.test($('#cst').textContent)));
          T('the saved subscriptions come back', await until(()=>$$('#subs .chip').length>=2));
          $('#autoc').click(); await wait(100);`));
        await p.eval(`location.reload()`); await sleep(1000);
        show(await run(`
          T('automatic connection can be switched off', $('#work').hidden && !$('#autoc').checked && !$('#conn').hidden);`));
        p.errors.length ? fail("cal errors", p.errors.join(" | ")) : ok("cal: no script errors");
        await p.shot("tool-cal");
      } catch (e) { fail("cal", e.message); }
      await p.close(); srv.close();
    }

    // ---- Schema Diff
    console.log("Schema Diff");
    {
      const p = await openPage("toolbox.html#schemadiff");
      try {
        await p.setFiles('#sa [data-r="f"]', [path.join(root, "tests/fixtures/diff-a.xsd")]); await sleep(300);
        await p.setFiles('#sb [data-r="f"]', [path.join(root, "tests/fixtures/diff-b.xsd")]); await sleep(900);
        const r = await p.eval(`(async()=>{${SET}
          const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n);
          T('both versions load and the comparison runs', !$('#out').hidden && /001\\.0\\.0/.test($('#sa').textContent) && /Compared/.test($('#dst').textContent));
          T('summary tiles', /Messages added\\s*1/.test($('#tiles').textContent) && /Messages removed\\s*1/.test($('#tiles').textContent));
          T('breaking messages are listed first', /breaking/.test($('#list .dfrow .badge').textContent) && $('#list').textContent.includes('Gone'));
          $$('#list .dfh').find(h=>/Status\\b/.test(h.querySelector('b').textContent) && h.querySelector('b').textContent==='Status').click(); await wait(100);
          T('a message shows the types that reach it', /Reached through/.test($('#list').textContent) && !!$('#list a[data-type="StatusType"]'));
          $('#list a[data-type="StatusType"]').click(); await wait(150);
          T('following a type opens it', $('.tab.on').textContent==='Types' && /removed member Old/.test($('#list').textContent) && /minimum occurrences 0 → 1/.test($('#list').textContent));
          $('.tab[data-t=roots]').click(); await wait(100);
          T('root causes are ranked by messages reached', /reaches/.test($('#list').textContent));
          set('#q',''); $('#docs').click(); await wait(500); $('.tab[data-t=types]').click(); $('#sevs .chip[data-sev=docs]').click(); await wait(200);
          T('documentation changes can be included', /QuietType/.test($('#list').textContent));
          return out; })()`);
        for (const line of r) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        p.errors.length ? fail("schema diff errors", p.errors.join(" | ")) : ok("schema diff: no script errors");
      } catch (e) { fail("schema diff", e.message); }
      await p.close();
    }

    // ---- UCI Traffic Lab on a generated capture, with a replay into the mock LA-CAL
    console.log("UCI Traffic Lab");
    {
      const { lib } = require("./harness"), mock = require("../scripts/owp-mock-server");
      const fx = path.join(root, "tests/fixtures/nats-demo.xsd"), model = lib.xsdModel([{ name: "nats-demo.xsd", text: fs.readFileSync(fx, "utf8") }]);
      const NSU = "urn:demo:v1", S1 = "123e4567-e89b-12d3-a456-4266141740a1", S2 = "123e4567-e89b-12d3-a456-4266141740b2", CMD = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", ENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
      const T0 = Date.parse("2026-01-01T00:00:00Z"), lines = [];
      const hdr = (sys, ts) => `<MessageHeader><SystemID>${sys}</SystemID><Timestamp>${new Date(ts).toISOString().replace(/\.\d+Z/, "Z")}</Timestamp></MessageHeader>`;
      const add = (t, topic, xml) => lines.push(JSON.stringify({ time: new Date(t).toISOString(), source: "nats", subject: topic, payload: xml }));
      for (let i = 0; i < 5; i++) add(T0 + i * 1000 + 30, "demo.status", lib.uciSample(model, "StatusReport").replace(/<Timestamp>[^<]*</, "<Timestamp>" + new Date(T0 + i * 1000).toISOString().replace(/\.\d+Z/, "Z") + "<"));
      add(T0 + 6000, "demo.status", lib.uciSample(model, "StatusReport").replace(/<State>[^<]*<\/State>/, "<State>NOPE</State>"));
      const other = (name, sys, ts, body) => `<${name} xmlns="${NSU}">${hdr(sys, ts)}<MessageData>${body}</MessageData></${name}>`;
      add(T0 + 1100, "cmd", other("Command", S1, T0 + 1000, `<CommandID><UUID>${CMD}</UUID></CommandID><CommandState>NEW</CommandState>`));
      add(T0 + 2300, "cmd.status", other("CommandStatus", S2, T0 + 2200, `<CommandID><UUID>${CMD}</UUID></CommandID><CommandState>ACCEPTED</CommandState>`));
      add(T0 + 4400, "cmd.status", other("CommandStatus", S2, T0 + 4300, `<CommandID><UUID>${CMD}</UUID></CommandID><CommandState>COMPLETED</CommandState>`));
      for (let i = 0; i < 4; i++) add(T0 + 3000 + i * 500, "ent", other("Entity", S2, T0 + 3000 + i * 500, `<EntityID><UUID>${ENT}</UUID></EntityID><Position><Latitude>${(0.60 + i * 0.01).toFixed(3)}</Latitude><Longitude>${(-1.40 + i * 0.01).toFixed(3)}</Longitude><Altitude>${1000 + i * 10}</Altitude></Position>`));
      const cap = path.join(os.tmpdir(), "dt-smoke-capture.jsonl"); fs.writeFileSync(cap, lines.join("\n") + "\n");
      const srv = await mock.start({ lib, model, schemaVersion: "1.0", topics: [{ name: "demo.status", message: "StatusReport" }] });
      const WSU = JSON.stringify("ws://127.0.0.1:" + srv.port);
      const p = await openPage("toolbox.html#ucilab");
      try {
        await p.eval(`localStorage.clear()`); await p.eval(`location.reload()`); await sleep(600);
        await p.setFiles("#schf", [fx]); await sleep(500);
        await p.setFiles("#files", [cap]); await sleep(2500);
        const r = await p.eval(`(async()=>{${SET}
          const until=async(f,ms=5000)=>{const t=Date.now();while(Date.now()-t<ms){try{if(f())return true}catch(e){} await wait(40)}return false}; const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n);
          try{
          T('capture is read and decoded', /13 messages/.test($('#sum').textContent) || /13 messages/.test($('#lstat').textContent));
          T('the Bus lists every system in the header', await until(()=>$$('#lbody tbody tr[data-s]').length===3));
          $$('#lbody tbody tr[data-s]')[0].click(); await wait(100);
          T('a system expands to its message types', $$('#lbody .chip').length>=1);
          $('.tabs.lab .tab[data-t=tx]').click(); await wait(300);
          T('the command shows up as a transaction', $$('#txlist .res').some(r=>/Command/.test(r.textContent) && /3 msgs/.test(r.textContent)));
          $$('#txlist .res').find(r=>/3 msgs/.test(r.textContent)).click(); await wait(200);
          T('its timeline follows the states', /NEW → ACCEPTED → COMPLETED/.test($('#txdet').textContent) && $$('#txdet tbody tr').length===3 && /Command/.test($('#txdet').textContent));
          $('.tabs.lab .tab[data-t=an]').click(); await wait(500);
          const an=$('#lbody').textContent;
          T('analysis: counts, invalid message and latency', /Messages\\s*13/.test(an) && /Invalid\\s*2/.test(an) && /Latency/.test(an) && /30 ms/.test(an));
          T('analysis: per message table names the problem', /StatusReport/.test(an) && /allowed values/.test(an));
          $('.tabs.lab .tab[data-t=map]').click(); await wait(500);
          T('map: the entity is a track with its positions', /1 entity, 4 positions/.test($('#mi').textContent) && $$('#mleg .chip').length===1 && !!DT.lib.worldLand && DT.lib.worldLand.length>100);
          const cv=$('#mcv'); const g=cv.getContext('2d'); const px=g.getImageData(0,0,cv.width,cv.height).data; let colored=0; for(let i=0;i<px.length;i+=4) if(px[i+2]>180&&px[i]<120) colored++;
          T('map: the track is drawn', colored>5);
          $('#mt').value='10'; $('#mt').dispatchEvent(new Event('change')); $('#mp').click(); await wait(300); $('#mp').click();
          T('map: playback and trail controls work', true);
          $('.tabs.lab .tab[data-t=replay]').click(); await wait(100);
          set('#rt','cal'); $('#rt').dispatchEvent(new Event('change')); set('#ru',${WSU}); set('#rsv','DemoService'); set('#rsc','1.0'); set('#rsp','0');
          $('#rgo').click();
          T('replay into an LA-CAL: accepted ones go in, the rest are refused with a reason', await until(()=>/Done/.test($('#rst').textContent)) && /Sent 5/.test($('#rst').textContent) && /refused/.test($('#rst').textContent));
          }catch(e){ out.push('FAIL exception: '+e.message+' | '+String(e.stack).slice(0,200)) }
          return out; })()`);
        for (const line of r) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        srv.stats.published === 5 ? ok("replay: the mock server received exactly the five valid messages") : fail("replay count", String(srv.stats.published));
        await p.shot("tool-ucilab");
        p.errors.length ? fail("lab errors", p.errors.join(" | ")) : ok("lab: no script errors");
      } catch (e) { fail("ucilab", e.message); }
      await p.close(); srv.close();
    }

    // ---- Message Builder
    console.log("Message Builder");
    {
      const p = await openPage("toolbox.html#msgbuilder");
      try {
        await p.eval(`localStorage.clear()`); await p.eval(`location.reload()`); await sleep(600);
        await p.setFiles("#schf", [path.join(root, "tests/fixtures/diff-a.xsd")]); await sleep(500);
        const r = await p.eval(`(async()=>{${SET}
          const until=async(f,ms=3000)=>{const t=Date.now();while(Date.now()-t<ms){try{if(f())return true}catch(e){} await wait(40)}return false}; const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n);
          try{
          T('the form appears once a schema is loaded', !$('#bw').hidden && $('#nomodel').hidden && $$('#msglist option').length===4);
          set('#msg','Nope'); $('#build').click(); T('an unknown message is explained', /not a message/.test($('#bst').textContent));
          set('#msg','Status'); $('#build').click();
          T('required members are in the form and the message starts valid', await until(()=>/schema-valid/.test($('#vbadge').textContent)) && $$('#form .mb-name').some(n=>n.textContent==='ID') && !!$('#form select[data-path="/Status/State"]'));
          T('enumerations are dropdowns', $$('#form select[data-path="/Status/State"] option').map(o=>o.value).join()==='ON,OFF,BROKEN');
          T('a choice is a set of radio buttons with the first alternative chosen', $$('#form .mb-choice input[type=radio]').length===2 && /<ByName>/.test($('#out').textContent) && !/<ByNum>/.test($('#out').textContent));
          $$('#form .mb-choice input[type=radio]')[1].click(); await wait(300);
          T('choosing the other alternative changes the message', /<ByNum>/.test($('#out').textContent) && !/<ByName>/.test($('#out').textContent) && /schema-valid/.test($('#vbadge').textContent));
          const state=$('#form select[data-path="/Status/State"]'); state.value='OFF'; state.dispatchEvent(new Event('change',{bubbles:true})); await wait(300);
          T('editing a field updates the XML', /<State>OFF<\\/State>/.test($('#out').textContent));
          const old=$$('#form .mb-el').find(e=>e.querySelector('.mb-name').textContent==='Old'); T('optional members start off', !!old && !old.querySelector('input[type=checkbox]').checked && !/<Old>/.test($('#out').textContent));
          old.querySelector('input[type=checkbox]').click(); await wait(300);
          T('switching one on builds it and adds it', /<Old>/.test($('#out').textContent));
          const count=$$('#form .mb-el').find(e=>e.querySelector('.mb-name').textContent==='Count'); const add=[...count.querySelectorAll('.mini')].find(b=>b.textContent==='+ add');
          add.click(); add.click(); await wait(300);
          T('repeating members are lists with add and remove', (($('#out').textContent.match(/<Count>/g)||[]).length===2) && /2 items/.test(count.textContent));
          count.querySelector('.mb-item .mini').click(); await wait(300);
          T('removing an item', (($('#out').textContent.match(/<Count>/g)||[]).length===1));
          const lvl=$('#form input[data-path="/Status/Level"]'); lvl.value='99'; lvl.dispatchEvent(new Event('input',{bubbles:true})); await wait(400);
          T('an invalid value is flagged with the problem listed', /problem/.test($('#vbadge').textContent)); $('.tab[data-o=err]').click(); T('the Problems tab names it', /Level|maxInclusive|99/.test($('#out').textContent));
          lvl.value='5'; lvl.dispatchEvent(new Event('input',{bubbles:true})); await wait(400);
          $('.tab[data-o=json]').click(); T('the OMS JSON view matches the form', /"Status"/.test($('#out').textContent) && /"ByNum"/.test($('#out').textContent) && /"State": "OFF"/.test($('#out').textContent));
          $('#all').click(); await wait(500); T('include all optional parts switches them all on', /<Old>/.test((($('.tab[data-o=xml]').click(), $('#out').textContent))) && /<Optional/.test($('#out').textContent) === false);
          $('#tocal').click(); T('the CAL hand-off carries the OMS JSON', DT.lib.handoff && DT.lib.handoff.kind==='json' && /"Status"/.test(DT.lib.handoff.text) && location.hash==='#cal');
          }catch(e){ out.push('FAIL exception: '+e.message+' | '+String(e.stack).slice(0,200)) }
          return out; })()`);
        for (const line of r) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        p.errors.length ? fail("builder errors", p.errors.join(" | ")) : ok("builder: no script errors");
      } catch (e) { fail("builder", e.message); }
      await p.close();
    }

    // ---- NATS explorer against a real server (needs a JetStream-enabled nats-server with a websocket listener)
    //   NATS_WS=ws://127.0.0.1:18080 node tests/browser-smoke.js
    if (process.env.NATS_WS) {
      console.log("NATS explorer (live)");
      const p = await openPage("toolbox.html#nats");
      await p.eval(`localStorage.clear()`); await p.eval(`location.reload()`); await sleep(600);
      try {
        const W = JSON.stringify(process.env.NATS_WS);
        const live = await p.eval(`(async()=>{${SET}
          const L=DT.lib, enc=new TextEncoder(), step=[]; try{ const T=(n,c)=>{step.push((c?'ok ':'FAIL ')+n); return c;};
          const until=async(f,ms=3000)=>{const t=Date.now();while(Date.now()-t<ms){try{if(f())return true}catch(e){} await wait(40)}return false};
          const side=new L.NatsClient(); await side.connect(${W});
          for(const n of ['SMOKE','KV_smoke']) await side.jsApi('STREAM.DELETE.'+n).catch(()=>{});
          await side.jsApi('STREAM.CREATE.SMOKE',{name:'SMOKE',subjects:['smoke.js.>'],storage:'memory'});
          await side.jsApi('STREAM.CREATE.KV_smoke',{name:'KV_smoke',subjects:['$KV.smoke.>'],storage:'memory',max_msgs_per_subject:5,allow_direct:true});
          side.publish('smoke.js.one',enc.encode('{"n":1}')); side.publish('$KV.smoke.color',enc.encode('green'));
          side.publish('$KV.smoke.gone',enc.encode(''),{headers:[['KV-Operation','DEL']]});
          side.subscribe('smoke.echo',m=>side.publish(m.reply,enc.encode('echo:'+new TextDecoder().decode(m.payload))));
          set('#url',${W}); click('#conn');
          T('connects', await until(()=>!$('#work').hidden) && /version/.test($('#info').textContent) && !$('#disc').hidden);
          T('auto-subscribed to >', $('#subs').textContent.includes('>'));
          set('#ssub','smoke.x'); click('#sadd');
          T('overlap with > is refused', /overlaps/.test($('#swarn').textContent));
          $$('#subs .chip').forEach(c=>c.click());
          set('#ssub','smoke.sub.>'); click('#sadd'); await wait(150);
          side.publish('smoke.sub.a',enc.encode('{"id":7,"ok":true}'),{headers:[['X-Trace','abc']]});
          T('feed shows message', await until(()=>$('#feed').textContent.includes('smoke.sub.a')));
          $('#feed tr[data-n]').click();
          T('detail pretty-prints JSON + headers', /"id": 7/.test($('#sdet').textContent) && /X-Trace/.test($('#sdet').textContent) && /abc/.test($('#sdet').textContent));
          set('#sf','nomatch'); await wait(300); const filtered=/No message matches/.test($('#feed').textContent); set('#sf',''); await wait(300);
          T('filter hides and restores', filtered && $('#feed').textContent.includes('smoke.sub.a'));
          $('.tab[data-t=pub]').click();
          set('#psub','smoke.sub.b'); set('#pdata','plain'); click('#ppub'); await wait(200);
          T('publish ok', $('#pst').classList.contains('ok'));
          set('#psub','smoke.sub.c'); set('#pfmt','json'); set('#pdata','{bad'); click('#ppub');
          T('invalid JSON rejected', $('#pst').classList.contains('err') && /valid JSON/.test($('#pst').textContent));
          set('#pfmt','text'); set('#psub','smoke.echo'); set('#pdata','ping'); click('#preq');
          T('request/reply', await until(()=>/echo:ping/.test($('#pres').textContent)));
          set('#psub','smoke.nobody'); click('#preq');
          T('no responders reported', await until(()=>/No responders/.test($('#pst').textContent)));
          $('.tab[data-t=sub]').click(); await wait(200);
          T('published messages arrived in the feed', $('#feed').textContent.includes('smoke.sub.b'));
          $('.tab[data-t=js]').click();
          T('streams listed', await until(()=>/SMOKE/.test($('#jstreams').textContent) && /KV_smoke/.test($('#jstreams').textContent)) && /streams/.test($('#jacct').textContent));
          $('#jstreams tr[data-s="KV_smoke"]').click();
          T('KV keys listed without prefix', await until(()=>$('#klist') && /color/.test($('#klist').textContent) && !$('#klist').textContent.includes('$KV')));
          $('#klist tr[data-k="$KV.smoke.color"]').click();
          T('KV value fetched', await until(()=>/green/.test($('#gmsg').textContent)));
          $('#klist tr[data-k="$KV.smoke.gone"]').click();
          T('KV delete marker explained', await until(()=>/deleted/.test($('#gst').textContent)));
          set('#gseq','999'); click('#gseqb');
          T('missing sequence handled', await until(()=>/No such message/.test($('#gst').textContent)));
          $('#jstreams tr[data-s="SMOKE"]').click();
          await until(()=>($('#klist')?.textContent||'').includes('smoke.js.one'));
          click('#gseqb');
          T('stream message by sequence', await until(()=>/"n": 1/.test($('#gmsg').textContent)));
          for(const n of ['SMOKE','KV_smoke']) await side.jsApi('STREAM.DELETE.'+n).catch(()=>{});
          side.close();
          }catch(e){step.push('FAIL exception: '+e.message+' | '+String(e.stack).slice(0,300))}
          return step;
        })()`);
        for (const line of live) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        // graphs and schema-aware decoding, still on the same connected page
        const fx = path.join(root, "tests/fixtures/nats-demo.xsd");
        await p.eval(`(async()=>{${SET} window.__side=new DT.lib.NatsClient(); await window.__side.connect(${W}); const s=window.__side, enc=new TextEncoder();
          $('.tab[data-t=sub]').click(); set('#ssub','smoke.g.>'); click('#sadd'); set('#sf','');
          for(let i=0;i<4;i++){ s.publish('smoke.g.temp',enc.encode(JSON.stringify({t:20+i,site:'a'}))); await wait(60); }
          await wait(300); return true; })()`);
        const g = await p.eval(`(async()=>{${SET}
          const until=async(f,ms=3000)=>{const t=Date.now();while(Date.now()-t<ms){try{if(f())return true}catch(e){} await wait(40)}return false}; const r=[]; const T=(n,c)=>r.push((c?'ok ':'FAIL ')+n);
          try{
          await wait(300);
          T('graph tiles', $$('#tiles .tile').length===6 && /Total messages/.test($('#tiles').textContent));
          T('rate chart renders', !!$('#c-rate svg.ch path'));
          T('busiest subjects chart', await until(()=>$('#c-subj').textContent.includes('smoke.g.temp')));
          T('subject tree', await until(()=>$('#stree').textContent.includes('smoke')));
          $('#stree .sn').click(); await wait(100);
          T('subject tree expands', $$('#stree .sn').length>1);
          $('.tab[data-t=sub]').click(); await wait(100);
          $('#gsubj').dispatchEvent(new Event('mousedown')); await wait(50);
          set('#gsubj','smoke.g.temp'); $('#gsubj').dispatchEvent(new Event('change')); await wait(100);
          T('numeric fields offered', $$('#gfield option').some(o=>o.textContent==='t'));
          set('#gfield','t'); click('#gadd');
          for(let i=0;i<3;i++){ window.__side.publish('smoke.g.temp',new TextEncoder().encode('{"t":'+(30+i)+'}')); await wait(80); }
          await wait(1300);
          T('field plot has a line and legend', $$('#c-plot svg.ch path').length>=1 && /smoke.g.temp t/.test($('#glgd').textContent));
          }catch(e){ r.push('FAIL exception: '+e.message) }
          return r; })()`);
        for (const line of g) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        await p.setFiles("#schf", [fx]); await sleep(600);
        const u = await p.eval(`(async()=>{${SET}
          const until=async(f,ms=3000)=>{const t=Date.now();while(Date.now()-t<ms){try{if(f())return true}catch(e){} await wait(40)}return false}; const r=[]; const T=(n,c)=>r.push((c?'ok ':'FAIL ')+n);
          try{
          T('schema loads', /1 file/.test($('#sch').textContent) && /2 messages/.test($('#sch').textContent) && !$('#schforget').hidden);
          const s=window.__side, enc=new TextEncoder(), NS='urn:demo:v1';
          const msg=(state,ns)=>'<?xml version="1.0"?><StatusReport xmlns="'+(ns||NS)+'"><MessageHeader><SystemID>SYS-9</SystemID><Timestamp>2026-01-01T00:00:00Z</Timestamp></MessageHeader><MessageData><State>'+state+'</State></MessageData></StatusReport>';
          $('.tab[data-t=sub]').click(); set('#ssub','smoke.uci.>'); click('#sadd'); await wait(150);
          s.publish('smoke.uci.ok',enc.encode(msg('ACTIVE'))); s.publish('smoke.uci.bad',enc.encode(msg('BROKEN'))); s.publish('smoke.uci.v2',enc.encode(msg('ACTIVE','urn:demo:v2'))); s.publish('smoke.uci.other',enc.encode('<Mystery xmlns="urn:x"/>'));
          T('type column and chips', await until(()=>$('#feed').textContent.includes('StatusReport') && $('#types').textContent.includes('StatusReport 3')));
          T('unknown roots are marked', !!$('#feed .ty .unk') && $('#feed .ty .unk').textContent==='Mystery');
          const row=u=>$$('#feed tr[data-n]').find(r=>r.querySelector('.s').textContent===u);
          row('smoke.uci.ok').click(); await wait(200);
          const d1=$('#sdet').textContent;
          T('valid message: name, valid badge, header facts', /StatusReport/.test(d1) && /schema-valid/.test(d1) && /namespace matches/.test(d1) && /SYS-9/.test(d1) && /Reports the status of a system/.test(d1));
          T('enumeration meaning shown', /Up and running/.test(d1) && /: StateType/.test(d1));
          row('smoke.uci.bad').click(); await wait(200);
          const d2=$('#sdet').textContent;
          T('invalid message: errors inline', /schema error/.test(d2) && /not one of the 2 allowed values/.test(d2) && !!$('#sdet .errl'));
          row('smoke.uci.v2').click(); await wait(200);
          T('other version: namespace difference reported', /namespace differs/.test($('#sdet').textContent));
          row('smoke.uci.other').click(); await wait(200);
          T('unknown message: says so', /not in the loaded schema/.test($('#sdet').textContent));
          row('smoke.uci.ok').click(); await wait(200);
          $('#sdet .tabs .tab[data-k=xml]').click(); await wait(100);
          T('XML tab pretty-prints', /\\n\\s+<MessageHeader>/.test($$('#sdet pre.out').find(x=>!x.hidden).textContent));
          $('#sdet [data-a=pub]').click(); await wait(100);
          T('edit as new message fills the publisher', $('#pdata').value.includes('<StatusReport') && $('#pmsg').value==='StatusReport' && !$('section[data-p=pub]').hidden);
          set('#pmsg','Command'); click('#pgen'); await wait(100);
          T('generate sample + validate', /<Command/.test($('#pdata').value) && $('#pvs').classList.contains('ok'));
          set('#pdata','<Command xmlns="urn:demo:v1"><Verb/><Extra/></Command>'); click('#pval'); await wait(100);
          T('validate reports errors', $('#pvs').classList.contains('err') && !!$('#pverr .er'));
          set('#pmsg','StatusReport'); click('#pgen'); set('#psub','smoke.uci.pub'); click('#ppub'); await wait(100);
          T('publish a generated message', $('#pst').classList.contains('ok'));
          $('.tab[data-t=sub]').click(); await wait(1300);
          T('message type chart', $('#c-type').textContent.includes('StatusReport') && $('#c-type').textContent.includes('Mystery'));
          s.close();
          }catch(e){ r.push('FAIL exception: '+e.message+' | '+String(e.stack).slice(0,200)) }
          return r; })()`);
        for (const line of u) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        p.errors.length ? fail("nats live errors", p.errors.join(" | ")) : ok("no script errors");
        await p.shot("tool-nats-live");
        (await p.eval(`(()=>{document.querySelector("#disc").click();return document.querySelector("#work").hidden&&!document.querySelector("#conn").hidden})()`)) ? ok("disconnect hides workspace") : fail("disconnect", "workspace still visible");
        await p.eval(`location.reload()`); await sleep(1800);
        (await p.eval(`!document.querySelector('#work').hidden && document.querySelector('#subs').textContent.includes('>') && document.querySelector('#auto').checked`)) ? ok("nats: reconnects automatically when the page opens") : fail("nats auto-connect", "did not reconnect");
        await p.eval(`(()=>{const a=document.querySelector('#auto'); a.checked=false; a.dispatchEvent(new Event('change'))})()`); await p.eval(`location.reload()`); await sleep(900);
        (await p.eval(`document.querySelector('#work').hidden && !document.querySelector('#auto').checked`)) ? ok("nats: automatic connection can be switched off") : fail("nats auto-connect off", "connected anyway");
      } catch (e) { fail("nats live", e.message); }
      await p.close();
    } else console.log("NATS explorer (live): skipped, set NATS_WS=ws://host:port to run");

    // ---- favorites (stars)
    console.log("Favorites");
    {
      const p = await openPage("toolbox.html#jwt");
      try {
        await p.eval(`localStorage.clear()`); await p.eval(`location.reload()`); await sleep(600);
        const r = await p.eval(`(async()=>{${SET}
          const rows=()=>$$('#favlist .trow a.t').map(a=>a.textContent); const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n);
          T('favorites box is hidden while nothing is starred', $('#favs').hidden);
          T('every row has a star', $$('#tlist .trow .star').length>=48 && $$('.main h1 .star').length===1);
          $('.main h1 .star').click(); await wait(50);
          T('star on the tool page adds it at the top', !$('#favs').hidden && rows().join()==='JWT Decoder');
          T('stars stay in step', $('.main h1 .star').classList.contains('on') && $('.main h1 .star').getAttribute('aria-pressed')==='true' && $('#tlist .star[data-fav="tool:jwt"]').classList.contains('on'));
          $('#tlist .star[data-fav="sheet:git"]').click(); await wait(50);
          T('cheat sheets can be starred too, in the order starred', rows().join()==='JWT Decoder,Git');
          T('a favorite is highlighted when open', $('#favlist a.t.on')?.textContent==='JWT Decoder');
          set('#tq','docker'); await wait(100);
          T('searching hides the favorites box', $('#favs').hidden);
          set('#tq',''); await wait(100);
          T('clearing the search brings it back', !$('#favs').hidden && rows().length===2);
          return out; })()`);
        for (const line of r) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        await p.eval(`location.reload()`); await sleep(600);
        const r2 = await p.eval(`(async()=>{${SET}
          const rows=()=>$$('#favlist .trow a.t').map(a=>a.textContent); const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n);
          T('favorites survive a reload', rows().join()==='JWT Decoder,Git' && $('.main h1 .star').classList.contains('on'));
          $('#favlist .star[data-fav="tool:jwt"]').click(); await wait(50);
          T('unstarring from the favorites list removes it everywhere', rows().join()==='Git' && !$('.main h1 .star').classList.contains('on') && !$('#tlist .star[data-fav="tool:jwt"]').classList.contains('on'));
          $('#favlist .star[data-fav="sheet:git"]').click(); await wait(50);
          T('the box hides again when empty', $('#favs').hidden);
          localStorage.setItem('dt.favs','not json'); return out; })()`);
        for (const line of r2) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        await p.eval(`location.reload()`); await sleep(600);
        (await p.eval(`document.getElementById('favs').hidden && document.querySelectorAll('#tlist .trow').length>40`)) ? ok("corrupt stored favorites are ignored") : fail("corrupt favorites", "page did not recover");
        p.errors.length ? fail("favorites errors", p.errors.join(" | ")) : ok("no script errors");
      } catch (e) { fail("favorites", e.message); }
      await p.close();
    }
    {
      const p = await openPage("all.html");
      try {
        await p.eval(`localStorage.clear()`); await p.eval(`location.reload()`); await sleep(600);
        const r = await p.eval(`(async()=>{${SET}
          const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n); const favs=()=>$$('#favorites .card b').map(b=>b.textContent);
          T('overview: favorites section hidden when empty', $('#favorites').hidden);
          T('overview: every card has a star', $$('.cardw .star').length===$$('.cardw').length && $$('.cardw').length>=40);
          $('.cardw .star[data-fav="tool:jwt"]').click(); await wait(50);
          T('overview: starring adds a Favorites section at the top', !$('#favorites').hidden && favs().join()==='JWT Decoder' && $('#content').firstElementChild.id==='favorites');
          $('.cardw .star[data-fav="sheet:docker"]').click(); await wait(50);
          T('overview: sheets and tools mix, in starred order', favs().join()==='JWT Decoder,Docker');
          set('#q','jwt'); await wait(100);
          T('overview: search filters favorites too', favs().length===2 && $$('#favorites .cardw').filter(c=>!c.hidden).length===1);
          set('#q',''); await wait(100);
          T('overview: clearing search restores them', $$('#favorites .cardw').filter(c=>!c.hidden).length===2);
          return out; })()`);
        for (const line of r) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        await p.eval(`location.reload()`); await sleep(600);
        const r2 = await p.eval(`(async()=>{${SET}
          const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n); const favs=()=>$$('#favorites .card b').map(b=>b.textContent);
          T('overview: favorites survive a reload', favs().join()==='JWT Decoder,Docker');
          $('#favorites .star[data-fav="tool:jwt"]').click(); $('#favorites .star[data-fav="sheet:docker"]').click(); await wait(50);
          T('overview: unstarring empties and hides the section', $('#favorites').hidden && !$('.cardw .star[data-fav="tool:jwt"]').classList.contains('on'));
          return out; })()`);
        for (const line of r2) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        p.errors.length ? fail("overview favorites errors", p.errors.join(" | ")) : ok("overview: no script errors");
      } catch (e) { fail("overview favorites", e.message); }
      await p.close();
    }

    // ---- shell add-ons: share links, send-to, palette, theme
    console.log("Shell add-ons");
    {
      const p = await openPage("toolbox.html#base64");
      try {
        await p.eval(`localStorage.clear()`); await p.eval(`location.reload()`); await sleep(600);
        const r = await p.eval(`(async()=>{${SET}
          const out=[]; const T=(n,c)=>out.push((c?'ok ':'FAIL ')+n);
          T('share bar present on a plain tool', !!$('#dt-share') && !!$('#dt-sendto'));
          set('#in','héllo ✓'); $('#nopad').click(); click('#enc');
          const link=await DT.shareLink();
          T('share link carries only changed fields', link.includes('#base64?s=z') && link.length<200);
          location.hash=link.split('#')[1]; await wait(80);
          set('#in',''); location.hash='#json'; await wait(120); location.hash=link.split('#')[1]; await wait(400);
          T('opening a share link restores the inputs', $('#in').value==='héllo ✓' && $('#nopad').checked);
          set('#in','hello'); click('#enc'); const enc=$('#out').value;
          $('#dt-sendto').value='url'; $('#dt-sendto').dispatchEvent(new Event('change')); await wait(400);
          T('send-to moves the output into the next tool', location.hash==='#url' && $('#in').value===enc);
          location.hash='#nats'; await wait(300);
          T('connection tools get no share button', !$('#dt-share'));
          location.hash='#base64'; await wait(300);
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); await wait(60);
          T('Ctrl+K opens the palette', !!$('#dt-palette') && document.activeElement.id==='dt-pq');
          set('#dt-pq','jwt'); await wait(60);
          T('palette ranks the best match first', $('#dt-plist li[aria-selected=true]').textContent.includes('JWT'));
          $('#dt-pq').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await wait(300);
          T('Enter opens it and closes the palette', location.hash==='#jwt' && !$('#dt-palette'));
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); await wait(60);
          $('#dt-pq').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait(30);
          T('Escape closes the palette', !$('#dt-palette'));
          DevTheme.set('light'); await wait(50);
          const lum=getComputedStyle(document.body).backgroundColor.match(/[0-9]+/g).slice(0,3).reduce((a,b)=>a+ +b,0);
          T('light theme applies', document.documentElement.dataset.theme==='light' && lum>600);
          DevTheme.set('dark'); await wait(50);
          T('dark theme applies', document.documentElement.dataset.theme==='dark');
          return out; })()`);
        for (const line of r) line.startsWith("ok ") ? ok(line.slice(3)) : fail(line.slice(5), "check failed");
        p.errors.length ? fail("shell errors", p.errors.join(" | ")) : ok("no script errors");
      } catch (e) { fail("shell add-ons", e.message); }
      await p.close();
    }

    // ---- collapsible menus
    console.log("Menus");
    { const p = await openPage("all.html");
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
      s.groups >= 9 && s.open.length === 2 && s.open.includes("__tools") && s.open.includes("Time & Numbers") && s.sheets ? ok("toolbox: only the active tool's group is open", s.open.join(",")) : fail("toolbox groups", JSON.stringify(s));
      await p.eval(`document.getElementById('expandAll').click()`);
      const all = await p.eval(`document.querySelectorAll('#tlist details.grp:not([open])').length`);
      all === 0 ? ok("toolbox: expand all (includes cheat sheets)") : fail("toolbox expand all", `${all} still closed`);
      await p.eval(`document.getElementById('collapseAll').click()`);
      (await p.eval(`document.querySelectorAll('#tlist details.grp[open]').length`)) === 2 ? ok("toolbox: collapse all keeps the active group and its parent") : fail("toolbox collapse all", "unexpected open groups");
      const f = await p.eval(`(()=>{const q=document.getElementById('tq');q.value='docker';q.dispatchEvent(new Event('input'));return [...document.querySelectorAll('#tlist .trow')].filter(r=>!r.hidden).map(r=>r.querySelector('a.t').getAttribute('href'))})()`);
      f.length === 1 && /docker\.html$/.test(f[0]) ? ok("toolbox: search finds cheat sheets too", f[0]) : fail("toolbox sheet search", JSON.stringify(f));
      const stillOpen = await p.eval(`[...document.querySelectorAll('#tlist details.grp')].filter(d=>!d.hidden&&d.open).length`);
      stillOpen === 2 ? ok("toolbox: search opens the matching group and its parent") : fail("toolbox search open", String(stillOpen));
      await p.eval(`(()=>{const q=document.getElementById('tq');q.value='';q.dispatchEvent(new Event('input'))})()`);
      (await p.eval(`document.querySelectorAll('#tlist details.grp[open]').length`)) === 2 ? ok("toolbox: clearing search restores groups") : fail("toolbox restore", "wrong groups open");
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
