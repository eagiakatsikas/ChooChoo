// Eurostar beyond the Channel Tunnel. Network Rail's data stops at the tunnel, so for the
// rest of the journey (to Paris, Brussels, Amsterdam…) we use Eurostar's own open data:
// its timetable (GTFS, refreshed daily) and its live delays (GTFS Realtime trip updates),
// both published on France's open data portal. Trains are placed between stations from the
// timetable plus the live delay, following the high-speed lines where we have them.
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import GtfsRealtime from 'gtfs-realtime-bindings';
import { config } from './config.js';
import { download } from './download.js';
import { pathFor, stationPoint, getPaths } from './tracks.js';
import { hhmm } from './time.js';

const { transit_realtime: rt } = GtfsRealtime;
const RT_EVERY_MS = 60000;
// The UK end is covered by Network Rail; show Eurostar's own data only east of the tunnel portal
const UK_EAST_LIMIT = 1.2;

export const euroState = { trips: 0, active: 0, loadedAt: null, rtAt: null, error: null, rtError: null };

let stops = new Map(); // stop_id → { id, name, lat, lng }
let trips = new Map(); // "trip_id|date" → { id, tripId, num, dest, stops: [{ s, a, d }] }
const live = new Map(); // trip_id → { delays: [sec per stop], cancelled }
let tz = 'Europe/Paris';

// ---------- GTFS (timetable) ----------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const head = (rows.shift() || []).map((h) => h.trim().replace(/^﻿/, ''));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

function tzOffsetMs(zone, utcMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(utcMs)
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - utcMs;
}

/** GTFS times count from "noon minus 12 hours" on the service day, in the agency's time zone. */
export function serviceEpoch(date, secs, zone = tz) {
  const y = +date.slice(0, 4), m = +date.slice(4, 6), d = +date.slice(6, 8);
  const noon = Date.UTC(y, m - 1, d, 12);
  return noon - tzOffsetMs(zone, noon) - 12 * 3600000 + secs * 1000;
}

const secsOf = (t) => {
  const m = /^(\d+):(\d\d):(\d\d)$/.exec(t || '');
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
};

function dateIn(zone, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}

/** Build today's (and late last night's) Eurostar trips from the GTFS files. */
export function loadGtfs(files, now = Date.now()) {
  const get = (name) => (files[name] ? parseCsv(strFromU8(files[name])) : []);
  const agency = get('agency.txt');
  if (agency[0]?.agency_timezone) tz = agency[0].agency_timezone;
  const newStops = new Map();
  for (const s of get('stops.txt')) {
    const lat = Number(s.stop_lat), lng = Number(s.stop_lon);
    if (!lat || !lng) continue;
    newStops.set(s.stop_id, { id: s.stop_id, name: s.stop_name, lat, lng, parent: s.parent_station || null });
  }
  const days = [dateIn(tz, now - 86400000), dateIn(tz, now)];
  const weekday = (date) => ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay()];
  const runsOn = new Map(); // service_id → Set(dates)
  for (const c of get('calendar.txt')) {
    for (const d of days) if (c.start_date <= d && d <= c.end_date && c[weekday(d)] === '1') (runsOn.get(c.service_id) || runsOn.set(c.service_id, new Set()).get(c.service_id)).add(d);
  }
  for (const c of get('calendar_dates.txt')) {
    if (!days.includes(c.date)) continue;
    const set = runsOn.get(c.service_id) || runsOn.set(c.service_id, new Set()).get(c.service_id);
    if (c.exception_type === '1') set.add(c.date);
    else if (c.exception_type === '2') set.delete(c.date);
  }
  const tripInfo = new Map();
  for (const t of get('trips.txt')) {
    const dates = runsOn.get(t.service_id);
    if (!dates || !dates.size) continue;
    tripInfo.set(t.trip_id, { dates: [...dates], num: t.trip_short_name || (t.trip_headsign || '').match(/\d{4}/)?.[0] || t.trip_id, head: t.trip_headsign || '' });
  }
  const times = new Map(); // trip_id → [{ seq, s, a, d }]
  for (const st of get('stop_times.txt')) {
    if (!tripInfo.has(st.trip_id)) continue;
    const list = times.get(st.trip_id) || times.set(st.trip_id, []).get(st.trip_id);
    list.push({ seq: Number(st.stop_sequence), s: st.stop_id, a: secsOf(st.arrival_time), d: secsOf(st.departure_time) });
  }
  const newTrips = new Map();
  for (const [tripId, info] of tripInfo) {
    const list = (times.get(tripId) || []).sort((x, y) => x.seq - y.seq);
    if (list.length < 2) continue;
    for (const date of info.dates) {
      const sts = list.map((x) => ({
        s: x.s,
        seq: x.seq,
        a: x.a != null ? serviceEpoch(date, x.a) : null,
        d: x.d != null ? serviceEpoch(date, x.d) : null,
      }));
      const last = sts[sts.length - 1];
      newTrips.set(`${tripId}|${date}`, { id: `${tripId}|${date}`, tripId, date, num: info.num, dest: newStops.get(last.s)?.name || info.head, stops: sts });
    }
  }
  stops = newStops;
  trips = newTrips;
  euroState.trips = trips.size;
  euroState.loadedAt = now;
  return { stops: stops.size, trips: trips.size };
}

