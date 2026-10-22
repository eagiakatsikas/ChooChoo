// Ding Ding: London buses from TfL's open data.
//
// TfL doesn't publish bus GPS positions. It does publish, for every bus, predicted arrival
// times at its upcoming stops. Each bus is placed on its route between the stop it last
// left and the stop it's due at next, using how long until it gets there.
//
// Route shapes and stop lists are downloaded once a week (about 1,400 requests, paced).
// Live predictions are only fetched for routes someone is looking at: favourite routes,
// and routes passing through a zoomed-in map view. That keeps the load small.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { simplify } from './tracks.js';
import { hhmm } from './time.js';

const ROUTES_FILE = 'bus-routes.json';
const ROUTES_VERSION = 1;
const ROUTES_MAX_AGE = 7 * 24 * 3600000;
const SPEED = 4.2; // m/s: typical London bus speed including stops (~15 km/h)
const STOP_MATCH_M = 120; // a stop further than this from the route line isn't placed on it
const ACTIVE_MS = 3 * 60000; // a route stays polled this long after it was last asked for
const POLL_MS = 30000; // how often live predictions are refreshed for active routes
const LINES_PER_CALL = 8;
const GAP_MS = 160; // between TfL requests: at most ~375 a minute, under the 500 limit

const RAD = Math.PI / 180;
const KX = Math.cos(51.5 * RAD) * 111320;
const KY = 110574;

export const busState = {
  configured: false,
  routes: 0,
  loadingRoutes: false,
  routesLoadedAt: null,
  vehicles: 0,
  activeRoutes: 0,
  lastPoll: null,
  lastError: null,
  requests: 0,
};

/** lineId → { id, name, ends: [from, to], dirs: { outbound, inbound }, box: [s,w,n,e] } */
export const lines = new Map();
/** vehicleId → { id, line, dir, dest, preds: [[naptanId, epochMs], …] sorted, seen } */
export const vehicles = new Map();
const wanted = new Map(); // lineId → last asked for (ms)
const polledAt = new Map(); // lineId → last polled (ms)

// ---------- TfL requests, paced ----------

let lastReq = 0;
let chain = Promise.resolve();
function tfl(p) {
  const run = async () => {
    const wait = lastReq + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReq = Date.now();
    busState.requests++;
    const url = `${config.tflUrl}${p}${p.includes('?') ? '&' : '?'}app_key=${encodeURIComponent(config.tflKey)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429) {
      lastReq = Date.now() + 30000; // told to slow down: pause
      throw new Error('TfL: too many requests (429)');
    }
    if (!res.ok) throw new Error(`TfL ${p.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  };
  const p2 = chain.then(run, run);
  chain = p2.catch(() => {});
  return p2;
}

// ---------- Route shapes ----------

const metres = (a, b) => Math.hypot((b[1] - a[1]) * KX, (b[0] - a[0]) * KY);

function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(pts[i - 1], pts[i]));
  return cum;
}

/** Nearest point on the path to p, searching segments from `from` onwards. */
function project(pts, cum, p, from = 0) {
  let best = { d: Infinity, along: 0, seg: from };
  const px = p[1] * KX, py = p[0] * KY;
  for (let i = from; i < pts.length - 1; i++) {
    const ax = pts[i][1] * KX, ay = pts[i][0] * KY;
    const dx = pts[i + 1][1] * KX - ax, dy = pts[i + 1][0] * KY - ay;
    const len2 = dx * dx + dy * dy || 1;
    let u = ((px - ax) * dx + (py - ay) * dy) / len2;
    u = Math.max(0, Math.min(1, u));
    const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
    if (d < best.d) best = { d, along: cum[i] + u * (cum[i + 1] - cum[i]), seg: i };
  }
  return best;
}

/**
 * Turn TfL's Route/Sequence reply for one direction into what we need:
 * the route line (simplified), and its stops in order with how far along the line each is.
 */
export function compactSequence(seq) {
  // The main line: the longest of the line strings (others are short branches)
  let pts = [];
  for (const s of seq.lineStrings || []) {
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch {
      continue;
    }
    for (const part of parsed) {
      const p = part.map(([lng, lat]) => [lat, lng]);
      if (p.length > pts.length) pts = p;
    }
  }
  // The main stop sequence: the longest branch
  let main = [];
  for (const b of seq.stopPointSequences || []) if ((b.stopPoint || []).length > main.length) main = b.stopPoint;
  if (pts.length < 2 || main.length < 2) return null;
  pts = simplify(pts, 6).map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
  // Line drawn the other way round from the stops? Turn it round.
  const first = [main[0].lat, main[0].lon];
  const last = [main[main.length - 1].lat, main[main.length - 1].lon];
  if (metres(first, pts[0]) + metres(last, pts[pts.length - 1]) > metres(first, pts[pts.length - 1]) + metres(last, pts[0])) pts.reverse();
  const cum = cumulative(pts);
  const stops = [];
  let seg = 0;
  for (const sp of main) {
    const p = [sp.lat, sp.lon];
    const pr = project(pts, cum, p, seg);
    const on = pr.d <= STOP_MATCH_M;
    if (on) seg = pr.seg;
    stops.push([sp.id, sp.name + (sp.stopLetter && !/^->/.test(sp.stopLetter) ? ` (${sp.stopLetter})` : ''), Math.round(sp.lat * 1e5) / 1e5, Math.round(sp.lon * 1e5) / 1e5, on ? Math.round(pr.along) : -1]);
  }
  return { pts, stops };
}

