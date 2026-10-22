// Choo Choo service worker: shows train alerts sent by the worker, even when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
