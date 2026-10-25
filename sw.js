// Service worker: makes the toolbox work offline.
// VERSION must match package.json (tests/pwa.test.js checks it); bumping it drops the old cache and shows the page's "new version" toast.
const VERSION = "1.4.0";
const CACHE = "dev-tools-" + VERSION;

// Precache every local script, stylesheet and sheet the main pages reference, so a first visit is enough to go offline.
async function precache() {
  const cache = await caches.open(CACHE), urls = new Set(["./", "toolbox.html", "all.html", "catalog.js", "manifest.json", "assets/sheet.css", "assets/sheet.js"]);
  for (const page of ["toolbox.html", "all.html"]) {
    const html = await (await fetch(page, { cache: "reload" })).text();
    for (const m of html.matchAll(/(?:src|href)="([^"#?:]+\.(?:js|css|svg|json))"/g)) urls.add(m[1]);
  }
  // catalog.js assigns to window (absent in a worker), so read the sheet ids out of its text instead of running it.
  const cat = await (await fetch("catalog.js")).text();
  for (const m of cat.slice(0, cat.indexOf("tools:")).matchAll(/id: "([a-z0-9-]+)"/g)) urls.add("sheets/" + m[1] + ".html");
  await Promise.all([...urls].map(u => cache.add(u).catch(() => {})));      // one missing file must not fail the install
}

self.addEventListener("install", ev => { ev.waitUntil(precache().then(() => self.skipWaiting())); });

self.addEventListener("activate", ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("dev-tools-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Stale-while-revalidate for same-origin GETs; WebSockets and cross-origin requests never reach this.
self.addEventListener("fetch", ev => {
  if (ev.request.method !== "GET") return;
  const url = new URL(ev.request.url);
  if (url.origin !== self.location.origin) return;
  ev.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(ev.request, { ignoreSearch: true });
    const network = fetch(ev.request).then(res => { if (res && res.status === 200) cache.put(ev.request, res.clone()); return res; });
    if (cached) { network.catch(() => {}); return cached; }
    return network.catch(() => cache.match("toolbox.html"));
  }));
});
