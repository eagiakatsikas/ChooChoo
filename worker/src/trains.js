// Live train state, updated from TRUST (train movements) and TD (signalling berth steps).
import { ref, tiplocsForStanox, locName } from './reference.js';
import { sched, runEpoch, timeIn, timeOut } from './schedule.js';
import { normaliseLiveTs, hhmm } from './time.js';
import { operatorName } from './operators.js';
import { pathFor, pathPoints, stationPoint } from './tracks.js';

/** runKey → train */
export const trains = new Map();
/** TRUST train_id → runKey */
const trainIdToKey = new Map();
/** TRUST train_ids that are not London passenger trains (skip quickly) */
const ignoredIds = new Map();
/** headcode → Set(runKey) of trains currently tracked */
const activeByHead = new Map();

export const stats = { trust: 0, td: 0, tdMatched: 0, trustMatched: 0, vstp: 0, lastMsg: null };

function track(key, run, trainId) {
  let t = trains.get(key);
  if (!t) {
    t = {
      key,
      run,
      trainId: trainId || null,
      idx: 0,
      state: 'pending', // pending | arr | dep | done
      lastTime: runEpoch(run, timeOut(run.locs[0])),
      delay: 0,
      platform: run.locs[0].plat || '',
      source: 'schedule',
      updated: Date.now(),
      doneAt: null,
    };
    trains.set(key, t);
    let set = activeByHead.get(run.headcode);
    if (!set) activeByHead.set(run.headcode, (set = new Set()));
    set.add(key);
  }
  if (trainId && !t.trainId) t.trainId = trainId;
  if (trainId) trainIdToKey.set(trainId, key);
  return t;
}

function untrack(key) {
  const t = trains.get(key);
  if (!t) return;
  trains.delete(key);
  activeByHead.get(t.run.headcode)?.delete(key);
  if (t.trainId) trainIdToKey.delete(t.trainId);
}

/** Find index of a location matching any tiploc, preferring the earliest at/after `from`. */
function findLoc(run, tiplocs, from = 0) {
  const set = new Set(tiplocs);
  for (let i = Math.max(0, from); i < run.locs.length; i++) if (set.has(run.locs[i].t)) return i;
  return -1;
}

/** Find the scheduled run for a headcode seen at a location around time ts. */
function resolveByHeadcode(headcode, tiplocs, ts, dayOfMonth = null) {
  const keys = sched.byHeadcode.get(headcode);
  if (!keys) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const key of keys) {
    const run = sched.runs.get(key);
    if (!run) continue;
    if (dayOfMonth != null && Number(run.date.slice(8, 10)) !== dayOfMonth) continue;
    const i = findLoc(run, tiplocs);
    if (i < 0) continue;
    const diff = Math.abs(runEpoch(run, timeIn(run.locs[i])) - ts);
    if (diff < bestDiff) {
      best = run;
      bestDiff = diff;
    }
  }
  return best && bestDiff < 3 * 3600000 ? best : null;
}

function ignore(trainId) {
  ignoredIds.set(trainId, Date.now());
}

/** Apply a located event to a train. kind: 'arr' | 'dep' */
function applyEvent(t, i, kind, ts, platform, source) {
  if (i < t.idx) return false;
  const loc = t.run.locs[i];
  // Passing points have no stop: an "arrival" there is really passing through.
  if (kind === 'arr' && loc.a == null && loc.d == null) kind = 'dep';
  if (i === t.idx && t.state === 'dep' && kind === 'arr') return false;
  if (i === t.idx && t.state === kind && source === 'TRUST' && t.source === 'TD') {
    // TD usually beats TRUST; keep TD's time but accept TRUST's platform.
    if (platform) t.platform = platform;
    return false;
  }
  t.idx = i;
  t.state = kind;
  t.lastTime = ts;
  const schedMin = kind === 'arr' ? timeIn(loc) : timeOut(loc);
  if (schedMin != null) t.delay = Math.round((ts - runEpoch(t.run, schedMin)) / 60000);
  if (platform) t.platform = platform;
  else if (loc.plat) t.platform = loc.plat;
  t.source = source;
  t.updated = Date.now();
  if (i === t.run.locs.length - 1 && kind === 'arr') {
    t.state = 'done';
    t.doneAt = Date.now();
  }
  return true;
}

// ---------- TRUST (TRAIN_MVT_ALL_TOC) ----------

export function handleTrust(messages) {
  for (const m of messages) {
    const type = m?.header?.msg_type;
    const b = m?.body;
    if (!b) continue;
    stats.trust++;
    stats.lastMsg = Date.now();
    try {
      if (type === '0001') onActivation(b);
      else if (type === '0002') onCancellation(b);
      else if (type === '0003') onMovement(b);
    } catch (err) {
      console.error('[trust]', err.message);
    }
  }
}

function onActivation(b) {
  const date = b.tp_origin_timestamp || b.schedule_start_date;
  const uid = b.train_uid;
  const run = sched.runs.get(`${uid}|${date}`) || sched.runs.get(`${String(uid).trim()}|${date}`);
  if (!run) {
    ignore(b.train_id);
    return;
  }
  track(`${run.uid}|${run.date}`, run, b.train_id);
}

