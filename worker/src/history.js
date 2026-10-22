// Reliability: how your saved routes have actually run. The app tells the worker which
// routes you've saved; every minute the worker notes how late each direct train on those
// routes arrived (or that it was cancelled), and keeps 30 days of it.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ref } from './reference.js';
import { sched, runEpoch } from './schedule.js';
import { trains, cancelledKeys } from './trains.js';
import { hhmm, londonDateStr } from './time.js';

const FILE = 'history.json';
const KEEP_DAYS = 30;
const MAX_PAIRS = 60;
const LATE = 3; // minutes: "late" from here

let store = { pairs: {} };
let dirty = false;

function file() {
  return path.join(config.dataDir, FILE);
}

export function startHistory({ check = true } = {}) {
  try {
    store = JSON.parse(fs.readFileSync(file(), 'utf8'));
    store.pairs ||= {};
  } catch {}
  if (!check) return;
  setInterval(() => {
    try {
      checkHistory();
    } catch (err) {
      console.error('[history]', err.message);
    }
  }, 60000);
  setInterval(save, 5 * 60000);
}

function save() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(store));
  } catch {}
}

/** Routes someone has saved: start (or keep) recording them. */
export function watchPairs(list, now = Date.now()) {
  for (const r of (Array.isArray(list) ? list : []).slice(0, 10)) {
    const f = String(r.f || '').toUpperCase();
    const t = String(r.t || '').toUpperCase();
    if (!ref.stations.has(f) || !ref.stations.has(t) || f === t) continue;
    const k = `${f}|${t}`;
    store.pairs[k] ||= { since: now, recs: {} };
    store.pairs[k].asked = now;
  }
  // Too many? Drop the ones nobody has asked about for longest
  const keys = Object.keys(store.pairs);
  if (keys.length > MAX_PAIRS) {
    keys.sort((a, b) => store.pairs[a].asked - store.pairs[b].asked);
    for (const k of keys.slice(0, keys.length - MAX_PAIRS)) delete store.pairs[k];
  }
  dirty = true;
}

/** Note the outcome of every direct train on each saved route that has finished its trip. */
export function checkHistory(now = Date.now()) {
  const cutoff = now - KEEP_DAYS * 86400000;
  for (const [k, pair] of Object.entries(store.pairs)) {
    if (now - (pair.asked || 0) > KEEP_DAYS * 86400000) {
      delete store.pairs[k];
      dirty = true;
      continue;
    }
    const [f, t] = k.split('|');
    const A = ref.stations.get(f);
    const B = ref.stations.get(t);
    if (!A || !B) continue;
    for (const [key, run] of sched.runs) {
      if (pair.recs[key]) continue;
      const locs = run.locs;
      const i = locs.findIndex((l) => A.tiplocs.has(l.t) && l.d != null && l.pub);
      if (i < 0) continue;
      let j = -1;
      for (let x = i + 1; x < locs.length; x++) {
        if (B.tiplocs.has(locs[x].t) && locs[x].a != null && locs[x].pub) {
          j = x;
          break;
        }
      }
      if (j < 0) continue;
      const depAt = runEpoch(run, locs[i].d);
      if (depAt > now || depAt < now - 4 * 3600000) continue;
      const tr = trains.get(key);
      let rec = null;
      if (cancelledKeys.has(key)) rec = { c: 1 };
      else if (tr && tr.idx >= j) rec = { a: tr.delay || 0 };
      if (!rec) continue;
      rec.d = londonDateStr(depAt);
      rec.s = hhmm(depAt);
      rec.at = depAt;
      pair.recs[key] = rec;
      dirty = true;
    }
    for (const [rk, r] of Object.entries(pair.recs)) if (r.at < cutoff) delete pair.recs[rk];
  }
}

/** How a route has been running: last 7 and 30 days, and by departure time. */
export function historyFor(f, t, now = Date.now()) {
  const pair = store.pairs[`${String(f).toUpperCase()}|${String(t).toUpperCase()}`];
  if (!pair) return { since: null, week: null, month: null, times: [] };
  const recs = Object.values(pair.recs);
  const sum = (list) => {
    if (!list.length) return null;
    const ran = list.filter((r) => !r.c);
    const late = ran.filter((r) => r.a >= LATE);
    return {
      trains: list.length,
      onTime: ran.length - late.length,
      late: late.length,
      cancelled: list.length - ran.length,
      avgLate: late.length ? Math.round(late.reduce((s, r) => s + r.a, 0) / late.length) : 0,
    };
  };
  const week = recs.filter((r) => now - r.at < 7 * 86400000);
  const byTime = new Map();
  for (const r of week) {
    const x = byTime.get(r.s) || { s: r.s, trains: 0, late: 0, cancelled: 0, worst: 0 };
    x.trains++;
    if (r.c) x.cancelled++;
    else if (r.a >= LATE) x.late++;
    x.worst = Math.max(x.worst, r.a || 0);
    byTime.set(r.s, x);
  }
  return {
    since: pair.since,
    week: sum(week),
    month: sum(recs),
    times: [...byTime.values()].sort((a, b) => a.s.localeCompare(b.s)),
  };
}

export const historyInfo = () => ({ routes: Object.keys(store.pairs).length });
