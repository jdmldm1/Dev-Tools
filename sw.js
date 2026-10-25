// Service Worker for offline PWA support
const CACHE_NAME = "dev-tools-v1";

self.addEventListener("install", ev => {
  self.skipWaiting();
});

self.addEventListener("activate", ev => {
  ev.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", ev => {
  if (ev.request.method !== "GET") return;
  const url = new URL(ev.request.url);
  // Only cache local origin requests, skip websocket or cross-origin
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    caches.match(ev.request).then(cached => {
      const fetchPromise = fetch(ev.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(ev.request, resClone));
        }
        return networkResponse;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