async function refreshGtfs() {
  try {
    const file = await download(config.eurostarGtfsUrl, 'eurostar-gtfs.zip', { maxAgeHours: 20 });
    if (!file) throw new Error('Eurostar timetable download failed');
    const r = loadGtfs(unzipSync(new Uint8Array(fs.readFileSync(file))));
    console.log(`[eurostar] ${r.trips} trips, ${r.stops} stops`);
    euroState.error = null;
  } catch (err) {
    euroState.error = err.message;
    console.error('[eurostar]', err.message);
  }
}

// ---------- GTFS Realtime (live delays) ----------

const num = (x) => (x == null ? null : typeof x === 'object' && typeof x.toNumber === 'function' ? x.toNumber() : Number(x));

/** Fold a decoded FeedMessage into the live delays. Exported for tests. */
export function ingestRealtime(feed) {
  for (const e of feed.entity || []) {
    const tu = e.tripUpdate;
    if (!tu || !tu.trip) continue;
    const tripId = tu.trip.tripId;
    const date = tu.trip.startDate;
    const cands = [...trips.values()].filter((t) => t.tripId === tripId && (!date || t.date === date));
    for (const t of cands) {
      const rec = { delays: new Array(t.stops.length).fill(null), cancelled: tu.trip.scheduleRelationship === rt.TripDescriptor.ScheduleRelationship.CANCELED };
      for (const u of tu.stopTimeUpdate || []) {
        let i = -1;
        if (u.stopId) i = t.stops.findIndex((s) => s.s === u.stopId);
        if (i < 0 && u.stopSequence != null) i = t.stops.findIndex((s) => s.seq === Number(u.stopSequence));
        if (i < 0) continue;
        const ev = u.departure || u.arrival;
        let delay = ev && ev.delay != null ? num(ev.delay) : null;
        if (delay == null && ev && ev.time != null) {
          const sched = u.departure ? t.stops[i].d ?? t.stops[i].a : t.stops[i].a ?? t.stops[i].d;
          if (sched != null) delay = Math.round(num(ev.time) - sched / 1000);
        }
        if (delay != null) rec.delays[i] = delay;
      }
      // Carry the latest known delay forward to later stops
      let last = null;
      for (let i = 0; i < rec.delays.length; i++) {
        if (rec.delays[i] != null) last = rec.delays[i];
        else rec.delays[i] = last;
      }
      live.set(t.id, rec);
    }
  }
}

