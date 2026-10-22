// HTTP API: snapshot, live stream (Server-Sent Events), train detail and status.
import http from 'node:http';
import { config } from './config.js';
import { trains, view, detail, cleanup, stats } from './trains.js';
import { sched } from './schedule.js';
import { feedState } from './feeds.js';
import { tracks, processQueue, getPaths, queueLength } from './tracks.js';
import { board, stationList, ldbState } from './board.js';
import { ref } from './reference.js';
import { busState, busesFor, busDetail, routeList, routeShapes, busTo } from './buses.js';
import { alertState, publicKey, addWatch, removeWatch, listWatches } from './alerts.js';
import { record, frameAt, replayInfo } from './replay.js';
import { euroViews, euroDetail, euroState } from './eurostar.js';
import { disruptions } from './disruptions.js';
import { watchPairs, historyFor, historyInfo } from './history.js';

const clients = new Set();
let lastViews = new Map(); // id → JSON string

function snapshot(now = Date.now()) {
  const out = new Map();
  for (const t of trains.values()) {
    const v = view(t, now);
    if (v) out.set(v.id, v);
  }
  for (const v of euroViews(now)) out.set(v.id, v); // Eurostars beyond the Channel Tunnel
  return out;
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Every push interval, send only what changed to every connected browser. */
function tick() {
  processQueue(Math.min(400, config.pushInterval / 3)); // work out a few more track routes
  const now = Date.now();
  cleanup(now);
  const views = snapshot(now);
  record(views, now); // for replay
  const upd = [];
  const next = new Map();
  for (const [id, v] of views) {
    const s = JSON.stringify(v);
    next.set(id, s);
    if (lastViews.get(id) !== s) upd.push(v);
  }
  const del = [];
  for (const id of lastViews.keys()) if (!next.has(id)) del.push(id);
  lastViews = next;
  if (!upd.length && !del.length) return;
  for (const res of clients) send(res, 'delta', { now, upd, del });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
  res.setHeader('Vary', 'Origin');
}

function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** A small JSON request body (alerts only). */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20000) {
        reject(new Error('Too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('Bad JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/status') {
      return json(res, 200, {
        feed: feedState,
        trainsTracked: trains.size,
        trainsShown: lastViews.size,
        runsLoaded: sched.runs.size,
        scheduleLoadedAt: sched.loadedAt,
        tracks: { ...tracks, queued: queueLength() },
        memoryMB: Math.round(process.memoryUsage().rss / 1e6),
        nationalRail: { ...ldbState, configured: Boolean(config.ldbKey) },
        stations: { count: ref.stations.size, missing: ["WAT","CLJ","LBG","VIC","RAY","WIM"].filter((c) => !ref.stations.has(c)), tiplocs: Object.fromEntries(["WAT","RAY","CLJ"].map((c) => [c, [...(ref.stations.get(c)?.tiplocs || [])]])) },
        buses: busState,
        alerts: alertState,
        replay: replayInfo(),
        eurostar: euroState,
        disruptions: { at: disruptions.at, count: disruptions.lines.length, error: disruptions.error },
        history: historyInfo(),
        stats,
        clients: clients.size,
      });
    }
    if (url.pathname === '/api/trains') {
      const now = Date.now();
      return json(res, 200, { now, trains: [...snapshot(now).values()] });
    }
    if (url.pathname === '/api/stations') {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      return res.end(stationList());
    }
    if (url.pathname === '/api/board') {
      board(url.searchParams.get('from'), url.searchParams.get('to'))
        .then((d) => json(res, d.error ? 400 : 200, d))
        .catch((err) => json(res, 500, { error: err.message }));
      return;
    }
    if (url.pathname === '/api/buses') {
      // ?r=57,93 (routes, anywhere) &b=south,west,north,east (every bus in a zoomed-in view)
      const routes = (url.searchParams.get('r') || '').split(',').filter(Boolean).slice(0, 40);
      const b = url.searchParams.get('b');
      const box = b ? b.split(',').map(Number) : null;
      return json(res, 200, busesFor({ routes, box: box && box.length === 4 ? box : null }));
    }
    if (url.pathname.startsWith('/api/bus/')) {
      const d = busDetail(decodeURIComponent(url.pathname.slice('/api/bus/'.length)));
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/disruptions') return json(res, 200, disruptions);
    if (url.pathname === '/api/replay') {
      const t = Number(url.searchParams.get('t')) || Date.now();
      return json(res, 200, frameAt(t));
    }
    if (url.pathname === '/api/history') {
      // ?f=RAY&t=WAT, and optionally &watch=RAY-WAT,CLJ-WIM (your saved routes, to start recording)
      const w = url.searchParams.get('watch');
      if (w) watchPairs(w.split(',').map((x) => ({ f: x.split('-')[0], t: x.split('-')[1] })));
      const f = url.searchParams.get('f');
      const to = url.searchParams.get('t');
      return json(res, 200, f && to ? historyFor(f, to) : { ok: true });
    }
    if (url.pathname === '/api/push/key') return json(res, 200, { key: publicKey() });
    if (url.pathname.startsWith('/api/alerts') && req.method === 'POST') {
      readJson(req)
        .then((body) => {
          if (url.pathname === '/api/alerts') {
            const r = addWatch(body);
            return json(res, r.error ? 400 : 200, r);
          }
          if (url.pathname === '/api/alerts/remove') return json(res, 200, removeWatch(body.id, body.endpoint));
          if (url.pathname === '/api/alerts/list') return json(res, 200, listWatches(body.endpoint));
          json(res, 404, { error: 'not found' });
        })
        .catch((err) => json(res, 400, { error: err.message }));
      return;
    }
    if (url.pathname === '/api/busto') {
      // Buses from where you are to a station: ?la=&lo=&crs=
      const st = ref.stations.get(String(url.searchParams.get('crs') || '').toUpperCase());
      const la = Number(url.searchParams.get('la'));
      const lo = Number(url.searchParams.get('lo'));
      if (!st || !Number.isFinite(la) || !Number.isFinite(lo)) return json(res, 400, { error: 'Need la, lo and crs' });
      busTo(la, lo, st)
        .then((d) => json(res, 200, d))
        .catch((err) => json(res, 500, { error: err.message }));
      return;
    }
    if (url.pathname === '/api/busroutes') {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      return res.end(JSON.stringify(routeList()));
    }
    if (url.pathname === '/api/busshapes') {
      const ids = (url.searchParams.get('r') || '').split(',').filter(Boolean);
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      return res.end(JSON.stringify(routeShapes(ids)));
    }
    if (url.pathname === '/api/paths') {
      // Track routes for the map: ?k=KEY1,KEY2 (keys as sent in train views)
      const keys = (url.searchParams.get('k') || '').split(',').filter(Boolean).slice(0, 200);
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
      return res.end(JSON.stringify(getPaths(keys)));
    }
    if (url.pathname.startsWith('/api/train/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/train/'.length));
      const d = id.startsWith('es:') ? euroDetail(id) : detail(id);
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/stream') {
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const now = Date.now();
      send(res, 'snapshot', { now, live: feedState.connected, trains: [...snapshot(now).values()] });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  setInterval(tick, config.pushInterval);
  // Keep proxies from closing idle streams; also tells browsers whether the feed is up.
  setInterval(() => {
    for (const res of clients) send(res, 'ping', { now: Date.now(), live: feedState.connected });
  }, 20000);

  server.listen(config.port, () => console.log(`[server] listening on :${config.port}`));
}
