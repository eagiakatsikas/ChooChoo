// Usage counts: which parts of the app get used, by how many phones.
//
// Anonymous by design. Each phone sends a random ID it made itself (no name, account or
// location) and a short list of events such as "sheet:stn" or "search:miss". The worker
// keeps daily totals for 90 days, and the app's Usage page shows them.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = 'analytics.json';
const KEEP_DAYS = 90;
const MAX_DEVICES = 5000;
const MAX_EVENTS = 60; // per request
const NAME = /^[a-z0-9_.:-]{1,40}$/;
const DEVICE = /^[a-z0-9]{8,32}$/;

let store = { days: {}, seen: {} };
let saveTimer = null;
export const analyticsState = { events: 0, lastError: null };

function file() {
  return path.join(config.dataDir, FILE);
}

/** Today's date in London, e.g. 2026-10-26. */
export function dayKey(t = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

export function startAnalytics() {
  try {
    store = JSON.parse(fs.readFileSync(file(), 'utf8'));
    store.days ||= {};
    store.seen ||= {};
  } catch {}
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(store));
    } catch (err) {
      analyticsState.lastError = err.message;
    }
  }, 2000);
}

function prune(today) {
  const cutoff = dayKey(Date.parse(today + 'T12:00:00Z') - KEEP_DAYS * 86400000);
  for (const d of Object.keys(store.days)) if (d < cutoff) delete store.days[d];
  const ids = Object.keys(store.seen);
  if (ids.length > MAX_DEVICES) {
    ids.sort((a, b) => (store.seen[a] < store.seen[b] ? -1 : 1));
    for (const id of ids.slice(0, ids.length - MAX_DEVICES)) delete store.seen[id];
  }
}

const clip = (s, n) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Take a batch from one phone: { d: device id, p: 'phone'|'desktop', a: home-screen app,
 * e: [{ n: name, q?: missed search, m?: error message }] }.
 */
export function ingest(body, now = Date.now()) {
  if (!body || !DEVICE.test(String(body.d || ''))) return { error: 'bad device' };
  const list = Array.isArray(body.e) ? body.e.slice(0, MAX_EVENTS) : [];
  const today = dayKey(now);
  const day = (store.days[today] ||= { dev: {}, ev: {}, miss: {}, err: {} });
  day.dev[body.d] = { p: body.p === 'desktop' ? 'desktop' : 'phone', a: body.a ? 1 : 0 };
  if (!store.seen[body.d]) {
    store.seen[body.d] = today;
    prune(today);
  }
  let n = 0;
  for (const x of list) {
    const name = String((x && x.n) || '');
    if (!NAME.test(name)) continue;
    day.ev[name] = (day.ev[name] || 0) + 1;
    n++;
    if (name === 'search:miss' && x.q) {
      const q = clip(x.q, 30);
      if (q.length >= 2 && Object.keys(day.miss).length < 300) day.miss[q] = (day.miss[q] || 0) + 1;
    }
    if (name === 'error' && x.m) {
      const m = clip(x.m, 100);
      if (Object.keys(day.err).length < 100) day.err[m] = (day.err[m] || 0) + 1;
    }
  }
  analyticsState.events += n;
  save();
  return { ok: true, n };
}

const top = (obj, k) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([key, count]) => ({ key, count }));

/** Totals for the Usage page. */
export function usage(now = Date.now()) {
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = dayKey(now - i * 86400000);
    const x = store.days[d];
    days.push({ day: d, devices: x ? Object.keys(x.dev).length : 0, events: x ? Object.values(x.ev).reduce((a, b) => a + b, 0) : 0 });
  }
  const span = (n) => [...new Set(days.slice(-n).map((d) => d.day))].map((d) => store.days[d]).filter(Boolean);
  const devicesIn = (list) => {
    const m = new Map();
    for (const x of list) for (const [id, v] of Object.entries(x.dev)) m.set(id, v);
    return m;
  };
  const week = span(7);
  const weekDev = devicesIn(week);
  const weekStart = days[days.length - 7].day;
  const sum = (list, key) => {
    const out = {};
    for (const x of list) for (const [k, v] of Object.entries(x[key] || {})) out[k] = (out[k] || 0) + v;
    return out;
  };
  return {
    today: days[days.length - 1],
    week: {
      devices: weekDev.size,
      newDevices: [...weekDev.keys()].filter((id) => (store.seen[id] || '') >= weekStart).length,
      phone: [...weekDev.values()].filter((v) => v.p === 'phone').length,
      app: [...weekDev.values()].filter((v) => v.a).length,
      events: top(sum(week, 'ev'), 40),
      misses: top(sum(week, 'miss'), 10),
      errors: top(sum(week, 'err'), 5),
    },
    month: { devices: devicesIn(span(30)).size },
    allTime: { devices: Object.keys(store.seen).length, since: Object.values(store.seen).sort()[0] || null },
    days,
  };
}

export function _reset() {
  store = { days: {}, seen: {} };
}
