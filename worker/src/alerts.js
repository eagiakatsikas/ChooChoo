// Alerts: phone notifications for a train you're catching.
//
// The site sends a Web Push subscription plus the train (and the station you're getting
// on at). Every 30 seconds the worker checks each watched train and sends a notification
// when its platform is announced or changes, when it's running late (or catches up), or
// when it's cancelled. Watches end once the train has left your station.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { config } from './config.js';
import { ref } from './reference.js';
import { sched, runEpoch, timeIn, timeOut } from './schedule.js';
import { trains, cancelledKeys } from './trains.js';
import { board } from './board.js';
import { hhmm } from './time.js';

const FILE = 'alerts.json';
const CHECK_MS = 30000;
const MAX_WATCHES = 500;

export const alertState = { watches: 0, sent: 0, failed: 0, lastError: null };

let store = { vapid: null, watches: [] };
let saveTimer = null;

function file() {
  return path.join(config.dataDir, FILE);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(store));
    } catch (err) {
      alertState.lastError = err.message;
    }
  }, 500);
  alertState.watches = store.watches.length;
}

export function startAlerts({ check = true } = {}) {
  try {
    store = JSON.parse(fs.readFileSync(file(), 'utf8'));
    store.watches ||= [];
  } catch {}
  if (!store.vapid) {
    // Keys that identify this server to the phones' push services; made once and kept
    store.vapid = webpush.generateVAPIDKeys();
    save();
  }
  webpush.setVapidDetails('mailto:choochoo@example.invalid', store.vapid.publicKey, store.vapid.privateKey);
  alertState.watches = store.watches.length;
  if (check) setInterval(() => checkAll().catch((err) => (alertState.lastError = err.message)), CHECK_MS);
}

export const publicKey = () => store.vapid?.publicKey || null;

/** Where the train calls at this station (or, without one, its next stop). */
function boardingIndex(run, crs, t) {
  const st = crs && ref.stations.get(crs);
  if (st) {
    const i = run.locs.findIndex((l) => st.tiplocs.has(l.t) && l.d != null);
    if (i >= 0) return i;
  }
  const from = t ? t.idx + 1 : 0;
  for (let i = Math.max(0, from); i < run.locs.length - 1; i++) if (run.locs[i].pub && run.locs[i].d != null) return i;
  return 0;
}

const stationName = (tiploc) => {
  const crs = ref.tiplocCrs.get(tiploc);
  return (crs && ref.stations.get(crs)?.name) || ref.coords.get(tiploc)?.name || tiploc;
};

export function addWatch({ sub, train, crs }) {
  if (!sub || !sub.endpoint || !sub.keys) return { error: 'Missing push subscription' };
  const run = sched.runs.get(train);
  if (!run) return { error: 'Unknown train' };
  const t = trains.get(train);
  const i = boardingIndex(run, crs, t);
  const loc = run.locs[i];
  const depAt = runEpoch(run, timeOut(loc) ?? timeIn(loc));
  const label = `${hhmm(depAt)} from ${stationName(loc.t).replace(/^London /, '')} to ${stationName(run.locs[run.locs.length - 1].t).replace(/^London /, '')}`;
  // One watch per phone per train
  store.watches = store.watches.filter((w) => !(w.key === train && w.sub.endpoint === sub.endpoint));
  if (store.watches.length >= MAX_WATCHES) store.watches.shift();
  const w = {
    id: Math.random().toString(36).slice(2, 10),
    sub,
    key: train,
    crs: ref.tiplocCrs.get(loc.t) || crs || null,
    i,
    label,
    depAt,
    created: Date.now(),
    last: { plat: null, delay: null },
  };
  store.watches.push(w);
  save();
  send(w, { title: 'Alert set', body: `We’ll tell you about the ${label}: platform, delays and cancellations.` });
  return { id: w.id, label, key: train };
}

export function removeWatch(id, endpoint) {
  const before = store.watches.length;
  store.watches = store.watches.filter((w) => !(w.id === id && (!endpoint || w.sub.endpoint === endpoint)));
  if (store.watches.length !== before) save();
  return { ok: true };
}