/** Trains cancelled recently (key → when), so alerts can say so. */
export const cancelledKeys = new Map();

function onCancellation(b) {
  const key = trainIdToKey.get(b.train_id);
  if (!key) return;
  cancelledKeys.set(key, Date.now());
  if (cancelledKeys.size > 5000) cancelledKeys.delete(cancelledKeys.keys().next().value);
  // Part cancellations (en route) keep the train until it reaches the cancel point.
  if (b.canx_type === 'ON CALL' || b.canx_type === 'AT ORIGIN') untrack(key);
}

function onMovement(b) {
  const trainId = b.train_id;
  let key = trainIdToKey.get(trainId);
  const tiplocs = tiplocsForStanox(b.loc_stanox);
  const ts = normaliseLiveTs(b.actual_timestamp);

  if (!key) {
    if (ignoredIds.has(trainId)) return;
    // Missed the activation (e.g. worker restarted): work it out from the train ID.
    const headcode = trainId.slice(2, 6);
    const day = Number(trainId.slice(8, 10));
    const run = tiplocs.length ? resolveByHeadcode(headcode, tiplocs, ts, day) : null;
    if (!run) {
      if (tiplocs.length) ignore(trainId);
      return;
    }
    key = `${run.uid}|${run.date}`;
    track(key, run, trainId);
  }
  const t = trains.get(key);
  if (!t || !tiplocs.length) return;
  let i = findLoc(t.run, tiplocs, t.idx);
  if (i < 0) return;
  const kind = b.event_type === 'ARRIVAL' ? 'arr' : 'dep';
  if (applyEvent(t, i, kind, ts, (b.platform || '').trim(), 'TRUST')) stats.trustMatched++;
  if (b.train_terminated === 'true') {
    t.state = 'done';
    t.doneAt = Date.now();
  }
}

// ---------- TD (TD_ALL_SIG_AREA) ----------

export function handleTd(messages) {
  for (const wrap of messages) {
    const m = wrap.CA_MSG || wrap.CC_MSG;
    if (!m) continue;
    stats.td++;
    stats.lastMsg = Date.now();
    const from = m.msg_type === 'CC' ? '' : (m.from || '').trim();
    const steps = ref.smart.get(`${m.area_id}|${from}|${(m.to || '').trim()}`);
    if (!steps) continue;
    const headcode = (m.descr || '').trim();
    if (!/^\d[A-Z]\d\d$/.test(headcode)) continue;
    const ts = normaliseLiveTs(m.time);
    for (const s of steps) {
      try {
        onBerthEvent(headcode, s, ts);
      } catch (err) {
        console.error('[td]', err.message);
      }
    }
  }
}

function onBerthEvent(headcode, step, ts) {
  const tiplocs = tiplocsForStanox(step.stanox);
  if (!tiplocs.length) return;
  const kind = step.event === 'A' || step.event === 'C' ? 'arr' : step.event === 'B' || step.event === 'D' ? 'dep' : null;
  if (!kind) return;
  const when = ts + step.offset * 1000;

  // Prefer a train we're already tracking with this headcode that calls here next.
  let best = null;
  let bestDiff = Infinity;
  for (const key of activeByHead.get(headcode) || []) {
    const t = trains.get(key);
    if (!t || t.state === 'done') continue;
    const i = findLoc(t.run, tiplocs, t.idx);
    if (i < 0) continue;
    const diff = Math.abs(runEpoch(t.run, timeIn(t.run.locs[i])) + t.delay * 60000 - when);
    if (diff < bestDiff) {
      best = { t, i };
      bestDiff = diff;
    }
  }
  if (!best || bestDiff > 3 * 3600000) {
    const run = resolveByHeadcode(headcode, tiplocs, when);
    if (!run) return;
    const t = track(`${run.uid}|${run.date}`, run, null);
    const i = findLoc(run, tiplocs, t.idx);
    if (i < 0) return;
    best = { t, i };
  }
  if (applyEvent(best.t, best.i, kind, when, step.platform, 'TD')) stats.tdMatched++;
}

// ---------- Housekeeping ----------

export function cleanup(now = Date.now()) {
  for (const [key, t] of trains) {
    if (t.state === 'done' && now - t.doneAt > 3 * 60000) untrack(key);
    else if (t.state === 'pending' && now - t.lastTime > 90 * 60000) untrack(key);
    else if (t.state !== 'pending' && now - t.updated > 2 * 3600000) untrack(key);
    else if (!sched.runs.has(key) && now - t.updated > 30 * 60000) untrack(key);
  }
  for (const [id, at] of ignoredIds) if (now - at > 12 * 3600000) ignoredIds.delete(id);
}

// ---------- Views sent to the browser ----------

function coordIdxBack(run, i) {
  for (let k = i; k >= 0; k--) if (ref.coords.has(run.locs[k].t)) return k;
  return -1;
}
function coordIdxFwd(run, i) {
  for (let k = i + 1; k < run.locs.length; k++) if (ref.coords.has(run.locs[k].t)) return k;
  return -1;
}
const r5 = (n) => Math.round(n * 1e5) / 1e5;

