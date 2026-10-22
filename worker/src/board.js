// Train finder: direct trains from one station to another, as a departures board.
//
// With a National Rail Live Departure Boards key (LDB_API_KEY) the board comes from the
// same service as the screens at stations: live platforms and expected times. Without a
// key it is built from the timetable plus Choo Choo's own live running data, with the
// timetabled (planned) platforms.
import { config } from './config.js';
import { ref } from './reference.js';
import { sched, runEpoch, timeIn, timeOut } from './schedule.js';
import { trains } from './trains.js';
import { hhmm } from './time.js';
import { operatorName } from './operators.js';

const WINDOW_MIN = 120; // look this far ahead
const CACHE_MS = 20000;
const cache = new Map(); // "FROM|TO" → { at, data }

export const ldbState = { configured: false, lastOk: null, lastError: null };

// Depots and sidings that have station codes but aren't somewhere you can catch a train
const NOT_PASSENGER = /\b(C\.\s?S\.?|Sidings?|Depot|T\.?M\.?D\.?|Carriage)\b/i;

let stationsJson = null;
let stationsCount = -1;

/** All passenger stations, compact, for search and "nearest station" in the app. */
export function stationList() {
  if (!stationsJson || stationsCount !== ref.stations.size) {
    const list = [...ref.stations.values()]
      .filter((s) => !NOT_PASSENGER.test(s.name))
      .map((s) => ({ c: s.crs, n: s.name, la: Math.round(s.lat * 1e5) / 1e5, lo: Math.round(s.lng * 1e5) / 1e5 }))
      .sort((a, b) => a.n.localeCompare(b.n));
    stationsJson = JSON.stringify(list);
    stationsCount = ref.stations.size;
  }
  return stationsJson;
}

const mins = (s) => {
  if (!/^\d\d:\d\d$/.test(s || '')) return null;
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
};
/** Minutes from a to b on a 24h clock, assuming b is within 12h after a. */
const diff = (a, b) => {
  if (a == null || b == null) return null;
  let d = b - a;
  if (d < -720) d += 1440;
  return d;
};

function markBest(rows, nowMin) {
  let best = null;
  for (const r of rows) {
    if (r.cancelled) continue;
    const dep = mins(r.etdTime || r.std);
    if (dep != null && diff(nowMin, dep) < -1) continue; // already gone
    const arr = mins(r.etaTime || r.sta);
    if (arr == null) continue;
    const a = diff(nowMin, arr);
    if (!best || a < best.a || (a === best.a && diff(nowMin, dep) < best.d)) best = { r, a, d: diff(nowMin, dep) };
  }
  if (best) best.r.best = true;
  return rows;
}

// ---------- Built from the timetable + live running data ----------

function timetableBoard(from, to, now) {
  const A = ref.stations.get(from);
  const B = to ? ref.stations.get(to) : null; // no destination: every departure
  if (!A || (to && !B)) return null;
  const rows = [];
  for (const [key, run] of sched.runs) {
    const locs = run.locs;
    let i = -1;
    for (let k = 0; k < locs.length - 1; k++) {
      if (A.tiplocs.has(locs[k].t) && locs[k].d != null && locs[k].pub) {
        i = k;
        break;
      }
    }
    if (i < 0) continue;
    let j = -1;
    if (B) {
      for (let k = i + 1; k < locs.length; k++) {
        if (B.tiplocs.has(locs[k].t) && locs[k].a != null && locs[k].pub) {
          j = k;
          break;
        }
      }
      if (j < 0) continue;
    } else j = locs.length - 1;
    const depAt = runEpoch(run, locs[i].d);
    if (depAt < now - 60000 || depAt > now + WINDOW_MIN * 60000) continue;

    const t = trains.get(key);
    let delay = 0;
    let plat = locs[i].plat || '';
    let platLive = false;
    if (t) {
      // Already left this station? Then it's not on the board.
      if (t.idx > i || (t.idx === i && t.state !== 'pending' && t.state !== 'arr')) continue;
      delay = Math.max(0, t.delay || 0);
      if (t.idx === i && t.state === 'arr' && t.platform) {
        plat = t.platform;
        platLive = true;
      }
    }
    const arrAt = runEpoch(run, locs[j].a);
    rows.push({
      id: key,
      hc: run.headcode,
      toc: run.toc,
      op: operatorName(run.toc),
      dest: ref.coords.get(locs[locs.length - 1].t)?.name || locs[locs.length - 1].t,
      std: hhmm(depAt),
      etd: delay ? hhmm(depAt + delay * 60000) : 'On time',
      etdTime: delay ? hhmm(depAt + delay * 60000) : null,
      plat,
      platLive,
      sta: B ? hhmm(arrAt) : '',
      eta: B ? (delay ? hhmm(arrAt + delay * 60000) : 'On time') : '',
      etaTime: B && delay ? hhmm(arrAt + delay * 60000) : null,
      mins: B ? Math.round((arrAt - depAt) / 60000) : null,
      stops: B ? locs.slice(i + 1, j).filter((l) => l.pub).length : null,
      coaches: null,
      _dep: depAt,
    });
  }
  rows.sort((a, b) => a._dep - b._dep);
  for (const r of rows) delete r._dep;
  return rows.slice(0, B ? 12 : 20);
}

