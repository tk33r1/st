/* MAGI PWA service worker — cache the app shell only.
 * API calls (/magi2/*) are always network: never cache streamed responses. */
var CACHE = 'magi-shell-v10';
// Shell files, icons included (they are committed in www/).
var CORE = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // Bypass the HTTP cache (the site sends max-age=14400): otherwise a new
    // version can re-cache stale copies, such as the HTML the host returned
    // for icons before they existed.
    return c.addAll(CORE.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                      // never intercept POSTs (chat/react)
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;            // only handle our own origin (never the API)
  if (url.pathname.indexOf('/magi2/') !== -1) return;    // belt-and-suspenders: never cache the API
  // Cache-first for the shell, network fallback otherwise.
  e.respondWith(caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return hit; });
  }));
});
