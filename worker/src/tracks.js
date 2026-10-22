// Real track geometry from OpenStreetMap, so trains follow the rails between stations
// instead of cutting straight across.
//
// On start-up the worker downloads the railway lines in config.trackBox (once a week),
// builds a graph of track, and works out the route between each pair of stations a
// train runs between (shortest path along the rails). Routes are computed a few at a
// time in the background and cached on disk.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const RAIL_FILE = 'rail-osm.json';
const PATHS_FILE = 'rail-paths.json';
const RAIL_MAX_AGE_H = 24 * 7;
const SNAP_MAX_M = 400; // a station further than this from any track isn't snapped
const CELL = 0.005; // spatial index cell size in degrees (~350–550 m)

export const tracks = {
  ready: false,
  version: null,
  nodes: 0,
  computed: 0,
  failed: 0,
  error: null,
};

let lat = null; // Float64Array node latitudes
let lon = null;
let adjStart = null; // CSR adjacency
let adjTo = null;
let adjW = null;
let grid = null; // cellKey → node indices

/** "A|B" (sorted) → [[lat,lng],…] from the alphabetically-first location to the other, or null if no route */
const paths = new Map();
const queue = [];
const queued = new Set();
const snapped = new Map(); // tiploc → node index (or -1)

// ---------- geometry helpers ----------

const RAD = Math.PI / 180;
function metres(la1, lo1, la2, lo2) {
  const x = (lo2 - lo1) * Math.cos(((la1 + la2) / 2) * RAD) * 111320;
  const y = (la2 - la1) * 110574;
  return Math.hypot(x, y);
}

function inBox(la, lo) {
  const b = config.trackBox;
  return la >= b.s && la <= b.n && lo >= b.w && lo <= b.e;
}

/** Douglas–Peucker simplification of [[lat,lng],…] with a tolerance in metres. */
export function simplify(pts, tol = 8) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [la1, lo1] = pts[i];
    const [la2, lo2] = pts[j];
    const kx = Math.cos(((la1 + la2) / 2) * RAD) * 111320;
    const ky = 110574;
    const ax = lo1 * kx, ay = la1 * ky, bx = lo2 * kx, by = la2 * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let best = -1, bestD = tol;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k][1] * kx, py = pts[k][0] * ky;
      let u = ((px - ax) * dx + (py - ay) * dy) / len2;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

// ---------- loading ----------

function overpassQuery() {
  const b = config.trackBox;
  // Main-line railways and crossovers; not sidings, yards or the Underground.
  return `[out:json][timeout:300];
way["railway"~"^(rail|light_rail)$"]["service"!~"^(yard|siding|spur)$"](${b.s},${b.w},${b.n},${b.e});
out ids geom;`;
}