/** Compact view of a train for the map; null if it shouldn't be shown yet. */
export function view(t, now = Date.now()) {
  const run = t.run;
  const locs = run.locs;
  const first = locs[0];
  const last = locs[locs.length - 1];
  const v = {
    id: t.key,
    hc: run.headcode,
    toc: run.toc,
    op: operatorName(run.toc),
    o: locName(first.t),
    d: locName(last.t),
    dep: hhmm(runEpoch(run, timeOut(first))),
    dl: t.delay,
    pl: t.platform || undefined,
    src: t.source,
    up: t.lastTime,
  };

  let a = coordIdxBack(run, t.idx);
  let b = coordIdxFwd(run, t.idx);

  if (t.state === 'pending') {
    if (now < t.lastTime - 10 * 60000) return null;
    const k = a >= 0 ? a : b;
    if (k < 0) return null;
    const c = stationPoint(locs[k].t, ref.coords.get(locs[k].t));
    v.st = 'wait';
    v.p = [r5(c.lat), r5(c.lng)];
    v.at = locName(locs[k].t);
  } else if ((t.state === 'arr' || t.state === 'done') && a === t.idx) {
    const c = stationPoint(locs[a].t, ref.coords.get(locs[a].t));
    v.st = t.state === 'done' ? 'end' : 'at';
    v.p = [r5(c.lat), r5(c.lng)];
    v.at = locName(locs[a].t);
  } else {
    if (a < 0 && b < 0) return null;
    if (a < 0 || b < 0) {
      const k = a >= 0 ? a : b;
      const c = stationPoint(locs[k].t, ref.coords.get(locs[k].t));
      v.st = 'at';
      v.p = [r5(c.lat), r5(c.lng)];
      v.at = locName(locs[a >= 0 ? a : b].t);
    } else {
      const ca = stationPoint(locs[a].t, ref.coords.get(locs[a].t));
      const cb = stationPoint(locs[b].t, ref.coords.get(locs[b].t));
      const cur = locs[t.idx];
      const tCur = t.state === 'arr' ? timeIn(cur) : timeOut(cur);
      const tA = timeOut(locs[a]) ?? tCur;
      let tB = timeIn(locs[b]) ?? tCur + 2;
      if (tB <= tA) tB = tA + 1;
      const t0 = t.lastTime - (tCur - tA) * 60000;
      const t1 = Math.max(t.lastTime + 30000, t.lastTime + (tB - tCur) * 60000);
      v.st = 'mv';
      v.seg = [r5(ca.lat), r5(ca.lng), r5(cb.lat), r5(cb.lng), Math.round(t0), Math.round(t1)];
      // Follow the real track between the two points when its route is known
      const pr = pathFor(locs[a].t, ref.coords.get(locs[a].t), locs[b].t, ref.coords.get(locs[b].t));
      if (pr) {
        v.pk = pr.key;
        if (pr.rev) v.rv = 1;
      }
      v.at = locName(cur.t);
    }
  }

  // Next public stop and expected time
  for (let k = t.idx + (t.state === 'pending' ? 0 : 1); k < locs.length; k++) {
    if (!locs[k].pub) continue;
    v.nx = locName(locs[k].t);
    v.nxt = hhmm(runEpoch(run, timeIn(locs[k])) + Math.max(0, t.delay) * 60000);
    break;
  }
  return v;
}

/** Full calling pattern for the detail panel. */
export function detail(key) {
  const t = trains.get(key);
  if (!t) return null;
  const run = t.run;
  const stops = [];
  const path = [];
  let prev = null; // last located point [tiploc, coords]
  run.locs.forEach((l, i) => {
    const c = ref.coords.get(l.t);
    if (c) {
      const pts = prev && pathPoints(prev[0], prev[1], l.t, c);
      if (pts) for (const p of pts.slice(1)) path.push(p);
      else {
        const sp = stationPoint(l.t, c);
        path.push([r5(sp.lat), r5(sp.lng)]);
      }
      prev = [l.t, c];
    }
    if (!l.pub && i !== 0 && i !== run.locs.length - 1) return;
    const s = timeIn(l);
    const passed = i < t.idx || (i === t.idx && t.state !== 'pending' && t.state !== 'arr');
    const here = i === t.idx && (t.state === 'arr' || t.state === 'done');
    stops.push({
      n: locName(l.t),
      s: hhmm(runEpoch(run, i === 0 ? timeOut(l) : s)),
      e: passed || here ? null : hhmm(runEpoch(run, i === 0 ? timeOut(l) : s) + Math.max(0, t.delay) * 60000),
      done: passed,
      here,
      pl: l.plat || undefined,
    });
  });
  return { id: key, hc: run.headcode, op: operatorName(run.toc), toc: run.toc, stops, path, delay: t.delay };
}

export function _resetForTest() {
  trains.clear();
  trainIdToKey.clear();
  ignoredIds.clear();
  activeByHead.clear();
}
