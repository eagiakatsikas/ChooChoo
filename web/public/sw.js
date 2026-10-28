// Choo Choo service worker: shows train alerts sent by the worker, even when the app is closed,
// and keeps a copy of the app so it opens straight away (and with no signal).
const CACHE = 'choochoo-app-v1';
const MAX_ENTRIES = 80;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('choochoo-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

async function put(req, res) {
  if (!res || !(res.ok || res.type === 'opaque')) return;
  const c = await caches.open(CACHE);
  await c.put(req, res);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await c.delete(k); // oldest first
}

/** The app's page: the latest from the network if it answers quickly, else the copy. */
async function page(req) {
  const c = await caches.open(CACHE);
  const net = fetch(req).then((res) => {
    if (res.ok) put('/', res.clone());
    return res;
  });
  const quick = new Promise((r) => setTimeout(r, 3000));
  const first = await Promise.race([net.catch(() => null), quick]);
  if (first) return first;
  const copy = await c.match('/');
  if (copy) return copy;
  return net; // nothing kept yet: wait for the network
}

/** Files whose names change when they change (scripts, styles, icons, fonts): the copy first. */
async function file(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.host)) e.respondWith(file(req));
    return; // live data from the worker, and map tiles: always from the network
  }
  if (req.mode === 'navigate') return e.respondWith(page(req));
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) e.respondWith(file(req));
});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data && e.data.text() };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Choo Choo', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: Boolean(d.tag),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { train: d.train || null },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const train = e.notification.data && e.notification.data.train;
  const url = train ? `/?train=${encodeURIComponent(train)}` : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        c.postMessage({ train });
        return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