function prepDir(c) {
  if (!c) return null;
  const cum = cumulative(c.pts);
  const index = new Map(c.stops.map((s, i) => [s[0], i]));
  return { pts: c.pts, cum, total: cum[cum.length - 1], stops: c.stops, index };
}

function boxOf(dirs) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const d of Object.values(dirs)) {
    if (!d) continue;
    for (const [la, lo] of d.pts) {
      if (la < s) s = la;
      if (la > n) n = la;
      if (lo < w) w = lo;
      if (lo > e) e = lo;
    }
  }
  return [s, w, n, e];
}

export function addLine(id, name, raw) {
  const dirs = { outbound: prepDir(raw.outbound), inbound: prepDir(raw.inbound) };
  if (!dirs.outbound && !dirs.inbound) return;
  const d = dirs.outbound || dirs.inbound;
  const ends = [d.stops[0][1], d.stops[d.stops.length - 1][1]].map((s) => s.replace(/ \([^)]*\)$/, ''));
  lines.set(id, { id, name, ends, dirs, box: boxOf(dirs) });
}

function routesPath() {
  return path.join(config.dataDir, ROUTES_FILE);
}

async function downloadRoutes() {
  busState.loadingRoutes = true;
  const list = await tfl('/Line/Mode/bus');
  const out = [];
  let n = 0;
  for (const l of list) {
    const raw = {};
    for (const dir of ['outbound', 'inbound']) {
      try {
        raw[dir] = compactSequence(await tfl(`/Line/${encodeURIComponent(l.id)}/Route/Sequence/${dir}`));
      } catch (err) {
        busState.lastError = err.message;
      }
    }
    if (raw.outbound || raw.inbound) {
      out.push({ id: l.id, name: l.name, raw });
      addLine(l.id, l.name, raw); // usable straight away, before the whole set is in
      busState.routes = lines.size;
    }
    if (++n % 100 === 0) console.log(`[buses] routes ${n}/${list.length}`);
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(routesPath(), JSON.stringify({ v: ROUTES_VERSION, at: Date.now(), lines: out }));
  busState.loadingRoutes = false;
  busState.routesLoadedAt = Date.now();
  console.log(`[buses] ${lines.size} routes saved`);
}

export async function loadRoutes() {
  try {
    const data = JSON.parse(fs.readFileSync(routesPath(), 'utf8'));
    if (data.v === ROUTES_VERSION) {
      for (const l of data.lines) addLine(l.id, l.name, l.raw);
      busState.routes = lines.size;
      busState.routesLoadedAt = data.at;
      console.log(`[buses] ${lines.size} routes from cache`);
      if (Date.now() - data.at < ROUTES_MAX_AGE) return;
    }
  } catch {}
  try {
    await downloadRoutes();
  } catch (err) {
    busState.loadingRoutes = false;
    busState.lastError = err.message;
    console.error('[buses] route download failed:', err.message);
  }
}

// ---------- Live predictions ----------

/** Fold TfL arrival predictions into the vehicle list. */
export function ingestArrivals(list, lineIds, now = Date.now()) {
  const seen = new Set();
  const fresh = new Map();
  for (const a of list) {
    if (!a.vehicleId || !a.naptanId) continue;
    const t = Date.parse(a.expectedArrival);
    if (!t) continue;
    let v = fresh.get(a.vehicleId);
    if (!v) {
      v = { id: a.vehicleId, line: a.lineId, name: a.lineName, dir: a.direction, dest: a.destinationName, preds: [], seen: now };
      fresh.set(a.vehicleId, v);
    }
    v.preds.push([a.naptanId, t]);
    if (!v.dir && a.direction) v.dir = a.direction;
    seen.add(a.vehicleId);
  }
  for (const v of fresh.values()) {
    v.preds.sort((x, y) => x[1] - y[1]);
    const l = lines.get(v.line);
    // Direction missing or unknown? Use the one whose stop list has this bus's next stop.
    if (l && !(l.dirs[v.dir] && l.dirs[v.dir].index.has(v.preds[0][0]))) {
      for (const k of ['outbound', 'inbound']) if (l.dirs[k] && l.dirs[k].index.has(v.preds[0][0])) v.dir = k;
    }
    vehicles.set(v.id, v);
  }
  // Buses on these routes that have dropped out of the predictions have finished
  const set = new Set(lineIds);
  for (const [id, v] of vehicles) if (set.has(v.line) && !seen.has(id)) vehicles.delete(id);
  busState.vehicles = vehicles.size;
}

/**
 * How fast this bus is going right now, in m/s. TfL's predictions already reflect live
 * traffic (they come from where its buses actually are), so the time it's predicted to take
 * between its next few stops tells us its speed: quick on a clear road, slow in traffic.
 */
export function busSpeed(v, d, k) {
  if (!d) return SPEED;
  let dist = 0;
  let time = 0;
  for (let j = k; j < Math.min(v.preds.length - 1, k + 4); j++) {
    const a = d.index.get(v.preds[j][0]);
    const b = d.index.get(v.preds[j + 1][0]);
    if (a == null || b == null || b <= a) break;
    const da = d.stops[a][4];
    const db = d.stops[b][4];
    if (da < 0 || db < 0 || db <= da) break;
    dist += db - da;
    time += (v.preds[j + 1][1] - v.preds[j][1]) / 1000;
  }
  if (dist < 150 || time < 20) return SPEED;
  return Math.max(1.5, Math.min(13, dist / time)); // between walking pace and 30 mph
}

/** Where a bus is now: on its route between the last stop and the next. */
export function placeBus(v, now = Date.now()) {
  const l = lines.get(v.line);
  const d = l && l.dirs[v.dir];
  // Next stop: the first prediction that isn't well in the past
  let k = 0;
  while (k < v.preds.length - 1 && v.preds[k][1] < now - 60000) k++;
  const [nextId, eta] = v.preds[k] || [];
  if (!nextId || eta < now - 5 * 60000) return null;
  if (!d || !d.index.has(nextId)) return null;
  const i = d.index.get(nextId);
  const s1 = d.stops[i];
  const s0 = i > 0 ? d.stops[i - 1] : null;
  const left = Math.max(0, (eta - now) / 1000) * busSpeed(v, d, k);
  const out = { next: s1, eta, prev: s0, i };
  if (s1[4] >= 0 && (!s0 || s0[4] >= 0)) {
    const lo = s0 ? s0[4] : Math.max(0, s1[4] - 600);
    const along = Math.max(lo, Math.min(s1[4], s1[4] - left));
    const p = pointAlong(d, along);
    return { ...out, la: p[0], lo: p[1], h: p[2] };
  }
  // Stops not on the route line: straight between them
  if (!s0) return { ...out, la: s1[2], lo: s1[3], h: null };
  const gap = metres([s0[2], s0[3]], [s1[2], s1[3]]) || 1;
  const f = Math.max(0, Math.min(1, 1 - left / gap));
  const h = Math.atan2((s1[3] - s0[3]) * KX, (s1[2] - s0[2]) * KY) / RAD;
  return { ...out, la: s0[2] + (s1[2] - s0[2]) * f, lo: s0[3] + (s1[3] - s0[3]) * f, h: Math.round(h) };
}

function pointAlong(d, along) {
  const { pts, cum } = d;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const u = (along - cum[lo]) / (cum[hi] - cum[lo] || 1);
  // Heading in degrees clockwise from north
  const h = Math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY) / RAD;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, Math.round(h)];
}

