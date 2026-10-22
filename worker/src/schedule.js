// Timetable: which London passenger trains run on which dates, and their calling patterns.
import { config } from './config.js';
import { lines } from './download.js';
import { ref, addTiploc, finaliseTiplocs, computeLondon } from './reference.js';
import { parseCifTime, addDays, weekdayIndex, londonEpoch, londonDateStr } from './time.js';

// Passenger train categories (ordinary, express, metro, sleeper, international…)
const PASSENGER_CATS = new Set(['OL', 'OU', 'OO', 'OW', 'XC', 'XD', 'XI', 'XR', 'XU', 'XX', 'XZ']);
const PASSENGER_STATUS = new Set(['P', '1']);
const STP_RANK = { C: 3, O: 2, N: 2, P: 1 };

export const sched = {
  /** "uid|date" → run */
  runs: new Map(),
  /** headcode → Set of run keys */
  byHeadcode: new Map(),
  loadedAt: null,
  windowDates: [],
};

/**
 * Compact a schedule into { uid, headcode, toc, cat, locs:[{t,a,d,p,pub,plat}] }
 * Times are minutes after midnight of the run date, made monotonic across midnight.
 */
function compact(uid, headcode, toc, cat, rawLocs, getters) {
  const locs = [];
  let last = -1;
  let dayAdd = 0;
  const fix = (m) => {
    if (m == null) return null;
    let v = m + dayAdd;
    if (last >= 0 && v < last - 60) {
      dayAdd += 1440;
      v += 1440;
    }
    last = Math.max(last, v);
    return v;
  };
  for (const l of rawLocs) {
    const t = getters.tiploc(l);
    if (!t) continue;
    const a = fix(parseCifTime(getters.arr(l)));
    const p = fix(parseCifTime(getters.pass(l)));
    const d = fix(parseCifTime(getters.dep(l)));
    const pub = Boolean(getters.pubArr(l) || getters.pubDep(l));
    locs.push({ t, a, d, p, pub, plat: (getters.plat(l) || '').trim() });
  }
  if (locs.length < 2) return null;
  locs[0].pub = locs[0].pub || locs[0].d != null;
  locs[locs.length - 1].pub = locs[locs.length - 1].pub || locs[locs.length - 1].a != null;
  return { uid, headcode, toc, cat, locs };
}

const cifGetters = {
  tiploc: (l) => (l.tiploc_code || '').trim(),
  arr: (l) => l.arrival,
  dep: (l) => l.departure,
  pass: (l) => l.pass,
  pubArr: (l) => l.public_arrival && l.public_arrival !== '0000' ? l.public_arrival : null,
  pubDep: (l) => l.public_departure && l.public_departure !== '0000' ? l.public_departure : null,
  plat: (l) => l.platform,
};

const vstpGetters = {
  tiploc: (l) => (l.location?.tiploc?.tiploc_id || '').trim(),
  arr: (l) => l.scheduled_arrival_time,
  dep: (l) => l.scheduled_departure_time,
  pass: (l) => l.scheduled_pass_time,
  pubArr: (l) => (l.public_arrival_time || '').trim() && l.public_arrival_time !== '000000' ? l.public_arrival_time : null,
  pubDep: (l) =>
    (l.public_departure_time || '').trim() && l.public_departure_time !== '000000' ? l.public_departure_time : null,
  plat: (l) => l.CIF_platform,
};

function touchesLondon(rec) {
  return rec.locs.some((l) => ref.london.has(l.t));
}

function runsOn(c, date) {
  return c.start <= date && date <= c.end && c.days[weekdayIndex(date)] === '1';
}

function indexRun(key, run) {
  sched.runs.set(key, run);
  let set = sched.byHeadcode.get(run.headcode);
  if (!set) sched.byHeadcode.set(run.headcode, (set = new Set()));
  set.add(key);
}

function removeRun(key) {
  const run = sched.runs.get(key);
  if (!run) return;
  sched.runs.delete(key);
  sched.byHeadcode.get(run.headcode)?.delete(key);
}

function makeRun(rec, date) {
  return { ...rec, date, base: londonEpoch(date, 0) };
}

