// Alerts: phone notifications for a train you're catching (platform, delays, cancellation).
// The worker does the watching and sends Web Push messages; this side subscribes the phone
// and keeps the list of trains you're watching.

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function createAlerts(ctx) {
  const panel = document.getElementById('alertsPanel');
  const bodyEl = document.getElementById('alertsBody');
  const esc = ctx.esc;
  let list = ctx.store.get('alerts', []); // [{ id, label, key }]
  let note = '';
  let reg = null;

  if ('serviceWorker' in navigator && !ctx.DEMO) {
    navigator.serviceWorker
      .register('/sw.js')
      .then((r) => (reg = r))
      .catch(() => {});
    // Tapping a notification while the app is open: show that train
    navigator.serviceWorker.addEventListener('message', (e) => e.data && e.data.train && ctx.showTrain(e.data.train));
  }

  const saveList = () => ctx.store.set('alerts', list);

  const sameKey = (a, b) => {
    if (!a || !b) return true; // can't tell: assume fine
    const x = new Uint8Array(a);
    return x.length === b.length && x.every((v, i) => v === b[i]);
  };

  async function subscription(ask) {
    if (!supported()) return null;
    const r = reg || (await navigator.serviceWorker.ready);
    let sub = await r.pushManager.getSubscription();
    if (!ask) return sub;
    const res = await fetch(`${ctx.WORKER}/api/push/key`);
    const { key } = await res.json();
    if (!key) throw new Error('The server isn’t ready for alerts yet.');
    // Signed up against an older server key: those notifications would never arrive, so sign up again
    if (sub && !sameKey(sub.options && sub.options.applicationServerKey, keyBytes(key))) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('denied');
      sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    }
    return sub;
  }

  /** Check each step and send a test notification. Returns [{ ok, text }]. */
  async function test() {
    const steps = [];
    const add = (ok, text) => steps.push({ ok, text });
    if (ctx.DEMO) return [{ ok: false, text: 'Alerts don’t work in demo mode.' }];
    if (isIOS) {
      if (!standalone()) {
        add(false, 'Not opened from the home screen. On iPhone, notifications only work there: tap Share, then Add to Home Screen, and open Choo Choo from that icon.');
        return steps;
      }
      add(true, 'Opened from the home screen');
    }
    if (!supported()) {
      add(false, 'This browser can’t show notifications.');
      return steps;
    }
    if (Notification.permission === 'denied') {
      add(false, isIOS ? 'Notifications are turned off for Choo Choo. Turn them on in Settings → Notifications → Choo Choo, then try again.' : 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.');
      return steps;
    }
    let sub;
    try {
      sub = await subscription(true);
    } catch (err) {
      add(false, err.message === 'denied' ? 'You said no to notifications, so they can’t be sent.' : `Couldn’t sign this phone up: ${err.message}`);
      return steps;
    }
    add(true, 'Notifications allowed');
    if (!sub) {
      add(false, 'Couldn’t sign this phone up for notifications.');
      return steps;
    }
    add(true, `Signed up with ${new URL(sub.endpoint).host}`);
    try {
      const res = await fetch(`${ctx.WORKER}/api/alerts/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: sub.toJSON() }) });
      const d = await res.json();
      if (d.ok) add(true, 'Server sent it. It should arrive within a few seconds: leave the app or lock your phone to see the banner.');
      else if (res.status === 404 || d.error === 'not found') add(false, 'The server doesn’t have the test yet. It arrives with the next server update.');
      else add(false, `The server couldn’t send it: ${[d.status, d.error].filter(Boolean).join(' ')}`);
    } catch {
      add(false, 'Couldn’t reach the server.');
    }
    // The server may have cleared this phone's alerts if its old sign-up had stopped working
    sync();
    return steps;
  }

  /** Why alerts can't work here, if they can't. */
  function blocker() {
    if (ctx.DEMO) return 'Alerts don’t work in demo mode.';
    if (isIOS && !standalone())
      return 'On iPhone, alerts only work once Choo Choo is on your home screen: tap Share, then Add to Home Screen, and open it from there.';
    if (!supported()) return 'This browser can’t show notifications.';
    if (Notification.permission === 'denied') return 'Notifications are turned off for Choo Choo. Turn them on in your phone’s settings, then try again.';
    return null;
  }

  async function watch(key, crs) {
    const b = blocker();
    if (b) {
      note = b;
      ctx.setTab('alerts');
      render();
      return false;
    }
    try {
      const sub = await subscription(true);
      const res = await fetch(`${ctx.WORKER}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: sub.toJSON(), train: key, crs: crs || null }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      list = [d, ...list.filter((a) => a.key !== key)].slice(0, 20);
      saveList();
      note = '';
      render();
      ctx.onChange();
      return true;
    } catch (err) {
      note = err.message === 'denied' ? 'You said no to notifications, so alerts can’t be sent.' : `Couldn’t set the alert: ${err.message}`;
      ctx.setTab('alerts');
      render();
      return false;
    }
  }

  async function remove(id) {
    list = list.filter((a) => a.id !== id);
    saveList();
    render();
    ctx.onChange();
    try {
      const sub = await subscription(false);
      await fetch(`${ctx.WORKER}/api/alerts/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, endpoint: sub && sub.endpoint }),
      });
    } catch {}
  }

  /** The server drops alerts once the train has left: catch up with it. */
  async function sync() {
    if (blocker() || !list.length) return;
    try {
      const sub = await subscription(false);
      if (!sub) return;
      const res = await fetch(`${ctx.WORKER}/api/alerts/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      const d = await res.json();
      if (Array.isArray(d)) {
        list = d;
        saveList();
        render();
        ctx.onChange();
      }
    } catch {}
  }

  function itemsHtml() {
    return list
      .map(
        (a) => `<li><button class="al-go" type="button" data-show="${esc(a.key)}">${esc(a.label)}</button><button class="al-rm" type="button" data-rm="${esc(a.id)}" aria-label="Stop alerts for the ${esc(a.label)}">×</button></li>`,
      )
      .join('');
  }

  function render() {
    if (!panel || panel.hidden) return;
    const b = blocker();
    bodyEl.innerHTML = `
      ${note ? `<p class="al-note">${esc(note)}</p>` : b ? `<p class="al-note">${esc(b)}</p>` : ''}
      ${list.length ? `<ul class="al-list">${itemsHtml()}</ul>` : ''}
      <p class="bp-intro">${list.length ? '' : 'No trains being watched. '}Tap <b>Alert me</b> on a train to be told when its platform is announced or changes, if it’s late, or cancelled. Alerts stop once the train has left.</p>`;
  }

  bodyEl?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.rm) remove(b.dataset.rm);
    else if (b.dataset.show && !ctx.showTrain(b.dataset.show)) {
      note = 'That train isn’t on the map right now.';
      render();
    }
  });

  /** Turn automatic commute alerts on or off (weekday mornings and evenings). */
  async function setAuto(on, home, work) {
    if (on) {
      const b = blocker();
      if (b) {
        note = b;
        render();
        return false;
      }
    }
    try {
      const sub = await subscription(on);
      if (!sub) return on ? false : (ctx.store.set('autoAlerts', false), true);
      const res = await fetch(`${ctx.WORKER}/api/alerts/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: sub.toJSON(), home, work, on }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      ctx.store.set('autoAlerts', Boolean(on));
      return true;
    } catch (err) {
      note = err.message === 'denied' ? 'You said no to notifications, so alerts can’t be sent.' : `Couldn’t change that: ${err.message}`;
      render();
      return false;
    }
  }

  return {
    test,
    setAuto,
    autoOn: () => ctx.store.get('autoAlerts', false),
    watch,
    remove,
    sync,
    has: (key) => list.some((a) => a.key === key),
    list: () => list,
    itemsHtml,
    open(on) {
      panel.hidden = !on;
      if (on) {
        render();
        sync();
      } else note = '';
    },
    isOpen: () => !panel.hidden,
  };
}