// ---------- What the map asks for ----------

const round5 = (x) => Math.round(x * 1e5) / 1e5;

function want(ids, now) {
  for (const id of ids) if (lines.has(id)) wanted.set(id, now);
}

/** Does the straight line a→b pass through the box? (Liang–Barsky clipping) */
function segmentInBox(a, b, s, w, n, e) {
  let t0 = 0, t1 = 1;
  const dy = b[0] - a[0], dx = b[1] - a[1];
  for (const [p, q] of [[-dx, a[1] - w], [dx, e - a[1]], [-dy, a[0] - s], [dy, n - a[0]]]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function linesInBox([s, w, n, e]) {
  const out = [];
  for (const l of lines.values()) {
    const [ls, lw, ln, le] = l.box;
    if (ls > n || ln < s || lw > e || le < w) continue;
    // Box overlaps: check the route really passes through
    let hit = false;
    for (const d of Object.values(l.dirs)) {
      if (!d || hit) continue;
      for (let i = 0; i < d.pts.length - 1 && !hit; i++) hit = segmentInBox(d.pts[i], d.pts[i + 1], s, w, n, e);
    }
    if (hit) out.push(l.id);
  }
  return out;
}

export function busView(v, now = Date.now()) {
  const p = placeBus(v, now);
  if (!p) return null;
  return {
    id: v.id,
    r: v.line,
    n: v.name || lines.get(v.line)?.name || v.line,
    d: v.dest || '',
    la: round5(p.la),
    lo: round5(p.lo),
    h: p.h,
    nx: p.next[1],
    m: Math.max(0, Math.round((p.eta - now) / 60000)),
  };
}

/**
 * Buses for the map: every bus on the given routes, plus (with a box) every bus in it.
 * Asking also keeps those routes' predictions fresh for the next few minutes.
 */
export function busesFor({ routes = [], box = null }, now = Date.now()) {
  const ids = new Set(routes.map((r) => String(r).toLowerCase()).filter((r) => lines.has(r)));
  let inBox = [];
  if (box && box.every(Number.isFinite) && box[2] - box[0] < 0.25 && box[3] - box[1] < 0.4) inBox = linesInBox(box);
  want([...ids, ...inBox], now);
  const all = new Set([...ids, ...inBox]);
  const out = [];
  for (const v of vehicles.values()) {
    if (!all.has(v.line)) continue;
    const b = busView(v, now);
    if (!b) continue;
    if (!ids.has(v.line) && box && (b.la < box[0] || b.la > box[2] || b.lo < box[1] || b.lo > box[3])) continue;
    out.push(b);
    if (out.length >= 2500) break;
  }
  const pending = [...all].filter((id) => !polledAt.has(id)).length;
  return { now, buses: out, pending, ready: lines.size > 0, configured: Boolean(config.tflKey) };
}

/** One bus: where it is and its next stops. */
export function busDetail(id, now = Date.now()) {
  const v = vehicles.get(id);
  if (!v) return null;
  const p = placeBus(v, now);
  const l = lines.get(v.line);
  const d = l && l.dirs[v.dir];
  const name = (sid) => (d && d.index.has(sid) ? d.stops[d.index.get(sid)][1] : sid);
  const stops = [];
  if (p && p.prev) stops.push({ n: p.prev[1], s: '', done: true });
  for (const [sid, t] of v.preds) {
    if (t < now - 60000) continue;
    stops.push({ n: name(sid), s: hhmm(t), m: Math.max(0, Math.round((t - now) / 60000)) });
  }
  return {
    id: v.id,
    r: v.line,
    n: v.name || l?.name || v.line,
    d: v.dest || '',
    ends: l?.ends || [],
    view: busView(v, now),
    stops,
    path: d ? d.pts : [],
    up: v.seen,
  };
}

/** Route numbers for search and favourites. */
export function routeList() {
  return [...lines.values()]
    .map((l) => ({ id: l.id, n: l.name, e: l.ends }))
    .sort((a, b) => a.n.localeCompare(b.n, 'en', { numeric: true }));
}

/** Route lines for drawing favourites on the map. */
export function routeShapes(ids) {
  const out = {};
  for (const id of ids.slice(0, 40)) {
    const l = lines.get(String(id).toLowerCase());
    if (l) out[l.id] = Object.values(l.dirs).filter(Boolean).map((d) => d.pts);
  }
  return out;
}

// ---------- Polling ----------

async function pollOnce() {
  const now = Date.now();
  for (const [id, at] of wanted) if (now - at > ACTIVE_MS) wanted.delete(id);
  busState.activeRoutes = wanted.size;
  // Routes never polled first, then the longest-waiting ones
  const due = [...wanted.keys()]
    .filter((id) => now - (polledAt.get(id) || 0) >= POLL_MS)
    .sort((a, b) => (polledAt.get(a) || 0) - (polledAt.get(b) || 0));
  for (let i = 0; i < due.length; i += LINES_PER_CALL) {
    const ids = due.slice(i, i + LINES_PER_CALL);
    try {
      const list = await tfl(`/Line/${ids.map(encodeURIComponent).join(',')}/Arrivals`);
      ingestArrivals(Array.isArray(list) ? list : [], ids);
      for (const id of ids) polledAt.set(id, Date.now());
      busState.lastPoll = Date.now();
      busState.lastError = null;
    } catch (err) {
      busState.lastError = err.message;
      console.error('[buses]', err.message);
    }
  }
  // Forget buses on routes nobody is looking at any more
  for (const [id, v] of vehicles) if (!wanted.has(v.line)) vehicles.delete(id);
  for (const id of polledAt.keys()) if (!wanted.has(id)) polledAt.delete(id);
  busState.vehicles = vehicles.size;
}

export async function startBuses() {
  busState.configured = Boolean(config.tflKey);
  if (!config.tflKey) {
    busState.lastError = 'Waiting for a TfL key: set TFL_APP_KEY (see README).';
    return;
  }
  loadRoutes(); // runs in the background; buses appear once their routes are in
  setInterval(loadRoutes, 24 * 3600000); // re-checks daily, downloads when a week old
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await pollOnce();
    } finally {
      busy = false;
    }
  }, 2000);
}