async function downloadRail(dest) {
  let lastErr = null;
  for (const url of config.overpassUrls) {
    try {
      console.log(`[tracks] downloading railway lines from ${url} …`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ChooChoo/1.0 (personal train map)' },
        body: 'data=' + encodeURIComponent(overpassQuery()),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Keep it compact: each way as a flat [lat,lon,lat,lon,…] list (6 decimal places)
      const ways = [];
      for (const el of json.elements || []) {
        if (el.type !== 'way' || !el.geometry) continue;
        const flat = [];
        for (const g of el.geometry) {
          if (!g) continue;
          flat.push(Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6);
        }
        if (flat.length >= 4) ways.push(flat);
      }
      if (ways.length < 100) throw new Error(`only ${ways.length} railway lines returned`);
      fs.writeFileSync(dest, JSON.stringify({ at: Date.now(), box: config.trackBox, ways }));
      console.log(`[tracks] saved ${ways.length} railway lines`);
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[tracks] ${url} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('no Overpass server configured');
}

/** Build the track graph from ways ([[lat,lon,lat,lon,…],…]). Exported for tests. */
export function buildGraph(ways) {
  const index = new Map();
  const la = [];
  const lo = [];
  const edges = []; // pairs a,b
  const id = (y, x) => {
    // numeric key (avoids millions of strings); exact for latitudes 40–60° and longitudes ±50°
    const k = (Math.round(y * 1e6) - 40e6) * 1e8 + (Math.round(x * 1e6) + 50e6);
    let i = index.get(k);
    if (i === undefined) {
      i = la.length;
      index.set(k, i);
      la.push(y);
      lo.push(x);
    }
    return i;
  };
  for (const w of ways) {
    let prev = id(w[0], w[1]);
    for (let k = 2; k < w.length; k += 2) {
      const cur = id(w[k], w[k + 1]);
      if (cur !== prev) edges.push(prev, cur);
      prev = cur;
    }
  }
  const n = la.length;
  lat = Float64Array.from(la);
  lon = Float64Array.from(lo);
  const deg = new Uint32Array(n + 1);
  for (let e = 0; e < edges.length; e += 2) {
    deg[edges[e]]++;
    deg[edges[e + 1]]++;
  }
  adjStart = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  adjTo = new Uint32Array(adjStart[n]);
  adjW = new Float32Array(adjStart[n]);
  const fill = adjStart.slice(0, n);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1];
    const w = metres(lat[a], lon[a], lat[b], lon[b]);
    adjTo[fill[a]] = b;
    adjW[fill[a]++] = w;
    adjTo[fill[b]] = a;
    adjW[fill[b]++] = w;
  }
  grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = cellKey(lat[i], lon[i]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  tracks.nodes = n;
  paths.clear();
  snapped.clear();
  return n;
}

function cellKey(la, lo) {
  return Math.floor(la / CELL) * 100000 + Math.floor(lo / CELL);
}

export async function loadTracks() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const file = path.join(config.dataDir, RAIL_FILE);
    const fresh = fs.existsSync(file) && (Date.now() - fs.statSync(file).mtimeMs) / 3600000 < RAIL_MAX_AGE_H;
    if (!fresh) {
      try {
        await downloadRail(file);
      } catch (err) {
        if (!fs.existsSync(file)) throw err;
        console.error('[tracks] using previous railway lines:', err.message);
      }
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    buildGraph(data.ways);
    tracks.version = String(data.at);
    loadPathCache();
    tracks.ready = true;
    tracks.error = null;
    console.log(`[tracks] ready: ${tracks.nodes} track points, ${paths.size} cached routes`);
  } catch (err) {
    tracks.error = err.message;
    console.error('[tracks] unavailable, trains will move in straight lines:', err.message);
  }
}

function loadPathCache() {
  const file = path.join(config.dataDir, PATHS_FILE);
  if (!fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== tracks.version) return;
    for (const [k, v] of Object.entries(data.paths)) paths.set(k, v);
  } catch {}
}

let dirty = false;
export function savePathCache() {
  if (!dirty || !tracks.ready) return;
  dirty = false;
  const file = path.join(config.dataDir, PATHS_FILE);
  try {
    fs.writeFileSync(file + '.part', JSON.stringify({ version: tracks.version, paths: Object.fromEntries(paths) }));
    fs.renameSync(file + '.part', file);
  } catch (err) {
    console.error('[tracks] could not save routes:', err.message);
  }
}

// ---------- routing ----------

/** Nearest track node to a point, or -1. */
export function snap(la, lo, maxM = SNAP_MAX_M) {
  if (!grid) return -1;
  const cy = Math.floor(la / CELL), cx = Math.floor(lo / CELL);
  let best = -1, bestD = maxM;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const list = grid.get((cy + dy) * 100000 + (cx + dx));
      if (!list) continue;
      for (const i of list) {
        const d = metres(la, lo, lat[i], lon[i]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best;
}

// Min-heap of [f, node]
class Heap {
  constructor() {
    this.f = [];
    this.n = [];
  }
  get size() {
    return this.f.length;
  }
  push(f, n) {
    const F = this.f, N = this.n;
    let i = F.length;
    F.push(f);
    N.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      F[i] = F[p];
      N[i] = N[p];
      i = p;
    }
    F[i] = f;
    N[i] = n;
  }
  pop() {
    const F = this.f, N = this.n;
    const top = N[0];
    const lf = F.pop(), ln = N.pop();
    if (F.length) {
      let i = 0;
      const len = F.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= len) break;
        if (c + 1 < len && F[c + 1] < F[c]) c++;
        if (F[c] >= lf) break;
        F[i] = F[c];
        N[i] = N[c];
        i = c;
      }
      F[i] = lf;
      N[i] = ln;
    }
    return top;
  }
}

let gScore = null;
let cameFrom = null;
let touched = [];