/** Parse the daily full schedule file (JSON lines, possibly gzipped). */
export async function loadSchedule(file, now = Date.now()) {
  const today = londonDateStr(now);
  const window = [addDays(today, -1), today, addDays(today, 1)];
  const lo = window[0];
  const hi = window[2];

  const candidates = new Map(); // uid → [candidate]
  let finalised = false;
  let seen = 0;

  for await (const line of lines(file)) {
    if (!line) continue;
    if (line.startsWith('{"TiplocV1"')) {
      addTiploc(JSON.parse(line).TiplocV1);
      continue;
    }
    if (!line.startsWith('{"JsonScheduleV1"')) continue;
    if (!finalised) {
      finaliseTiplocs();
      computeLondon(config.londonBox);
      finalised = true;
    }
    const s = JSON.parse(line).JsonScheduleV1;
    seen++;
    if (s.transaction_type && s.transaction_type !== 'Create') continue;
    const start = s.schedule_start_date;
    const end = s.schedule_end_date || start;
    if (end < lo || start > hi) continue;
    const uid = s.CIF_train_uid;
    const stp = s.CIF_stp_indicator;
    const c = { stp, start, end, days: s.schedule_days_runs || '1111111', rec: null };
    if (stp !== 'C') {
      const seg = s.schedule_segment || {};
      const cat = seg.CIF_train_category;
      if (PASSENGER_STATUS.has(s.train_status) && PASSENGER_CATS.has(cat)) {
        const rec = compact(
          uid,
          seg.signalling_id || seg.CIF_headcode || '',
          s.atoc_code || 'ZZ',
          cat,
          seg.schedule_location || [],
          cifGetters,
        );
        if (rec && touchesLondon(rec)) c.rec = rec;
      }
    }
    const list = candidates.get(uid);
    if (list) list.push(c);
    else candidates.set(uid, [c]);
  }
  if (!finalised) {
    finaliseTiplocs();
    computeLondon(config.londonBox);
  }

  // Resolve short-term-planning overlays: C beats O/N beats P.
  const newRuns = new Map();
  for (const [uid, list] of candidates) {
    for (const date of window) {
      let best = null;
      for (const c of list) {
        if (!runsOn(c, date)) continue;
        if (!best || STP_RANK[c.stp] > STP_RANK[best.stp]) best = c;
      }
      if (best && best.stp !== 'C' && best.rec) newRuns.set(`${uid}|${date}`, makeRun(best.rec, date));
    }
  }

  // Keep same-day VSTP runs we already know about.
  for (const [key, run] of sched.runs) if (run.vstp && !newRuns.has(key)) newRuns.set(key, run);

  sched.runs.clear();
  sched.byHeadcode.clear();
  for (const [k, r] of newRuns) indexRun(k, r);
  sched.loadedAt = Date.now();
  sched.windowDates = window;
  console.log(`[schedule] ${seen} schedules read; ${sched.runs.size} London passenger runs for ${window.join(', ')}`);
}

/** VSTP: very-short-notice schedules created or deleted during the day. */
export function applyVstp(msg) {
  const s = msg?.VSTPCIFMsgV1?.schedule;
  if (!s) return;
  const uid = s.CIF_train_uid;
  const start = s.schedule_start_date;
  const end = s.schedule_end_date || start;
  const dates = sched.windowDates.length ? sched.windowDates : [londonDateStr(Date.now())];
  const c = { start, end, days: s.schedule_days_runs || '1111111' };

  if (s.transaction_type === 'Delete' || s.CIF_stp_indicator === 'C') {
    for (const date of dates) if (runsOn(c, date)) removeRun(`${uid}|${date}`);
    return;
  }
  const seg = Array.isArray(s.schedule_segment) ? s.schedule_segment[0] : s.schedule_segment;
  if (!seg) return;
  const cat = seg.CIF_train_category;
  if (!PASSENGER_STATUS.has(s.train_status) || !PASSENGER_CATS.has(cat)) return;
  const rec = compact(
    uid,
    seg.signalling_id || seg.CIF_headcode || '',
    s.atoc_code || seg.atoc_code || 'ZZ',
    cat,
    seg.schedule_location || [],
    vstpGetters,
  );
  if (!rec || !touchesLondon(rec)) return;
  for (const date of dates) {
    if (!runsOn(c, date)) continue;
    const key = `${uid}|${date}`;
    removeRun(key);
    indexRun(key, { ...makeRun(rec, date), vstp: true });
  }
}

/** Minutes → epoch for a run. */
export function runEpoch(run, minutes) {
  return run.base + minutes * 60000;
}

export function timeIn(l) {
  return l.a ?? l.p ?? l.d;
}
export function timeOut(l) {
  return l.d ?? l.p ?? l.a;
}

/** Test helper: add a run directly. */
export function _addRunForTest(rec, date) {
  indexRun(`${rec.uid}|${date}`, makeRun(rec, date));
}