// ---------- National Rail Live Departure Boards ----------

const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

/** Find Choo Choo's own run for a National Rail service, so it can be shown on the map. */
function matchRuns(from, rows) {
  const A = ref.stations.get(from);
  if (!A || !rows.length) return;
  const want = new Map(rows.map((r) => [`${r.std}|${r.toc}`, r]));
  for (const [key, run] of sched.runs) {
    for (const l of run.locs) {
      if (!A.tiplocs.has(l.t) || l.d == null) continue;
      const r = want.get(`${hhmm(runEpoch(run, l.d))}|${run.toc}`);
      if (r && !r.id && Math.abs(runEpoch(run, l.d) - Date.now()) < 4 * 3600000) {
        r.id = key;
        r.hc = run.headcode;
      }
      break;
    }
  }
}

async function ldbBoard(from, to) {
  const filter = to ? `&filterCrs=${encodeURIComponent(to)}&filterType=to` : '';
  const url = `${config.ldbUrl}/GetDepBoardWithDetails/${encodeURIComponent(from)}?numRows=${to ? 12 : 20}${filter}&timeWindow=${WINDOW_MIN}`;
  const res = await fetch(url, { headers: { 'x-apikey': config.ldbKey, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`National Rail board: HTTP ${res.status}`);
  const data = await res.json();
  const rows = [];
  for (const s of arr(data.trainServices)) {
    const cps = arr(s.subsequentCallingPoints).flatMap((g) => arr(g.callingPoint));
    const cp = to ? cps.find((c) => c.crs === to) : null;
    const etd = s.etd || '';
    const eta = cp?.et || cp?.at || '';
    const cancelled = Boolean(s.isCancelled) || /cancel/i.test(etd) || Boolean(cp?.isCancelled);
    rows.push({
      id: null,
      hc: null,
      toc: s.operatorCode || '',
      op: s.operator || operatorName(s.operatorCode),
      dest: arr(s.destination).map((d) => d.locationName).join(' & ') || '',
      std: s.std,
      etd,
      etdTime: /^\d\d:\d\d$/.test(etd) ? etd : null,
      plat: s.platform || '',
      platLive: Boolean(s.platform),
      sta: cp?.st || '',
      eta,
      etaTime: /^\d\d:\d\d$/.test(eta) ? eta : null,
      mins: diff(mins(s.std), mins(cp?.st)),
      stops: cp ? cps.indexOf(cp) : null,
      coaches: Number(s.length) || null, // train length, when the station knows it
      cancelled,
      reason: s.cancelReason || s.delayReason || undefined,
    });
  }
  matchRuns(from, rows);
  return { rows, messages: arr(data.nrccMessages).map((m) => String(m.Value || m.value || m).replace(/<[^>]+>/g, '')).slice(0, 2) };
}

export async function board(from, to) {
  from = String(from || '').toUpperCase();
  to = String(to || '').toUpperCase();
  if (!ref.stations.has(from) || (to && !ref.stations.has(to))) return { error: 'Unknown station' };
  if (from === to) return { error: 'Choose two different stations' };
  const k = `${from}|${to}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const now = Date.now();
  const nowMin = mins(hhmm(now));
  let data;
  ldbState.configured = Boolean(config.ldbKey);
  if (config.ldbKey) {
    try {
      const r = await ldbBoard(from, to);
      data = { source: 'national-rail', rows: to ? markBest(r.rows, nowMin) : r.rows, messages: r.messages };
      ldbState.lastOk = now;
      ldbState.lastError = null;
    } catch (err) {
      ldbState.lastError = err.message;
      console.error('[board]', err.message);
    }
  }
  if (!data) {
    const rows = timetableBoard(from, to, now);
    data = { source: 'timetable', rows: to ? markBest(rows || [], nowMin) : rows || [], messages: [] };
  }
  data.from = { crs: from, name: ref.stations.get(from).name };
  data.to = to ? { crs: to, name: ref.stations.get(to).name } : null;
  data.generated = hhmm(now);
  cache.set(k, { at: now, data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}