/** Shortest route along the tracks between two nodes (A*). Returns node list or null. */
export function route(s, t, maxLenM = Infinity, maxExpand = 400000) {
  const n = tracks.nodes;
  if (!gScore || gScore.length !== n) {
    gScore = new Float64Array(n).fill(Infinity);
    cameFrom = new Int32Array(n).fill(-1);
  }
  for (const i of touched) {
    gScore[i] = Infinity;
    cameFrom[i] = -1;
  }
  touched = [];
  const tl = lat[t], tn = lon[t];
  const h = (i) => metres(lat[i], lon[i], tl, tn);
  const heap = new Heap();
  gScore[s] = 0;
  touched.push(s);
  heap.push(h(s), s);
  let expanded = 0;
  while (heap.size) {
    const u = heap.pop();
    if (u === t) break;
    if (++expanded > maxExpand) return null;
    const gu = gScore[u];
    if (gu > maxLenM) return null;
    for (let e = adjStart[u]; e < adjStart[u + 1]; e++) {
      const v = adjTo[e];
      const g = gu + adjW[e];
      if (g < gScore[v]) {
        if (gScore[v] === Infinity) touched.push(v);
        gScore[v] = g;
        cameFrom[v] = u;
        heap.push(g + h(v), v);
      }
    }
  }
  if (gScore[t] === Infinity || gScore[t] > maxLenM) return null;
  const out = [];
  for (let v = t; v !== -1; v = cameFrom[v]) out.push(v);
  out.reverse();
  return out;
}

function snapStation(tiploc, c) {
  let i = snapped.get(tiploc);
  if (i === undefined) {
    i = inBox(c.lat, c.lng) ? snap(c.lat, c.lng) : -1;
    snapped.set(tiploc, i);
  }
  return i;
}

/** A point on the track for a station (snapped), or the station's own coordinates. */
export function stationPoint(tiploc, c) {
  if (!tracks.ready) return c;
  const i = snapStation(tiploc, c);
  return i >= 0 ? { lat: lat[i], lng: lon[i] } : c;
}

function computePath(a, ca, b, cb) {
  const sa = snapStation(a, ca);
  const sb = snapStation(b, cb);
  if (sa < 0 || sb < 0 || sa === sb) return null;
  const straight = metres(lat[sa], lon[sa], lat[sb], lon[sb]);
  // Allow a winding route, but not a detour onto some other line entirely
  const nodes = route(sa, sb, Math.max(straight * 1.8, straight + 2500));
  if (!nodes) return null;
  const pts = nodes.map((i) => [lat[i], lon[i]]);
  return simplify(pts).map(([y, x]) => [Math.round(y * 1e5) / 1e5, Math.round(x * 1e5) / 1e5]);
}

/**
 * Route between two consecutive located points of a train's journey.
 * Returns { key, rev } once ready (rev = travel runs from key's second location to its first),
 * or null while it's being worked out / when there is no track route.
 */
export function pathFor(a, ca, b, cb) {
  if (!tracks.ready || a === b) return null;
  if (!inBox(ca.lat, ca.lng) && !inBox(cb.lat, cb.lng)) return null;
  const rev = a > b;
  const key = rev ? `${b}|${a}` : `${a}|${b}`;
  const p = paths.get(key);
  if (p) return { key, rev };
  if (p === undefined && !queued.has(key)) {
    queued.add(key);
    queue.push(rev ? [key, b, cb, a, ca] : [key, a, ca, b, cb]);
  }
  return null;
}

/** Work through queued routes for up to budgetMs. */
export function processQueue(budgetMs = 150) {
  if (!tracks.ready) return;
  const end = Date.now() + budgetMs;
  while (queue.length && Date.now() < end) {
    const [key, a, ca, b, cb] = queue.shift();
    queued.delete(key);
    let p = null;
    try {
      p = computePath(a, ca, b, cb);
    } catch (err) {
      console.error('[tracks] route error', key, err.message);
    }
    paths.set(key, p);
    dirty = true;
    if (p) tracks.computed++;
    else tracks.failed++;
  }
}

export function getPaths(keys) {
  const out = {};
  for (const k of keys) {
    const p = paths.get(k);
    if (p) out[k] = p;
  }
  return out;
}

export function queueLength() {
  return queue.length;
}

/** Track route as points from a to b, or null. */
export function pathPoints(a, ca, b, cb) {
  const r = pathFor(a, ca, b, cb);
  if (!r) return null;
  const p = paths.get(r.key);
  return r.rev ? [...p].reverse() : p;
}

export function _setReadyForTest(v) {
  tracks.ready = v;
  tracks.version = 'test';
}