async function pollRealtime() {
  try {
    const res = await fetch(config.eurostarRtUrl, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feed = rt.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
    ingestRealtime(feed);
    euroState.rtAt = Date.now();
    euroState.rtError = null;
  } catch (err) {
    euroState.rtError = err.message;
  }
}

// ---------- Where each train is ----------

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const inUK = (s) => s.lng < UK_EAST_LIMIT && s.lat > 50.95;

function estimated(t) {
  const rec = live.get(t.id);
  return t.stops.map((s, i) => {
    const dl = (rec && rec.delays[i]) || 0;
    return { ...s, ea: s.a != null ? s.a + dl * 1000 : null, ed: s.d != null ? s.d + dl * 1000 : null, dl };
  });
}

/** Map views for Eurostars currently on the continental side, shaped like train views. */
export function euroViews(now = Date.now()) {
  const out = [];
  for (const t of trips.values()) {
    const first = t.stops[0], last = t.stops[t.stops.length - 1];
    if ((first.d ?? first.a) > now + 2 * 3600000 || (last.a ?? last.d) < now - 3 * 3600000) continue;
    const rec = live.get(t.id);
    if (rec && rec.cancelled) continue;
    const st = estimated(t);
    const lastE = st[st.length - 1];
    if (now > (lastE.ea ?? lastE.ed) + 3 * 60000 || now < (st[0].ed ?? st[0].ea) - 5 * 60000) continue;
    const name = (k) => stops.get(st[k].s)?.name || st[k].s;
    const coord = (k) => stops.get(st[k].s);
    const v = { id: `es:${t.id}`, hc: t.num, toc: 'ES', op: 'Eurostar', o: name(0), d: t.dest, dep: hhmm(st[0].d ?? st[0].a), dl: Math.round((st.find((s) => s.ed >= now || s.ea >= now)?.dl || 0) / 60), src: 'eurostar', up: euroState.rtAt || euroState.loadedAt };
    let placed = false;
    for (let k = 0; k < st.length && !placed; k++) {
      const c = coord(k);
      if (!c) continue;
      const arr = st[k].ea ?? st[k].ed;
      const dep = st[k].ed ?? st[k].ea;
      if (now >= arr && now <= dep) {
        if (inUK(c)) break; // at a UK station: Network Rail shows this train
        const p = stationPoint(`ES:${st[k].s}`, c);
        Object.assign(v, { st: k === st.length - 1 ? 'end' : 'at', p: [r5(p.lat), r5(p.lng)], at: name(k) });
        placed = true;
      } else if (k < st.length - 1 && now > dep && now < (st[k + 1].ea ?? st[k + 1].ed)) {
        const c2 = coord(k + 1);
        if (!c2) break;
        const t0 = dep, t1 = st[k + 1].ea ?? st[k + 1].ed;
        const f = (now - t0) / (t1 - t0 || 1);
        if (c.lng + (c2.lng - c.lng) * f < UK_EAST_LIMIT && inUK(c)) break; // still on the UK side
        const pa = stationPoint(`ES:${st[k].s}`, c), pb = stationPoint(`ES:${st[k + 1].s}`, c2);
        Object.assign(v, { st: 'mv', seg: [r5(pa.lat), r5(pa.lng), r5(pb.lat), r5(pb.lng), Math.round(t0), Math.round(t1)], at: name(k), nx: name(k + 1), nxt: hhmm(t1) });
        const pr = pathFor(`ES:${st[k].s}`, c, `ES:${st[k + 1].s}`, c2);
        if (pr) {
          v.pk = pr.key;
          v.rv = pr.rev;
        }
        placed = true;
      }
    }
    if (placed) out.push(v);
  }
  euroState.active = out.length;
  return out;
}

/** The train panel for a Eurostar: all its stops, with expected times. */
export function euroDetail(id, now = Date.now()) {
  const t = trips.get(id.replace(/^es:/, ''));
  if (!t) return null;
  const st = estimated(t);
  let cur = st.findIndex((s) => (s.ed ?? s.ea) >= now);
  if (cur < 0) cur = st.length - 1;
  const path = [];
  for (let k = 0; k < st.length; k++) {
    const c = stops.get(st[k].s);
    if (!c) continue;
    if (k > 0) {
      const prev = stops.get(st[k - 1].s);
      const pr = prev && pathFor(`ES:${st[k - 1].s}`, prev, `ES:${st[k].s}`, c);
      const pts = pr && getPaths([pr.key])[pr.key];
      if (pts) path.push(...(pr.rev ? [...pts].reverse() : pts));
    }
    path.push([c.lat, c.lng]);
  }
  const stopsOut = st.map((s, k) => {
    const sched = s.d ?? s.a;
    const exp = s.ed ?? s.ea;
    const arr = s.ea ?? s.ed;
    return {
      n: stops.get(s.s)?.name || s.s,
      s: hhmm(sched),
      e: Math.abs(exp - sched) >= 60000 ? hhmm(exp) : null,
      done: (s.ed ?? s.ea) < now && k < cur,
      here: now >= arr && now <= exp,
    };
  });
  return { id: `es:${t.id}`, hc: t.num, op: 'Eurostar', toc: 'ES', stops: stopsOut, path, delay: Math.round((st[cur]?.dl || 0) / 60) };
}

export function startEurostar() {
  if (!config.eurostarGtfsUrl) return;
  refreshGtfs().then(pollRealtime);
  setInterval(refreshGtfs, 6 * 3600000); // picks up the new day's file (downloaded at most every 20 h)
  setInterval(pollRealtime, RT_EVERY_MS);
}