export function listWatches(endpoint) {
  return store.watches.filter((w) => w.sub.endpoint === endpoint).map((w) => ({ id: w.id, label: w.label, key: w.key, crs: w.crs }));
}

async function send(w, { title, body }) {
  try {
    await webpush.sendNotification(w.sub, JSON.stringify({ title, body, tag: w.key, train: w.key }), { TTL: 900, urgency: 'high' });
    alertState.sent++;
  } catch (err) {
    alertState.failed++;
    alertState.lastError = err.message;
    // The phone has unsubscribed (or the app was removed): forget its alerts
    if (err.statusCode === 404 || err.statusCode === 410) {
      store.watches = store.watches.filter((x) => x.sub.endpoint !== w.sub.endpoint);
      save();
    }
  }
}

/** What we know right now about a watched train at its boarding station. */
export async function statusOf(w, now = Date.now()) {
  const run = sched.runs.get(w.key);
  if (!run) return { gone: true };
  if (cancelledKeys.has(w.key)) return { cancelled: true };
  const t = trains.get(w.key);
  const i = w.i;
  if (t && (t.idx > i || (t.idx === i && t.state !== 'pending' && t.state !== 'arr'))) return { left: true };
  let plat = run.locs[i].plat || null;
  let platLive = false;
  let delay = t ? Math.max(0, t.delay || 0) : null;
  if (t && t.idx === i && t.state === 'arr' && t.platform) {
    plat = t.platform;
    platLive = true;
  }
  // The station's own board knows platforms before the train arrives
  if (config.ldbKey && w.crs) {
    try {
      const b = await board(w.crs, '');
      const row = b.rows && b.rows.find((r) => r.id === w.key);
      if (row) {
        if (row.cancelled) return { cancelled: true };
        if (row.plat && row.platLive) {
          plat = row.plat;
          platLive = true;
        }
        if (row.etdTime) {
          const [h, m] = row.etdTime.split(':').map(Number);
          const [sh, sm] = row.std.split(':').map(Number);
          let d = h * 60 + m - (sh * 60 + sm);
          if (d < -720) d += 1440;
          delay = Math.max(0, d);
        } else if (/on time/i.test(row.etd)) delay = 0;
      }
    } catch {}
  }
  const expected = w.depAt + (delay || 0) * 60000;
  if (now > expected + 20 * 60000) return { left: true };
  return { plat, platLive, delay, expected };
}

/** Decide which notifications a change deserves. Returns the messages to send. */
export function changes(w, s) {
  const out = [];
  if (s.cancelled) {
    out.push({ title: 'Cancelled', body: `The ${w.label} has been cancelled.` });
    return out;
  }
  if (s.platLive && s.plat && s.plat !== w.last.plat) {
    out.push({
      title: w.last.plat ? `Platform change: ${s.plat}` : `Platform ${s.plat}`,
      body: `The ${w.label} ${w.last.plat ? `now leaves from platform ${s.plat} (was ${w.last.plat})` : `leaves from platform ${s.plat}`}.`,
    });
  }
  const d = s.delay;
  const before = w.last.delay;
  if (d != null) {
    if (d >= 3 && (before == null || before < 3 || Math.abs(d - before) >= 3)) {
      out.push({ title: `${d} min late`, body: `The ${w.label} is now expected at ${hhmm(s.expected)}.` });
    } else if (d <= 1 && before != null && before >= 3) {
      out.push({ title: 'Back on time', body: `The ${w.label} is running on time again.` });
    }
  }
  return out;
}

export async function checkAll(now = Date.now()) {
  let changed = false;
  for (const w of [...store.watches]) {
    const s = await statusOf(w, now);
    if (s.gone || s.left) {
      store.watches = store.watches.filter((x) => x !== w);
      changed = true;
      continue;
    }
    for (const m of changes(w, s)) await send(w, m);
    if (s.cancelled) {
      store.watches = store.watches.filter((x) => x !== w);
    } else {
      if (s.platLive && s.plat) w.last.plat = s.plat;
      if (s.delay != null && (w.last.delay == null || Math.abs(s.delay - w.last.delay) >= 3 || (s.delay <= 1 && w.last.delay >= 3))) w.last.delay = s.delay;
    }
    changed = true;
  }
  if (changed) save();
}
