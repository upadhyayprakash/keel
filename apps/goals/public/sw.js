// Goals service worker: an offline shell, so the app still opens while keel serve is
// not reachable and shows the last-seen goals (ADR 0004). Pages go to the network
// first and fall back to the last copy; built files (hashed names) come from the
// cache once fetched. /api/ is never cached here: the app keeps its own last-seen
// copy and never writes while Keel is away. Push handling comes with slice 03.
const CACHE = 'keel-goals-shell-v1';
const SHELL = '/goals/';

/** The shell and the built files it names, so the first visit already works offline later. */
async function precache() {
  const res = await fetch(SHELL);
  if (!res.ok) return;
  const html = await res.clone().text();
  const cache = await caches.open(CACHE);
  await cache.put(SHELL, res);
  await cache.addAll([...html.matchAll(/(?:src|href)="(\/goals\/assets\/[^"]+)"/g)].map((m) => m[1]));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('keel-goals-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Keel did not answer: no network, or the tunnel had nothing behind it. */
const away = (res) => res.status >= 502 && res.status <= 504;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/goals/')) return;

  // Every /goals/... page is the same app: keep the latest one under SHELL.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (away(res)) throw new Error('away');
          if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          }
          return res;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/goals/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
