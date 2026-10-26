// Usage counts: tells Choo Choo's own server which parts of the app get used.
// Anonymous: a random ID this phone makes for itself, and event names like "sheet:stn".
// No names, accounts or locations. Nothing goes anywhere but your own server.

const FLUSH_MS = 15000;

export function createUsage({ WORKER, DEMO, store }) {
  const off = DEMO || !WORKER;
  let id = store.get('aid', null);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
    store.set('aid', id);
  }
  const phone = window.matchMedia('(max-width: 899px)').matches;
  const app = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let queue = [];
  const once = new Set(); // events counted at most once per visit

  function flush(leaving = false) {
    if (off || !queue.length) return Promise.resolve();
    const body = JSON.stringify({ d: id, p: phone ? 'phone' : 'desktop', a: app ? 1 : 0, e: queue.splice(0, 60) });
    const url = `${WORKER}/api/ev`;
    // text/plain keeps it a "simple" request: no extra round trip to ask permission first
    if (leaving && navigator.sendBeacon) return Promise.resolve(navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })));
    return fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => {});
  }
  setInterval(() => flush(), FLUSH_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush(true));

  /** Count something. extra: { q } for a search that found nothing, { m } for an error. */
  function track(n, extra = {}) {
    if (off) return;
    queue.push({ n, ...extra });
    if (queue.length >= 40) flush();
  }
  function trackOnce(n, extra) {
    if (once.has(n)) return;
    once.add(n);
    track(n, extra);
  }

  track(app ? 'open:app' : 'open:browser');
  setTimeout(() => flush(), 3000);
  return { track, trackOnce, flush };
}
