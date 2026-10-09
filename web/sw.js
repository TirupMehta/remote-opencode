/* OpenCode Remote service worker: app-shell offline support.
   API (/api/*) and the event stream are never cached. */
const CACHE = 'ocr-shell-v7';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/vendor/')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: url.pathname.endsWith('.js') || url.pathname.endsWith('.css') }).then((hit) => {
      const fresh = fetch(e.request).then((res) => {
        if (res.ok && SHELL.some((s) => url.pathname === s || (s === '/' && url.pathname === '/'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fresh;
    }),
  );
});
