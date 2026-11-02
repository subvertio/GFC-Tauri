// GFC web app service worker: makes the app installable and opens it offline with the last
// version it loaded. Only the app's own files are cached: never the node's API, media or
// anything with a login on it. The page is fetched fresh first (new releases show up at the
// next launch); the hashed build files under assets/ never change, so they come from cache.

const CACHE = "gfc-web-v1";
const SCOPE = new URL(self.registration.scope).pathname; // "/app/web/"

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([SCOPE, SCOPE + "manifest.webmanifest"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (url.pathname.startsWith(SCOPE + "assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone(); // before the page reads the body
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })));
    return;
  }
  // The page and the rest of the shell: network first, the cached copy when offline
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match(SCOPE))));
});
