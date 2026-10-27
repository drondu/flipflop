/* Minimal offline shell: cache-first for same-origin GETs, network fallback.
   The version token below is replaced by tools/stamp-sw.mjs after
   `vite build` with a hash of the built assets, so a new deploy evicts the
   old shell and installed users actually receive updates (the browser's SW
   update check bypasses this fetch handler). In dev it stays a constant. */
const CACHE = "flipledger-__SW_VERSION__";

self.addEventListener("install", (e) => {
  self.skipWaiting();
  /* relative so the paths track the app's base path */
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./index.html"])));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(request).then((hit) => {
      const net = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
