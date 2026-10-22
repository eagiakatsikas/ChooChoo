import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';
import './style.css';
import { OPERATORS, opName, opColour, delayColour } from './operators.js';
import { demoSnapshot, demoDetail } from './demo.js';
import { createHome } from './home.js';
import { createAlerts } from './alerts.js';

// ---------- Data source ----------
const params = new URLSearchParams(location.search);
// Live data comes from the Choo Choo worker on Oracle Cloud. Add ?demo to the address for simulated trains.
const DEFAULT_WORKER = 'https://143-47-236-90.sslip.io';
const WORKER = (params.get('worker') || import.meta.env.VITE_WORKER_URL || DEFAULT_WORKER).replace(/\/$/, '');
const DEMO = !WORKER || params.has('demo');

const trains = new Map(); // id → view from the worker
// Ding Ding: buses. id → { v: view, fla, flo (where it was drawn when the update came), t0 }
const buses = new Map();
let busFavs = store0('busFavs', []); // TfL route ids, e.g. ['93', 'n93']
let busesOn = store0('busesOn', false); // every bus when zoomed in (favourites always show)
const BUS_ZOOM = 14;
const isBus = (id) => typeof id === 'string' && id.startsWith('bus:');
const isStop = (id) => typeof id === 'string' && id.startsWith('stop:');
function store0(k, d) {
  try {
    const v = localStorage.getItem('lt.' + k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
}
let skew = 0; // server clock − local clock
const now = () => Date.now() + skew;

// ---------- Preferences ----------
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('lt.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('lt.' + k, JSON.stringify(v));
    } catch {}
  },
};
const hidden = new Set(store.get('hiddenOps', []));
let colourMode = store.get('colourMode', 'delay');
let query = '';
let selectedId = null;
let tab = 'map'; // bottom navigation: home, map, departures, alerts, buses
let showTrains = store0('showTrains', true);
let showBuses = store0('showBuses', true);
const boardCrs = new Map(); // train id → the station you'd board at (when opened from a board)
let disrupt = { lines: [] }; // line status from the worker

// ---------- Map ----------
const map = L.map('map', {
  center: [51.505, -0.12],
  zoom: 11,
  minZoom: 8,
  maxZoom: 17,
  zoomControl: false,
  preferCanvas: true,
});
L.control.zoom({ position: 'bottomright' }).addTo(map);
// ---------- Basemaps ----------
// Street maps from OpenFreeMap (free, no key, no usage limits), drawn by MapLibre;
// satellite imagery from Esri (free for personal, non-commercial use).
const OFM_ATTR =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
const BASEMAPS = {
  map: [L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/positron', attribution: OFM_ATTR })],
  dark: [L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/dark', attribution: OFM_ATTR })],
  satellite: [
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      maxNativeZoom: 18,
      className: 'sat-tiles',
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    }),
    // Place names on top of the imagery
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        maxNativeZoom: 18,
        pane: 'shadowPane',
      },
    ),
  ],
};

function setBasemap(name) {
  if (!BASEMAPS[name]) name = 'map';
  for (const layers of Object.values(BASEMAPS)) for (const l of layers) if (map.hasLayer(l)) l.remove();
  for (const l of BASEMAPS[name]) l.addTo(map);
  store.set('basemap', name);
  document.body.dataset.basemap = name;
  for (const b of document.querySelectorAll('.basemap-switch [data-basemap]')) b.setAttribute('aria-pressed', b.dataset.basemap === name);
}
for (const b of document.querySelectorAll('.basemap-switch [data-basemap]')) b.addEventListener('click', () => setBasemap(b.dataset.basemap));
setBasemap(store.get('basemap', 'map'));

let routeLine = null;

// ---------- Train canvas: draws every train each frame so movement is smooth ----------
const canvas = document.createElement('canvas');
canvas.className = 'train-canvas';
map.getContainer().appendChild(canvas);
const ctx = canvas.getContext('2d');
let drawn = []; // [x, y, id] for hit testing
let hitBoxes = []; // [x0, y0, x1, y1, id]: train labels and bus tags, which can be tapped too

function resize() {
  const s = map.getSize();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = s.x * dpr;
  canvas.height = s.y * dpr;
  canvas.style.width = s.x + 'px';
  canvas.style.height = s.y + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
map.on('resize', resize);
// Phones change the visible area as the address bar shows/hides or the screen rotates
function refit() {
  map.invalidateSize();
  resize();
}
window.addEventListener('resize', refit);
window.addEventListener('orientationchange', () => setTimeout(refit, 300));
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refit());
setTimeout(refit, 500);
map.on('zoomstart', () => canvas.classList.add('hide'));
map.on('zoomend', () => canvas.classList.remove('hide'));
resize();

// ---------- Track routes (so trains follow the rails) ----------
// key → { pts: [[lat,lng],…], cum: [metres along], total }
const routes = new Map();
const routeWanted = new Set();
let routeTimer = null;

function prepRoute(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const dx = (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180);
    const dy = b[0] - a[0];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}

function wantRoute(key) {
  if (DEMO || routes.has(key) || routeWanted.has(key)) return;
  routeWanted.add(key);
  clearTimeout(routeTimer);
  routeTimer = setTimeout(fetchRoutes, 150);
}

async function fetchRoutes() {
  const keys = [...routeWanted].filter((k) => !routes.has(k)).slice(0, 150);
  if (!keys.length) return;
  try {
    const res = await fetch(`${WORKER}/api/paths?k=${keys.map(encodeURIComponent).join(',')}`);
    const data = await res.json();
    for (const k of keys) {
      if (data[k]) routes.set(k, prepRoute(data[k]));
      routeWanted.delete(k);
    }
  } catch {
    for (const k of keys) routeWanted.delete(k); // try again on a later update
  }
  if (routeWanted.size) routeTimer = setTimeout(fetchRoutes, 150);
}

/** Point a fraction f of the way along a route (reversed if rev). */
function alongRoute(r, f, rev) {
  const d = (rev ? 1 - f : f) * r.total;
  const { pts, cum } = r;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const span = cum[hi] - cum[lo] || 1;
  const u = (d - cum[lo]) / span;
  const dir = rev ? [a[0] - b[0], a[1] - b[1]] : [b[0] - a[0], b[1] - a[1]];
  return { lat: a[0] + (b[0] - a[0]) * u, lng: a[1] + (b[1] - a[1]) * u, dir };
}

function position(v, t) {
  if (v.st === 'mv' && v.seg) {
    const [la0, ln0, la1, ln1, t0, t1] = v.seg;
    let f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    f = Math.max(0, Math.min(0.97, f)); // wait just short of the station until it's reported
    const r = v.pk && routes.get(v.pk);
    if (r && r.total > 0) return alongRoute(r, f, v.rv);
    if (v.pk) wantRoute(v.pk);
    return { lat: la0 + (la1 - la0) * f, lng: ln0 + (ln1 - ln0) * f, dir: [la1 - la0, ln1 - ln0] };
  }
  return v.p ? { lat: v.p[0], lng: v.p[1], dir: null } : null;
}

function visible(v) {
  if (hidden.has(v.toc in OPERATORS ? v.toc : 'ZZ')) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    v.hc.toLowerCase().includes(q) ||
    v.o.toLowerCase().includes(q) ||
    v.d.toLowerCase().includes(q) ||
    (v.at || '').toLowerCase().includes(q) ||
    (v.nx || '').toLowerCase().includes(q)
  );
}

function colourOf(v) {
  return colourMode === 'delay' ? delayColour(v.dl) : opColour(v.toc);
}

// Exact (unrounded) screen position. Leaflet's own conversion rounds to whole pixels,
// which made dots step and direction arrows wobble.
function toScreen(lat, lng) {
  const lp = map.project([lat, lng]).subtract(map.getPixelOrigin());
  return map.layerPointToContainerPoint(lp);
}

// Smoothed arrow heading per train (radians), so it turns gently round curves
const headings = new Map();
function heading(id, target) {
  const prev = headings.get(id);
  if (prev === undefined || Number.isNaN(prev)) {
    headings.set(id, target);
    return target;
  }
  let d = target - prev;
  d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest way round
  const h = Math.abs(d) > 2.5 ? target : prev + d * 0.15; // reversals snap, small changes ease
  headings.set(id, h);
  return h;
}

function draw() {
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);
  const z = map.getZoom();
  const r = z <= 9 ? 2.6 : z <= 11 ? 3.6 : z <= 13 ? 5 : 6.5;
  const labels = z >= 13;
  const t = now();
  drawn = [];
  hitBoxes = [];
  let selected = null;

  if (replay && replay.frame) {
    drawReplay(size, r, labels);
    requestAnimationFrame(draw);
    return;
  }
  for (const v of trains.values()) {
    if (!showTrains || !visible(v)) continue;
    const p = position(v, t);
    if (!p) continue;
    const pt = toScreen(p.lat, p.lng);
    if (pt.x < -20 || pt.y < -20 || pt.x > size.x + 20 || pt.y > size.y + 20) continue;
    drawn.push([pt.x, pt.y, v.id]);
    if (v.id === selectedId) {
      selected = { v, pt, p };
      continue;
    }
    drawTrain(v, pt, p, r, labels, false);
  }
  drawStations(size, z);
  drawBusStops(size, z);
  drawMe();
  const selBus = drawBuses(t, size, z);
  if (selected) {
    drawTrain(selected.v, selected.pt, selected.p, r + 2.5, true, true);
    if (following === selectedId) keepInView(selected.p.lat, selected.p.lng, selected.pt, size);
  }
  if (selBus && following === selectedId) {
    const bp = busPos(selBus.o, t);
    keepInView(bp.la, bp.lo, selBus.pt, size);
  }
  if (selBus) drawBus(selBus.o, selBus.pt, z, true);
  requestAnimationFrame(draw);
}

function drawTrain(v, pt, p, r, label, isSelected) {
  const c = colourOf(v);
  const faded = v.st === 'end' || v.st === 'wait';
  ctx.globalAlpha = faded ? 0.5 : 1;

  // Direction of travel
  if (p.dir && (p.dir[0] || p.dir[1])) {
    // Screen direction of travel: step a fixed small distance along the direction, unrounded
    const k = 0.002 / (Math.hypot(p.dir[0], p.dir[1]) || 1);
    const ahead = toScreen(p.lat + p.dir[0] * k, p.lng + p.dir[1] * k);
    const ang = heading(v.id, Math.atan2(ahead.y - pt.y, ahead.x - pt.x));
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    ctx.beginPath();
    // arrowhead ahead of the lamp, showing direction of travel
    const tip = r + 6;
    const base = r + 1.5;
    const half = Math.max(2.5, r * 0.75);
    ctx.moveTo(pt.x + ux * tip, pt.y + uy * tip);
    ctx.lineTo(pt.x + ux * base - uy * half, pt.y + uy * base + ux * half);
    ctx.lineTo(pt.x + ux * base + uy * half, pt.y + uy * base - ux * half);
    ctx.closePath();
    ctx.fillStyle = c;
    ctx.fill();
  }

  // Lamp glow
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, r * 2.1, 0, Math.PI * 2);
  ctx.fillStyle = c + '26';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
  ctx.fillStyle = c;
  ctx.fill();
  ctx.lineWidth = isSelected ? 3 : 1.8;
  ctx.strokeStyle = isSelected ? '#efeadb' : '#1f3229';
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (label) {
    ctx.font = '600 11px "Work Sans", system-ui, sans-serif';
    const text = v.hc;
    const w = ctx.measureText(text).width + 8;
    const x = pt.x + r + 5;
    const y = pt.y - 8;
    ctx.fillStyle = '#162720';
    ctx.fillRect(x, y, w, 16);
    if (!String(v.id).startsWith('rp:')) hitBoxes.push([x - 2, y - 4, x + w + 2, y + 20, v.id]);
    ctx.fillStyle = '#d4a64a';
    ctx.fillText(text, x + 4, y + 12);
  }
}
requestAnimationFrame(draw);

// Tap a train to see its details
map.on('click', (e) => {
  const { x, y } = e.containerPoint;
  let best = null;
  let bestD = 22;
  for (const [px, py, id] of drawn) {
    const d = Math.hypot(px - x, py - y);
    if (d < bestD) {
      best = id;
      bestD = d;
    }
  }
  // A train's label or a bus's tag, tapped directly (the last drawn is on top)
  for (let k = hitBoxes.length - 1; k >= 0; k--) {
    const [x0, y0, x1, y1, id] = hitBoxes[k];
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return select(id);
  }
  // A station's name, tapped directly, wins
  for (const [, , crs, box] of drawnStations) {
    if (box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) return openBoard(crs, null);
  }
  // A station's dot, if it's clearly closer than any train or bus
  let stn = null;
  let stnD = 18;
  for (const [px, py, crs] of drawnStations) {
    const d = Math.hypot(px - x, py - y);
    if (d < stnD) {
      stn = crs;
      stnD = d;
    }
  }
  if (stn && (!best || stnD < 6)) return openBoard(stn, null);
  // A bus stop, if no train or bus is right there
  let stop = null;
  let stopD = 14;
  for (const [px, py, id] of drawnStops) {
    const d = Math.hypot(px - x, py - y);
    if (d < stopD) {
      stop = id;
      stopD = d;
    }
  }
  if (stop && (!best || stopD < 5)) return select('stop:' + stop);
  if (best) return select(best);
  if (selectedId) closeDetail();
});

// ---------- Status ----------
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const countEl = document.getElementById('count');

let lastStatus = ['connecting', 'Connecting'];
function setStatus(state, text) {
  const replaying = document.body.classList.contains('replaying');
  if (text !== 'Replay') lastStatus = [state, text];
  if (replaying && text !== 'Replay') return; // keep showing "Replay" until you go back to live
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

let trainsShown = 0;
function renderCount() {
  const t = `${trainsShown} ${trainsShown === 1 ? 'train' : 'trains'}`;
  const nb = showBuses ? buses.size : 0;
  countEl.textContent = nb ? `${t} · ${nb} ${nb === 1 ? 'bus' : 'buses'} on the map` : `${t} on the map`;
}

function updateCounts() {
  let shown = 0;
  const perOp = new Map();
  for (const v of trains.values()) {
    if (v.st === 'end') continue;
    const k = v.toc in OPERATORS ? v.toc : 'ZZ';
    perOp.set(k, (perOp.get(k) || 0) + 1);
    if (visible(v)) shown++;
  }
  if (!showTrains) shown = 0;
  trainsShown = shown;
  renderCount();
  renderOps(perOp);
}

// ---------- Filters ----------
const opsEl = document.getElementById('ops');
const filtersEl = document.getElementById('filters');
const toggleBtn = document.getElementById('filterToggle');
const summaryEl = document.getElementById('filterSummary');

function renderOps(perOp) {
  const codes = [...perOp.keys()].sort((a, b) => opName(a).localeCompare(opName(b)));
  opsEl.innerHTML = '';
  for (const code of codes) {
    const li = document.createElement('li');
    const id = 'op-' + code;
    li.innerHTML = `<input type="checkbox" id="${id}" ${hidden.has(code) ? '' : 'checked'}>
      <label for="${id}"><span class="sw" style="--c:${opColour(code)}"></span><span class="nm">${opName(code)}${
        disruptedOp(opName(code)) ? ` <span class="op-warn" title="${esc(disruptedOp(opName(code)).severity)}">⚠</span>` : ''
      }</span><span class="n">${perOp.get(code)}</span></label>`;
    li.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) hidden.delete(code);
      else hidden.add(code);
      store.set('hiddenOps', [...hidden]);
      updateCounts();
    });
    opsEl.appendChild(li);
  }
  const total = codes.length;
  const on = codes.filter((c) => !hidden.has(c)).length;
  summaryEl.textContent = on === total ? '' : `${on} of ${total}`;
}

document.getElementById('allOn').onclick = () => {
  hidden.clear();
  store.set('hiddenOps', []);
  updateCounts();
};
document.getElementById('allOff').onclick = () => {
  for (const v of trains.values()) hidden.add(v.toc in OPERATORS ? v.toc : 'ZZ');
  store.set('hiddenOps', [...hidden]);
  updateCounts();
};
document.getElementById('search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  updateCounts();
});

const legend = document.getElementById('delayLegend');
function applyColourMode() {
  for (const b of document.querySelectorAll('[data-colour]')) b.setAttribute('aria-pressed', b.dataset.colour === colourMode);
  legend.hidden = colourMode !== 'delay';
}
for (const b of document.querySelectorAll('[data-colour]')) {
  b.addEventListener('click', () => {
    colourMode = b.dataset.colour;
    store.set('colourMode', colourMode);
    applyColourMode();
  });
}
applyColourMode();

function setFiltersOpen(open) {
  if (open) setBusPanelOpen(false);
  filtersEl.classList.toggle('open', open);
  toggleBtn.setAttribute('aria-expanded', open);
}
toggleBtn.onclick = () => setFiltersOpen(!filtersEl.classList.contains('open'));
document.getElementById('filtersClose').onclick = () => setFiltersOpen(false);
// On wide screens the filter panel starts open
if (window.matchMedia('(min-width: 900px)').matches) setFiltersOpen(true);

// ---------- Train details ----------
const detailEl = document.getElementById('detail');
const dHead = document.getElementById('dHeadcode');
const dOp = document.getElementById('dOp');
const dRoute = document.getElementById('dRoute');
const dFrom = document.getElementById('dFrom');
const dState = document.getElementById('dState');
const dCalls = document.getElementById('dCalls');
const dFoot = document.getElementById('dFoot');
let detailTimer = null;
let scrolledFor = null;
let anchoredStop = '';
let autoScrollAt = 0;
let userScrolledAt = 0;
// Scrolls Choo Choo makes itself don't count as the user looking around
const noteUserScroll = () => {
  if (Date.now() - autoScrollAt > 800) userScrolledAt = Date.now();
};
dCalls.addEventListener('scroll', noteUserScroll, { passive: true });
document.getElementById('detail').addEventListener('scroll', noteUserScroll, { passive: true });

function delayText(dl) {
  if (dl == null) return '';
  if (dl <= 0) return dl < 0 ? `${-dl} min early` : 'On time';
  return `${dl} min late`;
}

function stateText(v) {
  if (v.st === 'wait') return `Waiting to depart ${v.at}`;
  if (v.st === 'end') return `Arrived at ${v.at}`;
  if (v.st === 'at') return `At ${v.at}${v.pl ? `, platform ${v.pl}` : ''}`;
  return `Left ${v.at}${v.nx ? `, next stop ${v.nx} at ${v.nxt}` : ''}`;
}

function ago(ms) {
  const s = Math.max(0, Math.round((now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}

/**
 * Average speed between the last station and the next (mph): the distance along the track
 * over the time it's given to get there. Not a speedometer, but a fair sense of pace.
 */
function trainSpeed(v) {
  if (v.st !== 'mv' || !v.seg) return null;
  const [la0, ln0, la1, ln1, t0, t1] = v.seg;
  const secs = (t1 - t0) / 1000;
  if (secs < 60) return null;
  const r = v.pk && routes.get(v.pk);
  const deg = r && r.total > 0 ? r.total : Math.hypot((ln1 - ln0) * Math.cos((la0 * Math.PI) / 180), la1 - la0);
  const mph = ((deg * 111195) / secs) * 2.23694;
  return mph >= 5 && mph <= 140 ? Math.round(mph / 5) * 5 : null;
}

function renderDetailHeader() {
  const ab = document.getElementById('dAlert');
  ab.hidden = DEMO || isBus(selectedId) || isStop(selectedId);
  document.getElementById('dFollow').hidden = isStop(selectedId);
  dCalls.classList.toggle('deps', isStop(selectedId));
  if (isStop(selectedId)) return renderStopHeader();
  if (!ab.hidden) {
    const on = alerts && alerts.has(selectedId);
    ab.setAttribute('aria-pressed', Boolean(on));
    ab.textContent = on ? 'Alert on' : 'Alert me';
  }
  if (isBus(selectedId)) return renderBusHeader();
  const v = trains.get(selectedId);
  if (!v) return;
  dHead.textContent = v.hc;
  dOp.innerHTML = `<span class="sw" style="--c:${opColour(v.toc)}"></span>${opName(v.toc)}`;
  dRoute.textContent = `To ${v.d}`;
  dFrom.textContent = `${v.dep} from ${v.o}`;
  const dl = delayText(v.dl);
  const mph = trainSpeed(v);
  dState.innerHTML = `${stateText(v)}<span class="pill" style="--c:${delayColour(v.dl)}">${dl}</span>${
    mph ? `<span class="speed" title="Average speed between these two stations">about ${mph} mph</span>` : ''
  }`;
  const src = { TD: 'signalling', TRUST: 'train reporting', schedule: 'timetable', demo: 'simulated', eurostar: 'Eurostar’s live' }[v.src] || v.src;
  dFoot.classList.remove('tiny');
  dFoot.textContent = DEMO ? 'Demo data, not real trains' : `Last reported ${ago(v.up)} from ${src} data`;
}

async function loadCalls() {
  if (isBus(selectedId)) return loadBusCalls();
  if (isStop(selectedId)) return loadStopBoard();
  let d = null;
  if (DEMO) d = demoDetail(selectedId, now());
  else {
    try {
      const res = await fetch(`${WORKER}/api/train/${encodeURIComponent(selectedId)}`);
      if (res.ok) d = await res.json();
    } catch {}
  }
  if (!d || d.id !== selectedId) return;
  // The train's current stop, or failing that the next one it hasn't reached
  const hereIdx = d.stops.findIndex((s) => s.here);
  const nextIdx = hereIdx >= 0 ? -1 : d.stops.findIndex((s) => !s.done);
  dCalls.innerHTML = d.stops
    .map(
      (s, i) =>
        `<li class="${s.done ? 'done' : ''} ${s.here ? 'here' : ''} ${i === nextIdx ? 'next' : ''}"><span class="t">${s.s}</span><span class="n">${s.n}${
          s.here ? '<span class="tag">Now</span>' : i === nextIdx ? '<span class="tag">Next</span>' : ''
        }</span><span class="e">${
          s.e && s.e !== s.s ? `<span class="x">exp ${s.e}</span>` : ''
        }${s.pl ? `<span class="p">plat ${s.pl}</span>` : ''}</span></li>`,
    )
    .reverse() // destination at the top, where the train started at the bottom
    .join('');
  // Keep the current (or next) stop in view: when a train is opened, whenever it moves
  // on to another stop, and again a few seconds after you scroll away to look around
  const cur = dCalls.querySelector('li.here, li.next');
  const curKey = cur ? cur.textContent : '';
  const firstOpen = scrolledFor !== selectedId;
  if (cur && (firstOpen || curKey !== anchoredStop || Date.now() - userScrolledAt > 8000)) {
    autoScrollAt = Date.now();
    cur.scrollIntoView({ block: 'center', behavior: firstOpen ? 'auto' : 'smooth' });
  }
  scrolledFor = selectedId;
  anchoredStop = curKey;
  if (routeLine) routeLine.remove();
  routeLine = L.polyline(d.path, { color: '#d4a64a', weight: 3, opacity: 0.85, dashArray: '2 7', interactive: false }).addTo(map);
}

function select(id) {
  if (following && following !== id) setFollow(null);
  selectedId = id;
  detailEl.hidden = false;
  if (!finderEl.hidden) setFinderOpen(false);
  dCalls.innerHTML = '';
  if (window.matchMedia('(max-width: 899px)').matches) {
    setFiltersOpen(false);
    setBusPanelOpen(false);
    setHomeOpen(false);
    if (tab !== 'map') markTab('map');
  }
  renderDetailHeader();
  loadCalls();
  clearInterval(detailTimer);
  detailTimer = setInterval(() => {
    renderDetailHeader();
    loadCalls();
  }, 15000);
}

function closeDetail() {
  selectedId = null;
  setFollow(null);
  detailEl.hidden = true;
  clearInterval(detailTimer);
  if (routeLine) routeLine.remove();
  routeLine = null;
}
document.getElementById('detailClose').onclick = closeDetail;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDetail();
    setBusPanelOpen(false);
  }
});

// ---------- Feeding data in ----------
function replaceAll(list) {
  trains.clear();
  for (const v of list) trains.set(v.id, v);
  afterUpdate();
}

function afterUpdate() {
  updateCounts();
  if (selectedId && !isBus(selectedId)) {
    if (trains.has(selectedId)) renderDetailHeader();
    else dState.textContent = 'No longer being tracked';
  }
}

if (DEMO) {
  setStatus('demo', 'Demo');
  const tick = () => replaceAll(demoSnapshot(Date.now()));
  tick();
  setInterval(tick, 2000);
} else {
  connect();
}

function connect() {
  setStatus('connecting', 'Connecting');
  const es = new EventSource(`${WORKER}/api/stream`);
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    skew = d.now - Date.now();
    replaceAll(d.trains);
    setStatus(d.live ? 'live' : 'stale', d.live ? 'Live' : 'Feed reconnecting');
  });
  es.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    skew = d.now - Date.now();
    for (const v of d.upd) trains.set(v.id, v);
    for (const id of d.del) {
      trains.delete(id);
      headings.delete(id);
    }
    afterUpdate();
  });
  es.addEventListener('ping', (e) => {
    const d = JSON.parse(e.data);
    skew = d.now - Date.now();
    setStatus(d.live ? 'live' : 'stale', d.live ? 'Live' : 'Feed reconnecting');
  });
  es.onerror = () => setStatus('connecting', 'Reconnecting');
}

// Re-render "x seconds ago" text
setInterval(() => selectedId && renderDetailHeader(), 5000);

// ---------- Train finder: nearest station → destination → departures board ----------
const finderEl = document.getElementById('finder');
const fFrom = document.getElementById('fFrom');
const fTo = document.getElementById('fTo');
const fSuggest = document.getElementById('fSuggest');
const fNote = document.getElementById('fNote');
const fFavs = document.getElementById('fFavs');
const fBoard = document.getElementById('fBoard');
const fLocate = document.getElementById('fLocate');

let stations = null; // [{c, n, la, lo}]
let stationsLoading = null;
const route = { from: store.get('fFrom', null), to: store.get('fTo', null) }; // CRS codes
let favs = store.get('favs', []); // [{f, t}]
let boardTimer = null;
let located = false;

const byCrs = (c) => stations && stations.find((s) => s.c === c);
const short = (name) => name.replace(/^London /, '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

function loadStations() {
  if (stations) return Promise.resolve(stations);
  if (!stationsLoading) {
    stationsLoading = fetch(`${WORKER}/api/stations`)
      .then((r) => r.json())
      .then((list) => (stations = list))
      .catch(() => {
        stationsLoading = null;
        throw new Error('stations');
      });
  }
  return stationsLoading;
}

function search(q) {
  q = q.trim().toLowerCase();
  if (!q || !stations) return [];
  const out = [];
  for (const s of stations) {
    const n = s.n.toLowerCase();
    const bare = n.replace(/^london /, '');
    let score = -1;
    if (s.c.toLowerCase() === q) score = 0;
    else if (bare.startsWith(q) || n.startsWith(q)) score = 1;
    else if (n.split(/[\s(-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (n.includes(q)) score = 3;
    if (score >= 0) out.push([score, n.startsWith('london ') ? 0 : 1, n.length, s]);
  }
  // Best match first; among equals, London stations, then shorter names
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return out.slice(0, 8).map((x) => x[3]);
}

function metresTo(la, lo, s) {
  const x = (s.lo - lo) * Math.cos((la * Math.PI) / 180) * 111320;
  const y = (s.la - la) * 110574;
  return Math.hypot(x, y);
}

function nearest(la, lo) {
  let best = null;
  let bestD = Infinity;
  for (const s of stations) {
    const d = metresTo(la, lo, s);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best && { s: best, d: bestD };
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

function setNote(text) {
  fNote.textContent = text || '';
}

function setStation(which, crs) {
  route[which] = crs;
  store.set(which === 'from' ? 'fFrom' : 'fTo', crs);
  const s = byCrs(crs);
  (which === 'from' ? fFrom : fTo).value = s ? s.n : '';
  renderFavs();
  loadBoard();
}

function locate() {
  if (!navigator.geolocation) {
    setNote('Location isn’t available on this device. Type your station instead.');
    fFrom.focus();
    return;
  }
  fLocate.classList.add('busy');
  setNote('Finding your nearest station…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      fLocate.classList.remove('busy');
      try {
        await loadStations();
      } catch {
        setNote('Couldn’t load the station list. Check your connection and try again.');
        return;
      }
      const n = nearest(pos.coords.latitude, pos.coords.longitude);
      if (!n) return;
      located = true;
      setStation('from', n.s.c);
      setNote(
        n.d > 2500
          ? `Nearest station is ${n.s.n}, ${fmtDist(n.d)} away. Change it if you’re going from somewhere else.`
          : `Nearest station: ${n.s.n} (${fmtDist(n.d)})`,
      );
      if (!route.to) fTo.focus();
    },
    (err) => {
      fLocate.classList.remove('busy');
      setNote(
        err.code === 1
          ? 'Location is turned off for this site. Type your station instead.'
          : 'Couldn’t find your location. Type your station instead.',
      );
      fFrom.focus();
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 },
  );
}

// ----- Station suggestions -----
let suggestFor = null;
let suggestItems = [];
let suggestIdx = -1;

function showSuggest(input) {
  const items = search(input.value);
  suggestFor = input;
  suggestItems = items;
  suggestIdx = items.length ? 0 : -1;
  if (!items.length) {
    hideSuggest();
    return;
  }
  const field = input.closest('.f-field');
  fSuggest.style.top = `${field.offsetTop + field.offsetHeight + 4}px`;
  fSuggest.innerHTML = items
    .map(
      (s, i) =>
        `<li role="option" id="sug-${i}" aria-selected="${i === suggestIdx}" data-crs="${s.c}"><span>${esc(s.n)}</span><span class="crs">${s.c}</span></li>`,
    )
    .join('');
  fSuggest.hidden = false;
  input.setAttribute('aria-activedescendant', 'sug-0');
  // Make the panel tall enough to show the whole list rather than cutting it off
  const finderEl = document.getElementById('finder');
  finderEl.style.minHeight = '';
  const need = fSuggest.parentElement.offsetTop + fSuggest.offsetTop + fSuggest.offsetHeight + 16;
  if (need > finderEl.clientHeight) finderEl.style.minHeight = `${need}px`;
}

function hideSuggest() {
  fSuggest.hidden = true;
  suggestFor = null;
  document.getElementById('finder').style.minHeight = '';
}

function pickSuggestion(i) {
  const s = suggestItems[i];
  if (!s || !suggestFor) return;
  const which = suggestFor === fFrom ? 'from' : 'to';
  hideSuggest();
  setStation(which, s.c);
  if (which === 'from') setNote('');
  if (which === 'from' && !route.to) fTo.focus();
  else (which === 'from' ? fFrom : fTo).blur();
}

for (const input of [fFrom, fTo]) {
  input.addEventListener('input', async () => {
    try {
      await loadStations();
    } catch {
      setNote('Couldn’t load the station list. Check your connection and try again.');
      return;
    }
    showSuggest(input);
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (e) => {
    if (fSuggest.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      suggestIdx = (suggestIdx + (e.key === 'ArrowDown' ? 1 : -1) + suggestItems.length) % suggestItems.length;
      [...fSuggest.children].forEach((li, i) => li.setAttribute('aria-selected', i === suggestIdx));
      input.setAttribute('aria-activedescendant', `sug-${suggestIdx}`);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickSuggestion(Math.max(0, suggestIdx));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      hideSuggest();
    }
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      if (document.activeElement !== fFrom && document.activeElement !== fTo) {
        hideSuggest();
        // Destination cleared: show every train leaving instead
        if (!fTo.value.trim() && route.to) setStation('to', null);
        // Put back the chosen station's name if the text was left half-typed
        fFrom.value = byCrs(route.from)?.n || '';
        fTo.value = byCrs(route.to)?.n || '';
      }
    }, 150),
  );
}
fSuggest.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
fSuggest.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) pickSuggestion([...fSuggest.children].indexOf(li));
});

fLocate.onclick = locate;
document.getElementById('fSwap').onclick = () => {
  const { from, to } = route;
  route.from = to;
  route.to = from;
  store.set('fFrom', route.from);
  store.set('fTo', route.to);
  fFrom.value = byCrs(route.from)?.n || '';
  fTo.value = byCrs(route.to)?.n || '';
  setNote('');
  renderFavs();
  loadBoard();
};

// ----- Favourite routes (kept on this device) -----
const isFav = () => favs.some((f) => f.f === route.from && f.t === route.to);

function renderFavs() {
  if (!stations) return;
  fFavs.innerHTML = favs
    .map((f, i) => {
      const a = byCrs(f.f);
      const b = byCrs(f.t);
      if (!a || !b) return '';
      const on = f.f === route.from && f.t === route.to;
      return `<span class="fav ${on ? 'on' : ''}"><button data-i="${i}" aria-pressed="${on}">${esc(short(a.n))} → ${esc(short(b.n))}</button><button class="rm" data-rm="${i}" aria-label="Remove saved route ${esc(short(a.n))} to ${esc(short(b.n))}">×</button></span>`;
    })
    .join('');
}
fFavs.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.rm != null) {
    favs.splice(Number(b.dataset.rm), 1);
    store.set('favs', favs);
    renderFavs();
    renderBoardHead();
    return;
  }
  const f = favs[Number(b.dataset.i)];
  if (!f) return;
  route.from = f.f;
  route.to = f.t;
  store.set('fFrom', f.f);
  store.set('fTo', f.t);
  fFrom.value = byCrs(f.f)?.n || '';
  fTo.value = byCrs(f.t)?.n || '';
  setNote('');
  renderFavs();
  loadBoard();
});

function toggleFav() {
  if (!route.from || !route.to) return;
  if (isFav()) favs = favs.filter((f) => !(f.f === route.from && f.t === route.to));
  else favs = [{ f: route.from, t: route.to }, ...favs].slice(0, 8);
  store.set('favs', favs);
  renderFavs();
  renderBoardHead();
}

// ----- The board -----
let lastBoard = null;

function renderBoardHead() {
  const btn = fBoard.querySelector('.b-save');
  if (btn) {
    const on = isFav();
    btn.setAttribute('aria-pressed', on);
    btn.textContent = on ? '★ Saved' : '☆ Save route';
  }
}

function expText(r) {
  if (r.cancelled) return ['Cancelled', 'cancel'];
  if (r.etdTime && r.etdTime !== r.std) return [`Exp ${r.etdTime}`, 'late'];
  if (/delay/i.test(r.etd || '')) return ['Delayed', 'late'];
  return ['On time', ''];
}

function renderBoard(d) {
  lastBoard = d;
  const head = d.to
    ? `<div class="b-head"><div class="b-title">${esc(short(d.to.name))}<small>Direct trains from ${esc(d.from.name)} · updated ${d.generated}</small></div><button class="b-save" type="button"></button></div>`
    : `<div class="b-head"><div class="b-title">Departures<small>Every train from ${esc(d.from.name)} · updated ${d.generated}. Add a destination to narrow it down.</small></div></div>`;
  let body;
  if (!d.rows.length) {
    body = d.to
      ? `<p class="b-empty">No direct trains to ${esc(d.to.name)} in the next two hours. You may need to change trains.</p>`
      : `<p class="b-empty">No trains from ${esc(d.from.name)} in the next two hours.</p>`;
  } else {
    body = d.rows
      .map((r) => {
        const [exp, cls] = expText(r);
        const arr = r.cancelled ? '' : r.etaTime || r.sta;
        const bits = [
          arr ? `Arrives ${arr}` : '',
          r.mins != null && !r.cancelled ? `${r.mins} min` : '',
          r.stops != null ? (r.stops === 0 ? 'non-stop' : `${r.stops} stop${r.stops === 1 ? '' : 's'}`) : '',
          r.op ? esc(r.op) : '',
          r.coaches ? `${r.coaches} coaches` : '',
        ].filter(Boolean);
        const plat = r.plat
          ? `<span class="b-plat ${r.platLive ? '' : 'planned'}"><b>${esc(r.plat)}</b><small>${r.platLive ? 'Platform' : 'Planned'}</small></span>`
          : `<span class="b-plat planned"><b>–</b><small>Platform</small></span>`;
        return `<button class="b-row ${r.best ? 'best' : ''} ${r.cancelled ? 'cancelled' : ''}" type="button" ${r.id ? `data-id="${esc(r.id)}"` : ''}>
          <span><span class="b-time">${esc(r.std)}</span><span class="b-exp ${cls}">${exp}</span></span>
          <span><span class="b-dest">${esc(r.dest)}${r.best ? '<span class="b-tag">Best</span>' : ''}</span><span class="b-sub">${bits.join(' · ')}</span></span>
          ${plat}
        </button>`;
      })
      .join('');
  }
  const foot =
    d.source === 'national-rail'
      ? '<p class="b-foot">Live times and platforms from National Rail. Tap a train to see it on the map.</p>'
      : '<p class="b-foot">Timetabled platforms shown until the station announces them. Tap a train to see it on the map.</p>';
  fBoard.innerHTML = head + body + foot;
  const save = fBoard.querySelector('.b-save');
  if (save) save.onclick = toggleFav;
  renderBoardHead();
}

async function loadBoard() {
  clearInterval(boardTimer);
  if (!route.from) {
    fBoard.innerHTML = '';
    return;
  }
  if (route.from === route.to) {
    fBoard.innerHTML = '<p class="b-empty">Choose two different stations.</p>';
    return;
  }
  const key = `${route.from}|${route.to || ''}`;
  if (!lastBoard || `${lastBoard.from.crs}|${lastBoard.to?.crs || ''}` !== key) {
    fBoard.innerHTML = '<p class="b-empty">Checking departures…</p>';
  }
  try {
    const res = await fetch(`${WORKER}/api/board?from=${route.from}&to=${route.to || ''}`);
    const d = await res.json();
    if (`${route.from}|${route.to || ''}` !== key) return; // changed meanwhile
    if (d.error) fBoard.innerHTML = `<p class="b-empty">${esc(d.error)}.</p>`;
    else renderBoard(d);
  } catch {
    fBoard.innerHTML = '<p class="b-empty">Couldn’t reach the departures service. It will try again shortly.</p>';
  }
  boardTimer = setInterval(() => !finderEl.hidden && loadBoard(), 30000);
}

fBoard.addEventListener('click', (e) => {
  const row = e.target.closest('.b-row');
  if (!row) return;
  const id = row.dataset.id;
  const v = id && trains.get(id);
  if (!v) {
    setNote('That train isn’t on the map yet. It appears shortly before it’s due to leave.');
    return;
  }
  showTrain(id, route.from);
});

/** Go to the map and show a train, e.g. from a departures board. */
function showTrain(id, crs = null) {
  const v = trains.get(id);
  if (crs) boardCrs.set(id, crs);
  if (!v) return false;
  setTab('map');
  select(id);
  const p = position(v, now());
  if (p) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14));
  return true;
}

/** Open or close Departures. preset: { from, to } to show a particular board (to may be null). */
async function setFinderOpen(open, preset = null) {
  finderEl.hidden = !open;
  if (open) markTab('departures');
  else if (tab === 'departures') markTab('map');
  if (!open) {
    clearInterval(boardTimer);
    hideSuggest();
    return;
  }
  closeDetail();
  setHomeOpen(false);
  setBusPanelOpen(false);
  if (window.matchMedia('(max-width: 899px)').matches) setFiltersOpen(false);
  else if (filtersEl.classList.contains('open')) setFiltersOpen(false);
  try {
    await loadStations();
  } catch {
    setNote('Couldn’t load the station list. Check your connection and try again.');
    return;
  }
  if (preset) {
    route.from = preset.from;
    route.to = preset.to || null;
    store.set('fFrom', route.from);
    store.set('fTo', route.to);
    setNote('');
  }
  fFrom.value = byCrs(route.from)?.n || '';
  fTo.value = byCrs(route.to)?.n || '';
  renderFavs();
  // Work out where you are each time the finder opens (once per visit)
  if (!located && !preset) locate();
  loadBoard();
}
document.getElementById('finderClose').onclick = () => setTab('map');
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !finderEl.hidden && fSuggest.hidden) setFinderOpen(false);
});

// ---------- Stations on the map (tap one for its departures) ----------
let drawnStations = [];
function drawStations(size, z) {
  drawnStations = [];
  if (z < 12 || !stations) return;
  const b = map.getBounds().pad(0.05);
  const big = z >= 14;
  ctx.font = '600 11px "Work Sans", system-ui, sans-serif';
  for (const st of stations) {
    if (st.la < b.getSouth() || st.la > b.getNorth() || st.lo < b.getWest() || st.lo > b.getEast()) continue;
    const pt = toScreen(st.la, st.lo);
    const entry = [pt.x, pt.y, st.c, null];
    drawnStations.push(entry);
    // A white station tick with a dark ring, like a railway map
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, big ? 4.5 : 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#efeadb';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#162720';
    ctx.stroke();
    if (big) {
      const name = short(st.n);
      // The name can be tapped too: remember the box it covers (with a little slack)
      const w = ctx.measureText(name).width;
      entry[3] = [pt.x + 3, pt.y - 20, pt.x + 11 + w, pt.y + 2];
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(22,39,32,0.85)';
      ctx.strokeText(name, pt.x + 7, pt.y - 6);
      ctx.fillStyle = '#efeadb';
      ctx.fillText(name, pt.x + 7, pt.y - 6);
    }
  }
}
// The station list is also needed for the map's station ticks
loadStations().catch(() => {});

/** Departures for a station (to may be null for every train). */
function openBoard(from, to) {
  setTab('departures', { from, to });
}

// ---------- Follow a train or bus ----------
let following = null;
let lastPan = 0;
const followBtn = document.getElementById('dFollow');
function setFollow(id) {
  following = id;
  followBtn.setAttribute('aria-pressed', Boolean(id));
  followBtn.textContent = id ? 'Following' : 'Follow';
}
followBtn.onclick = () => setFollow(following ? null : selectedId);
map.on('dragstart', () => following && setFollow(null)); // you moved the map yourself
function keepInView(lat, lng, pt, size) {
  // Recentre gently when it drifts out of the middle of the screen
  const mx = size.x * 0.3, my = size.y * 0.3;
  if (pt.x > mx && pt.x < size.x - mx && pt.y > my && pt.y < size.y - my) return;
  if (Date.now() - lastPan < 1200) return;
  lastPan = Date.now();
  map.panTo([lat, lng], { animate: true, duration: 0.8 });
}

// ---------- Bottom navigation ----------
// Full-height sheets on phones start exactly where the header ends
const barEl = document.querySelector('.bar');
function setBarHeight() {
  document.documentElement.style.setProperty('--bar-h', `${barEl.getBoundingClientRect().bottom}px`);
}
setBarHeight();
if (window.ResizeObserver) new ResizeObserver(setBarHeight).observe(barEl);
// Home-screen app on iPhone: iOS can leave the page's bottom edge short of the screen's,
// which left a strip under the nav bar. Measure it and let the nav bar reach the real bottom.
// Tap the title five times to show the layout measurements (for checking on a phone)
let debugTaps = 0;
let debugTimer = null;
document.querySelector('.bar h1').addEventListener('click', () => {
  debugTaps++;
  clearTimeout(debugTimer);
  debugTimer = setTimeout(() => debugTaps < 5 && (debugTaps = 0), 2000);
  if (debugTaps === 5) setBottomGap();
});
function setBottomGap() {
  const standaloneApp = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const portrait = window.innerHeight > window.innerWidth;
  let gap = 0;
  // (No longer used to move the nav bar: the cause, a see-through status bar, is gone.
  // Still measured for the readout below.)
  const strip = standaloneApp && portrait ? Math.round(window.screen.height - window.innerHeight) : 0;
  void strip;
  document.documentElement.style.setProperty('--gap', `${gap}px`);
  document.documentElement.classList.toggle('has-gap', gap > 0);
  // ?debug shows the measurements, to check the layout on a phone
  if (params.has('debug') || debugTaps >= 5) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;height:env(safe-area-inset-bottom,0px);width:1px;visibility:hidden';
    document.body.appendChild(probe);
    const safeB = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    countEl.textContent = `screen ${window.screen.height} · inner ${window.innerHeight} · vv ${Math.round(window.visualViewport?.height || 0)} · app ${standaloneApp} · safe ${safeB}`;
  }
}
setBottomGap();
window.addEventListener('resize', setBottomGap);
window.addEventListener('orientationchange', () => setTimeout(setBottomGap, 300));
window.addEventListener('resize', setBarHeight);
function markTab(name) {
  tab = name;
  document.body.dataset.tab = name;
  for (const b of document.querySelectorAll('.tabbar [data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === name);
}
const alerts = createAlerts({
  WORKER,
  DEMO,
  store,
  esc,
  setTab: (t) => setTab(t),
  showTrain: (id) => showTrain(id),
  onChange() {
    const n = alerts ? alerts.list().length : 0;
    document.getElementById('alertCount').textContent = n ? n : '';
    if (selectedId) renderDetailHeader();
    home.render();
  },
});
document.getElementById('dAlert').onclick = () => {
  if (!selectedId || isBus(selectedId)) return;
  const own = alerts.list().find((a) => a.key === selectedId);
  if (own) alerts.remove(own.id);
  else alerts.watch(selectedId, boardCrs.get(selectedId) || null);
};
document.getElementById('alertsClose').onclick = () => setTab('map');
function setAlertsOpen(open) {
  if (alerts.isOpen() === open) return;
  alerts.open(open);
  if (open) markTab('alerts');
  else if (tab === 'alerts') markTab('map');
}

const home = createHome({
  alerts: () => alerts,
  disruptionNote: (ops) => disruptionNote(ops),
  WORKER,
  store,
  esc,
  short,
  now,
  byCrs,
  loadStations,
  expText,
  favs: () => favs,
  setTab: (t) => setTab(t),
  openBoard,
  showTrain,
});
home.addSection(() => {
  const list = alerts.list();
  if (!list.length) return '';
  return `<section class="h-card"><h3 class="h-head">Your alerts</h3><ul class="al-list">${list
    .map((x) => `<li><button class="al-go" type="button" data-id="${esc(x.key)}">${esc(x.label)}</button></li>`)
    .join('')}</ul></section>`;
});
document.getElementById('alertCount').textContent = alerts.list().length || '';
function setHomeOpen(open) {
  if (home.isOpen() === open) return;
  home.open(open);
  if (open) window.dispatchEvent(new Event('choo:home-open'));
  if (open) markTab('home');
  else if (tab === 'home') markTab('map');
}
document.getElementById('homeClose').onclick = () => setTab('map');

function setTab(name, preset = null) {
  setDisruptOpen(false);
  if (name !== 'home') setHomeOpen(false);
  if (name !== 'alerts') setAlertsOpen(false);
  if (name !== 'departures' && !finderEl.hidden) setFinderOpen(false);
  if (name !== 'buses') setBusPanelOpen(false);
  if (name === 'home' || name === 'buses' || name === 'alerts') setFiltersOpen(false);
  if (name !== 'map' && window.matchMedia('(max-width: 899px)').matches) closeDetail();
  markTab(name);
  if (name === 'home') setHomeOpen(true);
  if (name === 'departures') setFinderOpen(true, preset);
  if (name === 'buses') setBusPanelOpen(true);
  if (name === 'alerts') setAlertsOpen(true);
}
for (const b of document.querySelectorAll('.tabbar [data-tab]')) {
  b.addEventListener('click', () => {
    // Tapping Departures again while it's open keeps it; tapping Map closes everything
    setTab(b.dataset.tab);
  });
}
loadDisruptions();
setInterval(loadDisruptions, 120000);

// Trains and buses on/off
function applyLayers() {
  for (const [id, on] of [['layerTrains', showTrains], ['layerBuses', showBuses]]) document.getElementById(id).setAttribute('aria-pressed', on);
  store.set('showTrains', showTrains);
  store.set('showBuses', showBuses);
  updateCounts();
  busShapes[showBuses ? 'addTo' : 'remove'](map);
}
// Show the switches as they were left (and hide route lines if buses are off)
for (const [id, on] of [['layerTrains', showTrains], ['layerBuses', showBuses]]) document.getElementById(id).setAttribute('aria-pressed', on);
setTimeout(() => !showBuses && busShapes.remove(), 0); // after the bus layer is set up
document.getElementById('layerTrains').onclick = () => {
  showTrains = !showTrains;
  applyLayers();
};
document.getElementById('layerBuses').onclick = () => {
  showBuses = !showBuses;
  applyLayers();
  pollBuses();
};

// A notification was tapped while the app was closed: show that train once it's on the map
const wantTrain = params.get('train');
if (wantTrain) {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (showTrain(wantTrain) || Date.now() - t0 > 20000) clearInterval(iv);
  }, 500);
}

// Open on Home when there's a commute to show, otherwise the map
if (wantTrain) markTab('map');
else if (favs.length && !params.has('demo')) setTab('home');
else markTab('map');

// ---------- Disruption ----------
const disruptPill = document.getElementById('disruptPill');
function disruptedOp(name) {
  const normOp = (n) => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
  const n = normOp(name);
  if (!n) return null;
  return disrupt.lines.find((l) => normOp(l.name) === n || (n.length > 4 && normOp(l.name).includes(n))) || null;
}
async function loadDisruptions() {
  if (DEMO) return;
  try {
    const res = await fetch(`${WORKER}/api/disruptions`);
    const d = await res.json();
    disrupt = d && Array.isArray(d.lines) ? d : { lines: [] };
  } catch {
    return;
  }
  const n = disrupt.lines.length;
  disruptPill.hidden = !n;
  disruptPill.textContent = `⚠ ${n} ${n === 1 ? 'line' : 'lines'} with disruption`;
  renderDisruptions();
  updateCounts();
  home.render();
}
function renderDisruptions() {
  const body = document.getElementById('disruptBody');
  if (!disrupt.lines.length) {
    body.innerHTML = '<p class="bp-intro">Good service on all lines.</p>';
    return;
  }
  const mode = (m) => ({ 'national-rail': 'National Rail', 'elizabeth-line': 'Elizabeth line', overground: 'Overground', dlr: 'DLR', tube: 'Underground' })[m] || m;
  body.innerHTML = `<ul class="dz-list">${disrupt.lines
    .map(
      (l) => `<li class="${l.level <= 6 ? 'bad' : ''}"><b>${esc(l.name)}</b> <span class="dz-sev">${esc(l.severity)}</span><small>${esc(mode(l.mode))}</small>${
        l.reason ? `<p>${esc(l.reason)}</p>` : ''
      }</li>`,
    )
    .join('')}</ul><p class="b-foot">From TfL, which includes National Rail operators. Updated every couple of minutes.</p>`;
}
function setDisruptOpen(open) {
  document.getElementById('disruptPanel').hidden = !open;
  if (open) {
    renderDisruptions();
    setFiltersOpen(false);
    setBusPanelOpen(false);
  }
}
disruptPill.onclick = () => setDisruptOpen(document.getElementById('disruptPanel').hidden);
document.getElementById('disruptClose').onclick = () => setDisruptOpen(false);
/** For Home: disruption on the operators running your trains. */
function disruptionNote(ops) {
  const hit = [...new Set(ops)].map(disruptedOp).filter(Boolean);
  const uniq = [...new Map(hit.map((l) => [l.id, l])).values()];
  if (!uniq.length) return '';
  return `<div class="h-dz">${uniq
    .map((l) => `<p><b>⚠ ${esc(l.name)}: ${esc(l.severity)}</b>${l.reason ? `<small>${esc(l.reason)}</small>` : ''}</p>`)
    .join('')}</div>`;
}

// ---------- Replay the last hour ----------
let replay = null; // { ago (minutes), frame, playing }
const replayBtn = document.getElementById('replayBtn');
const replayBar = document.getElementById('replayBar');
const rpSlider = document.getElementById('rpSlider');
const rpTime = document.getElementById('rpTime');
const rpPlay = document.getElementById('rpPlay');
let rpTimer = null;
let rpFetch = null;

function drawReplay(size, r, labels) {
  drawn = [];
  for (const [id, la, lo, dl, toc, hc] of replay.frame.trains) {
    if (!showTrains || hidden.has(toc in OPERATORS ? toc : 'ZZ')) continue;
    const pt = toScreen(la, lo);
    if (pt.x < -20 || pt.y < -20 || pt.x > size.x + 20 || pt.y > size.y + 20) continue;
    drawTrain({ id: 'rp:' + id, toc, dl, hc, st: 'at' }, pt, { lat: la, lng: lo, dir: null }, r, labels, false);
  }
}

function fetchReplay() {
  clearTimeout(rpFetch);
  rpFetch = setTimeout(async () => {
    const t = now() - replay.ago * 60000;
    rpTime.textContent = replay.ago === 0 ? 'Now' : `${new Date(t).toTimeString().slice(0, 5)} · ${replay.ago} min ago`;
    try {
      const res = await fetch(`${WORKER}/api/replay?t=${Math.round(t)}`);
      const d = await res.json();
      if (!replay) return;
      if (!d.frame) {
        rpTime.textContent = 'Nothing recorded yet';
        return;
      }
      replay.frame = d.frame;
      // How far back the recording goes (the server keeps up to an hour)
      const back = Math.floor((now() - d.from) / 60000);
      rpSlider.min = String(60 - Math.min(60, Math.max(1, back)));
    } catch {}
  }, 120);
}

function setReplay(on) {
  clearInterval(rpTimer);
  if (!on) {
    replay = null;
    replayBar.hidden = true;
    replayBtn.setAttribute('aria-pressed', 'false');
    document.body.classList.remove('replaying');
    connectStatus();
    return;
  }
  closeDetail();
  replay = { ago: 15, frame: null, playing: false };
  rpSlider.value = String(60 - replay.ago);
  replayBar.hidden = false;
  replayBtn.setAttribute('aria-pressed', 'true');
  document.body.classList.add('replaying');
  setStatus('stale', 'Replay');
  fetchReplay();
}
replayBtn.onclick = () => setReplay(!replay);
document.getElementById('rpLive').onclick = () => setReplay(false);
rpSlider.addEventListener('input', () => {
  if (!replay) return;
  replay.ago = 60 - Number(rpSlider.value);
  fetchReplay();
});
rpPlay.onclick = () => {
  if (!replay) return;
  if (rpTimer) {
    clearInterval(rpTimer);
    rpTimer = null;
    rpPlay.textContent = '▶';
    return;
  }
  rpPlay.textContent = '❚❚';
  rpTimer = setInterval(() => {
    if (!replay || replay.ago <= 0) {
      clearInterval(rpTimer);
      rpTimer = null;
      rpPlay.textContent = '▶';
      return;
    }
    replay.ago -= 1;
    rpSlider.value = String(60 - replay.ago);
    fetchReplay();
  }, 800);
};
function connectStatus() {
  setStatus(...lastStatus);
}
if (DEMO) replayBtn.hidden = true;

// ---------- Ding Ding: buses ----------
// Favourite routes show at any zoom; zoomed in, every bus in view. Positions come from the
// worker, worked out from TfL's arrival predictions, and glide between updates.
const BUS_RED = '#d4302a';
const BUS_POLL_MS = 5000;
const busFactsCache = new Map(); // registration → { deck, model, power, … } from TfL's fleet list
let busRoutes = null; // [{ id, n, e: [from, to] }]
let busMeta = { ready: false, configured: true, pending: 0 };
let busShapes = L.layerGroup().addTo(map);
let busTimer = null;
const busStatus = document.getElementById('busNote');

map.attributionControl.addAttribution('Buses: Powered by TfL Open Data');

function busPos(o, t) {
  const f = Math.max(0, Math.min(1, (t - o.t0) / BUS_POLL_MS));
  return { la: o.fla + (o.v.la - o.fla) * f, lo: o.flo + (o.v.lo - o.flo) * f };
}

function busQuery() {
  const q = new URLSearchParams();
  if (busFavs.length) q.set('r', busFavs.join(','));
  if (busesOn && map.getZoom() >= BUS_ZOOM) {
    const b = map.getBounds().pad(0.15);
    q.set('b', [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => x.toFixed(4)).join(','));
  }
  return q;
}

async function pollBuses() {
  clearTimeout(busTimer);
  busTimer = setTimeout(pollBuses, BUS_POLL_MS);
  if (DEMO || document.visibilityState === 'hidden') return;
  const q = busQuery();
  if (!showBuses || ![...q.keys()].length) {
    if (buses.size) {
      buses.clear();
      renderCount();
    }
    renderBusNote();
    return;
  }
  let d;
  try {
    const res = await fetch(`${WORKER}/api/buses?${q}`);
    if (!res.ok) return;
    d = await res.json();
  } catch {
    return;
  }
  skew = d.now - Date.now();
  busMeta = { ready: d.ready, configured: d.configured, pending: d.pending };
  const t = now();
  const seen = new Set();
  for (const b of d.buses) {
    seen.add(b.id);
    const old = buses.get(b.id);
    const cur = old ? busPos(old, t) : null;
    // A big jump (new trip, or a correction) snaps rather than sliding across the map
    const far = cur && Math.hypot(cur.la - b.la, (cur.lo - b.lo) * 0.62) > 0.01;
    buses.set(b.id, { v: b, fla: cur && !far ? cur.la : b.la, flo: cur && !far ? cur.lo : b.lo, t0: t });
  }
  for (const id of buses.keys()) if (!seen.has(id)) buses.delete(id);
  renderCount();
  renderBusNote();
  if (isBus(selectedId)) renderBusHeader();
}
let busMoveTimer = null;
map.on('moveend', () => {
  clearTimeout(busMoveTimer);
  busMoveTimer = setTimeout(pollBuses, 250);
});
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && pollBuses());

function roundRect(x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawBuses(t, size, z) {
  if (!buses.size || !showBuses) return null;
  let sel = null;
  for (const [id, o] of buses) {
    const p = busPos(o, t);
    const pt = toScreen(p.la, p.lo);
    if (pt.x < -30 || pt.y < -30 || pt.x > size.x + 30 || pt.y > size.y + 30) continue;
    drawn.push([pt.x, pt.y, 'bus:' + id]);
    if ('bus:' + id === selectedId) {
      sel = { o, pt };
      continue;
    }
    drawBus(o, pt, z, false);
  }
  return sel;
}

function drawBus(o, pt, z, isSelected) {
  const fav = busFavs.includes(o.v.r);
  const big = z >= BUS_ZOOM || isSelected;
  ctx.font = '700 11px "Work Sans", system-ui, sans-serif';
  const w = big ? Math.max(22, ctx.measureText(o.v.n).width + 10) : 10;
  const h = big ? 17 : 8;
  // Direction of travel: a small arrowhead on the side the bus is heading
  if (o.v.h != null && big) {
    const a = ((o.v.h - 90) * Math.PI) / 180; // degrees from north → screen angle
    const ux = Math.cos(a), uy = Math.sin(a);
    const reach = Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
    ctx.beginPath();
    ctx.moveTo(pt.x + ux * (reach + 6), pt.y + uy * (reach + 6));
    ctx.lineTo(pt.x + ux * reach - uy * 4, pt.y + uy * reach + ux * 4);
    ctx.lineTo(pt.x + ux * reach + uy * 4, pt.y + uy * reach - ux * 4);
    ctx.closePath();
    ctx.fillStyle = BUS_RED;
    ctx.fill();
  }
  if (big) hitBoxes.push([pt.x - w / 2 - 3, pt.y - h / 2 - 4, pt.x + w / 2 + 3, pt.y + h / 2 + 4, 'bus:' + o.v.id]);
  roundRect(pt.x - w / 2, pt.y - h / 2, w, h, big ? 4 : 2.5);
  ctx.fillStyle = BUS_RED;
  ctx.fill();
  // Double deckers: a dark band along the top, like the upper deck's windows
  if (big && o.v.k === 'D') {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(20, 10, 10, 0.55)';
    ctx.fillRect(pt.x - w / 2, pt.y - h / 2, w, 4);
    ctx.restore();
    roundRect(pt.x - w / 2, pt.y - h / 2, w, h, 4);
  }
  ctx.lineWidth = isSelected ? 3 : fav ? 2 : 1.4;
  ctx.strokeStyle = isSelected ? '#efeadb' : fav ? '#d4a64a' : '#1f3229';
  ctx.stroke();
  if (big) {
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(o.v.n, pt.x, pt.y + 4);
    ctx.textAlign = 'start';
  }
  // A bus you've ridden before gets a little gold badge
  if (ridden.has(o.v.id)) {
    ctx.beginPath();
    ctx.arc(pt.x + w / 2, pt.y - h / 2, big ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#d4a64a';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#1f3229';
    ctx.stroke();
  }
}

// ---------- Bus details ----------
function renderBusHeader() {
  const o = buses.get(selectedId.slice(4));
  if (!o) {
    dState.textContent = 'No longer being tracked';
    return;
  }
  const v = o.v;
  dHead.textContent = v.n;
  const facts = busFactsCache.get(v.id);
  const deckName = facts?.deck || (v.k === 'D' ? 'Double decker' : v.k === 'S' ? 'Single decker' : 'London bus');
  dOp.innerHTML = `<span class="sw" style="--c:${BUS_RED}"></span>${esc(deckName)}`;
  dRoute.textContent = v.d ? `To ${v.d}` : `Route ${v.n}`;
  const r = busRoutes && busRoutes.find((x) => x.id === v.r);
  const mine = ridesOn(v.id);
  dFrom.innerHTML = `${esc(r ? `Route ${v.n} · ${r.e[0]} – ${r.e[1]}` : `Route ${v.n}`)} · <span class="reg">${esc(v.id)}</span>${
    mine.length ? `<span class="been">You’ve been on this bus ${mine.length === 1 ? 'once' : `${mine.length} times`}</span>` : ''
  }${
    facts
      ? `<span class="facts">${[facts.model, facts.power, facts.length ? `${facts.length} m` : '', facts.fleetNo ? `${facts.operator} ${facts.fleetNo}` : facts.operator, facts.year ? `from ${facts.year}` : '']
          .filter(Boolean)
          .map(esc)
          .join(' · ')}</span>`
      : ''
  }`;
  const fav = busFavs.includes(v.r);
  const onNow = mine.length && Date.now() - mine[0].at < RIDE_SAME_MS;
  dState.innerHTML = `Next stop ${esc(v.nx)}${v.m <= 0 ? ', due now' : ` in ${v.m} min`}<button class="pill star" id="busStar" aria-pressed="${fav}">${fav ? '★ Saved route' : '☆ Save route'}</button><button class="pill star" id="busRide" aria-pressed="${Boolean(onNow)}">${
    onNow ? `✓ On board (ride ${mine.length})` : '🚌 I’m on this bus'
  }</button>`;
  document.getElementById('busStar').onclick = () => toggleBusFav(v.r);
  document.getElementById('busRide').onclick = () => logRide(v);
  dFoot.textContent = 'Estimated position · TfL Open Data';
  dFoot.classList.add('tiny');
}

async function loadBusCalls() {
  const id = selectedId.slice(4);
  let d = null;
  try {
    const res = await fetch(`${WORKER}/api/bus/${encodeURIComponent(id)}`);
    if (res.ok) d = await res.json();
  } catch {}
  if (!d || 'bus:' + d.id !== selectedId) return;
  if (d.facts && !busFactsCache.has(d.id)) {
    busFactsCache.set(d.id, d.facts);
    renderBusHeader();
  }
  const nextIdx = d.stops.findIndex((s) => !s.done);
  dCalls.innerHTML = d.stops
    .map(
      (s, i) =>
        `<li class="${s.done ? 'done' : ''} ${i === nextIdx ? 'next' : ''}"><span class="t">${s.s || ''}</span><span class="n">${esc(s.n)}${
          i === nextIdx ? '<span class="tag">Next</span>' : ''
        }</span><span class="e">${s.done ? '' : `<span class="x">${s.m <= 0 ? 'due' : `${s.m} min`}</span>`}</span></li>`,
    )
    .reverse()
    .join('');
  const cur = dCalls.querySelector('li.next');
  const curKey = cur ? cur.textContent.replace(/\d+ min|due/, '') : '';
  const firstOpen = scrolledFor !== selectedId;
  if (cur && (firstOpen || curKey !== anchoredStop || Date.now() - userScrolledAt > 8000)) {
    autoScrollAt = Date.now();
    cur.scrollIntoView({ block: 'center', behavior: firstOpen ? 'auto' : 'smooth' });
  }
  scrolledFor = selectedId;
  anchoredStop = curKey;
  if (routeLine) routeLine.remove();
  routeLine = L.polyline(d.path, { color: BUS_RED, weight: 3, opacity: 0.8, dashArray: '2 7', interactive: false }).addTo(map);
}

// ---------- Favourite routes and the Ding Ding panel ----------
const busPanel = document.getElementById('busPanel');
const busSearch = document.getElementById('busSearch');
const busResults = document.getElementById('busResults');
const busFavList = document.getElementById('busFavList');
const busAll = document.getElementById('busAll');

function setBusPanelOpen(open) {
  const panel = document.getElementById('busPanel');
  if (!panel) return;
  if (open) setFiltersOpen(false);
  panel.classList.toggle('open', open);
  if (open) markTab('buses');
  else if (tab === 'buses') markTab('map');
  if (open) {
    loadBusRoutes().then(renderBusLists);
    renderBusNote();
    renderMyBuses();
    refreshFavStops();
  }
}
document.getElementById('busClose').onclick = () => setTab('map');

async function loadBusRoutes() {
  if (busRoutes && busRoutes.length) return busRoutes;
  if (DEMO) return (busRoutes = []);
  try {
    const res = await fetch(`${WORKER}/api/busroutes`);
    busRoutes = await res.json();
  } catch {
    busRoutes = null;
  }
  return busRoutes;
}

const routeName = (id) => busRoutes?.find((r) => r.id === id)?.n || id.toUpperCase();
const routeEnds = (id) => {
  const e = busRoutes?.find((r) => r.id === id)?.e;
  return e ? `${esc(e[0])} – ${esc(e[1])}` : '';
};

function busRow(id) {
  const fav = busFavs.includes(id);
  const count = [...buses.values()].filter((o) => o.v.r === id).length;
  return `<li><button class="bp-star" data-route="${esc(id)}" aria-pressed="${fav}" aria-label="${fav ? 'Remove' : 'Save'} route ${esc(routeName(id))}">${fav ? '★' : '☆'}</button>
    <span class="bp-num">${esc(routeName(id))}</span><span class="bp-ends">${routeEnds(id)}</span>${fav && count ? `<span class="n">${count}</span>` : ''}</li>`;
}

function renderBusLists() {
  const q = busSearch.value.trim().toLowerCase();
  if (q && busRoutes) {
    const hits = busRoutes
      .filter((r) => r.n.toLowerCase().startsWith(q) || r.id === q)
      .sort((a, b) => (a.n.toLowerCase() === q ? -1 : b.n.toLowerCase() === q ? 1 : 0) || a.n.length - b.n.length)
      .slice(0, 12);
    busResults.innerHTML = hits.length ? hits.map((r) => busRow(r.id)).join('') : '<li class="bp-empty">No route with that number</li>';
  } else busResults.innerHTML = '';
  busFavList.innerHTML = busFavs.length
    ? busFavs.map(busRow).join('')
    : '<li class="bp-empty">No saved routes yet. Search for a route number above, or tap a bus on the map and save its route.</li>';
  document.getElementById('busSummary').textContent = busFavs.length ? busFavs.length : '';
}
busSearch.addEventListener('input', renderBusLists);
for (const list of [busResults, busFavList]) {
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-route]');
    if (b) toggleBusFav(b.dataset.route);
  });
}

function toggleBusFav(id) {
  busFavs = busFavs.includes(id) ? busFavs.filter((x) => x !== id) : [...busFavs, id];
  store.set('busFavs', busFavs);
  renderBusLists();
  drawBusShapes();
  if (isBus(selectedId)) renderBusHeader();
  pollBuses();
}

busAll.checked = busesOn;
busAll.addEventListener('change', () => {
  busesOn = busAll.checked;
  store.set('busesOn', busesOn);
  pollBuses();
});

function renderBusNote() {
  if (!busPanel.classList.contains('open')) return;
  let t = '';
  if (DEMO) t = 'Buses aren’t simulated in demo mode.';
  else if (!busMeta.configured) t = 'Buses will appear once a TfL key is added to the server.';
  else if (!busMeta.ready) t = 'Loading London’s bus routes. This takes a few minutes the first time.';
  else if (busMeta.pending) t = 'Getting live positions…';
  else if (busesOn && map.getZoom() < BUS_ZOOM) t = busFavs.length ? 'Showing your routes. Zoom in to see every bus.' : 'Zoom in to see every bus.';
  busStatus.textContent = t;
}
map.on('zoomend', renderBusNote);

// Favourite routes are drawn as faint lines so you can see where they go
async function drawBusShapes() {
  busShapes.clearLayers();
  if (DEMO || !busFavs.length) return;
  try {
    const res = await fetch(`${WORKER}/api/busshapes?r=${busFavs.map(encodeURIComponent).join(',')}`);
    const shapes = await res.json();
    for (const dirs of Object.values(shapes)) {
      for (const pts of dirs) L.polyline(pts, { color: BUS_RED, weight: 3, opacity: 0.28, interactive: false }).addTo(busShapes);
    }
  } catch {}
}

if (busFavs.length) loadBusRoutes().then(renderBusLists);
else renderBusLists();
drawBusShapes();
pollBuses();

// ---------- My buses: the physical buses you've ridden (by registration) ----------
const RIDE_SAME_MS = 45 * 60000; // tapping again within this counts as the same ride
let rides = store.get('rides', []); // newest first: [{ reg, route, name, dest, at }]
let ridden = new Set(rides.map((x) => x.reg));
const ridesOn = (reg) => rides.filter((x) => x.reg === reg);

function saveRides() {
  store.set('rides', rides);
  ridden = new Set(rides.map((x) => x.reg));
  renderMyBuses();
  if (isBus(selectedId)) renderBusHeader();
}

function logRide(v) {
  const last = ridesOn(v.id)[0];
  if (last && Date.now() - last.at < RIDE_SAME_MS) {
    // Tapped again on the same ride: undo it
    rides = rides.filter((x) => x !== last);
  } else {
    const f = busFactsCache.get(v.id);
    rides = [{ reg: v.id, route: v.r, name: v.n, dest: v.d, at: Date.now(), deck: f?.deck || null, model: f?.model || null }, ...rides].slice(0, 1000);
  }
  saveRides();
}

function renderMyBuses() {
  const el = document.getElementById('myBuses');
  if (!el) return;
  if (!rides.length) {
    el.innerHTML = '<p class="bp-intro">When you’re on a bus, tap it on the map and choose <b>🚌 I’m on this bus</b>. Choo Choo remembers the bus itself (by its registration), so you’ll see when you get the same one again. Buses you’ve ridden show a gold dot on the map.</p>';
    return;
  }
  const byReg = new Map();
  for (const x of rides) {
    const b = byReg.get(x.reg) || { reg: x.reg, n: 0, routes: new Map(), last: x.at, model: x.model, deck: x.deck };
    b.n++;
    b.routes.set(x.name, (b.routes.get(x.name) || 0) + 1);
    byReg.set(x.reg, b);
  }
  const top = [...byReg.values()].sort((a, b) => b.n - a.n || b.last - a.last);
  const repeat = top.filter((b) => b.n > 1).length;
  const day = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const onMap = top.filter((b) => buses.has(b.reg));
  el.innerHTML = `
    <p class="mb-sum"><b>${rides.length}</b> ${rides.length === 1 ? 'ride' : 'rides'} on <b>${byReg.size}</b> different ${byReg.size === 1 ? 'bus' : 'buses'}${
      repeat ? ` · <b>${repeat}</b> you’ve had more than once` : ''
    }</p>
    ${onMap.length ? `<p class="mb-near">🚌 ${onMap.map((b) => `<b>${esc(b.reg)}</b>`).join(', ')} ${onMap.length === 1 ? 'is' : 'are'} on the map right now</p>` : ''}
    <ul class="bp-list mb-list">${top
      .slice(0, 12)
      .map(
        (b) => `<li><span class="mb-n">${b.n}×</span><span class="reg">${esc(b.reg)}</span><span class="bp-ends">${[...b.routes]
          .map(([r, n]) => `${esc(r)}${n > 1 ? ` ×${n}` : ''}`)
          .join(', ')} · last ${day(b.last)}${b.model ? `<small>${esc(b.model)}${b.deck ? ` · ${esc(b.deck.toLowerCase())}` : ''}</small>` : ''}</span></li>`,
      )
      .join('')}</ul>
    <details class="mb-recent"><summary>Recent rides</summary><ul class="bp-list">${rides
      .slice(0, 20)
      .map(
        (x, i) => `<li><span class="bp-num">${esc(x.name)}</span><span class="bp-ends">${esc(x.reg)} · ${day(x.at)} ${new Date(x.at).toTimeString().slice(0, 5)}${
          x.dest ? ` · to ${esc(x.dest)}` : ''
        }</span><button class="al-rm" type="button" data-ride="${i}" aria-label="Remove this ride">×</button></li>`,
      )
      .join('')}</ul></details>`;
}
document.getElementById('myBuses').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ride]');
  if (!b) return;
  rides.splice(Number(b.dataset.ride), 1);
  saveRides();
});
renderMyBuses();

// ---------- Bus stops: tap one for what's due, save your favourites ----------
const STOP_ZOOM = 16;
let mapStops = []; // [{ i, n, la, lo, r }] in the current view
let drawnStops = [];
let stopFavs = store.get('busStopFavs', []); // [{ i, n }]
const stopBoards = new Map(); // id → board from the worker
let stopTimer = null;

async function loadMapStops() {
  if (DEMO || !showBuses || map.getZoom() < STOP_ZOOM) {
    mapStops = [];
    return;
  }
  const b = map.getBounds().pad(0.1);
  try {
    const res = await fetch(`${WORKER}/api/stops?b=${[b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => x.toFixed(4)).join(',')}`);
    const d = await res.json();
    if (Array.isArray(d)) mapStops = d;
  } catch {}
}
let stopMoveTimer = null;
map.on('moveend', () => {
  clearTimeout(stopMoveTimer);
  stopMoveTimer = setTimeout(loadMapStops, 300);
});

function drawBusStops(size, z) {
  drawnStops = [];
  if (z < STOP_ZOOM || !showBuses || !mapStops.length) return;
  ctx.font = '600 10px "Work Sans", system-ui, sans-serif';
  for (const st of mapStops) {
    const pt = toScreen(st.la, st.lo);
    if (pt.x < -10 || pt.y < -10 || pt.x > size.x + 10 || pt.y > size.y + 10) continue;
    drawnStops.push([pt.x, pt.y, st.i]);
    const fav = stopFavs.some((f) => f.i === st.i);
    // A bus stop sign: white disc with a red ring (gold for your saved stops)
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = fav ? '#d4a64a' : BUS_RED;
    ctx.stroke();
    if (z >= 17) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(22,39,32,0.8)';
      ctx.strokeText(st.n, pt.x + 7, pt.y + 4);
      ctx.fillStyle = '#f3e9e7';
      ctx.fillText(st.n, pt.x + 7, pt.y + 4);
    }
  }
}

async function fetchStop(id) {
  try {
    const res = await fetch(`${WORKER}/api/stop/${encodeURIComponent(id)}`);
    const d = await res.json();
    if (!d.error) stopBoards.set(id, d);
    return d;
  } catch {
    return null;
  }
}

const deckShort = (f) => (f && f.deck ? (f.deck.startsWith('Double') ? 'Double decker' : 'Single decker') : '');

function renderStopHeader() {
  const id = selectedId.slice(5);
  const d = stopBoards.get(id);
  const fav = stopFavs.some((f) => f.i === id);
  dHead.textContent = 'Bus stop';
  dOp.innerHTML = `<span class="sw" style="--c:${BUS_RED}"></span>${d ? esc(d.routes.join(', ')) : ''}`;
  dRoute.textContent = d ? d.name : 'Bus stop';
  dFrom.textContent = d && d.towards ? `Towards ${d.towards}` : '';
  dState.innerHTML = `<button class="pill star" id="stopStar" aria-pressed="${fav}">${fav ? '★ Saved stop' : '☆ Save stop'}</button>`;
  document.getElementById('stopStar').onclick = () => toggleStopFav(id, d ? d.name : id);
  dFoot.textContent = 'Live times from TfL. Bus details from TfL’s fleet list.';
  dFoot.classList.add('tiny');
}

function depRow(r) {
  const f = r.facts;
  const about = [deckShort(f), f && f.model, f && f.power].filter(Boolean).map(esc).join(' · ');
  return `<li class="dep" data-reg="${esc(r.reg)}"><span class="bp-num">${esc(r.route)}</span><span class="dp-main"><b>${esc(r.dest)}</b><small><span class="reg">${esc(r.reg)}</span>${about ? ` ${about}` : ''}</small></span><span class="dp-when"><b>${r.m <= 0 ? 'Due' : `${r.m} min`}</b><small>${esc(r.at)}</small></span></li>`;
}

async function loadStopBoard() {
  const id = selectedId.slice(5);
  const d = await fetchStop(id);
  if (selectedId !== 'stop:' + id) return;
  renderStopHeader();
  if (!d || d.error) {
    dCalls.innerHTML = `<li class="dep-empty">${esc((d && d.error) || 'Couldn’t get the times for this stop.')}</li>`;
    return;
  }
  dCalls.innerHTML = d.rows.length ? d.rows.map(depRow).join('') : '<li class="dep-empty">No buses due in the next half hour or so.</li>';
  if (routeLine) routeLine.remove();
  routeLine = null;
}
// Tap a departure: show that bus on the map, if it's there
dCalls.addEventListener('click', (e) => {
  const li = e.target.closest('li.dep');
  if (!li || !isStop(selectedId)) return;
  const reg = li.dataset.reg;
  if (buses.has(reg)) {
    const o = buses.get(reg);
    select('bus:' + reg);
    map.setView([o.v.la, o.v.lo], Math.max(map.getZoom(), 15));
  }
});

function openStop(id, la, lo) {
  setTab('map');
  select('stop:' + id);
  if (la && lo) map.setView([la, lo], Math.max(map.getZoom(), 16));
}

function toggleStopFav(id, name) {
  stopFavs = stopFavs.some((f) => f.i === id) ? stopFavs.filter((f) => f.i !== id) : [...stopFavs, { i: id, n: name }].slice(0, 12);
  store.set('busStopFavs', stopFavs);
  if (selectedId === 'stop:' + id) renderStopHeader();
  renderStopFavs();
  refreshFavStops();
}

/** Your saved stops, with their next few buses (Ding Ding panel and Home). */
function favStopsHtml(per = 3) {
  return stopFavs
    .map((f) => {
      const d = stopBoards.get(f.i);
      const rows = d ? d.rows.slice(0, per) : [];
      return `<div class="sf"><button class="sf-head" type="button" data-stop="${esc(f.i)}"><b>${esc(d ? d.name : f.n)}</b>${d && d.towards ? `<small>towards ${esc(d.towards)}</small>` : ''}</button>
        <ul class="sf-rows">${
          d ? (rows.length ? rows.map(depRow).join('') : '<li class="dep-empty">Nothing due soon</li>') : '<li class="dep-empty">…</li>'
        }</ul></div>`;
    })
    .join('');
}

function renderStopFavs() {
  const el = document.getElementById('busStopFavs');
  el.innerHTML = stopFavs.length
    ? favStopsHtml(3)
    : '<p class="bp-intro">Zoom right in on the map to see bus stops, tap one, then ☆ Save stop. Its next buses show here and on Home.</p>';
}
for (const id of ['busStopFavs', 'stopsNear']) {
  document.getElementById(id).addEventListener('click', (e) => {
    const b = e.target.closest('[data-stop]');
    if (b) {
      const d = stopBoards.get(b.dataset.stop);
      openStop(b.dataset.stop, d?.la || Number(b.dataset.la), d?.lo || Number(b.dataset.lo));
    }
  });
}

async function refreshFavStops() {
  clearTimeout(stopTimer);
  stopTimer = setTimeout(refreshFavStops, 30000);
  const panelOpen = document.getElementById('busPanel').classList.contains('open');
  if (DEMO || !stopFavs.length || !(panelOpen || home.isOpen()) || document.visibilityState === 'hidden') return;
  await Promise.all(stopFavs.map((f) => fetchStop(f.i)));
  renderStopFavs();
  home.render();
}

document.getElementById('stopsNearBtn').onclick = () => {
  const out = document.getElementById('stopsNear');
  if (!navigator.geolocation) return (out.innerHTML = '<li class="bp-empty">Location isn’t available on this device.</li>');
  out.innerHTML = '<li class="bp-empty">Finding stops near you…</li>';
  navigator.geolocation.getCurrentPosition(
    async (p) => {
      try {
        const res = await fetch(`${WORKER}/api/stops?la=${p.coords.latitude.toFixed(5)}&lo=${p.coords.longitude.toFixed(5)}`);
        const list = await res.json();
        out.innerHTML = list.length
          ? list
              .map(
                (st) => `<li><button class="sf-head" type="button" data-stop="${esc(st.i)}" data-la="${st.la}" data-lo="${st.lo}"><b>${esc(st.n)}</b><small>${st.d} m · ${esc(st.r.join(', '))}</small></button></li>`,
              )
              .join('')
          : '<li class="bp-empty">No bus stops within a short walk.</li>';
      } catch {
        out.innerHTML = '<li class="bp-empty">Couldn’t look up stops.</li>';
      }
    },
    () => (out.innerHTML = '<li class="bp-empty">Couldn’t find your location.</li>'),
    { timeout: 8000, maximumAge: 120000 },
  );
};

home.addSection(() => {
  if (!stopFavs.length) return '';
  return `<section class="h-card"><h3 class="h-head">Your bus stops</h3>${favStopsHtml(2)}</section>`;
});
document.getElementById('homeBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-stop]');
  if (b) {
    const d = stopBoards.get(b.dataset.stop);
    openStop(b.dataset.stop, d?.la, d?.lo);
  }
});
renderStopFavs();
refreshFavStops();
window.addEventListener('choo:home-open', () => refreshFavStops());
loadMapStops();

// ---------- Where you are ----------
let me = null; // { la, lo, acc (m) }
let meWatch = null;
let meCentreNext = false;
const locateBtn = document.getElementById('locateBtn');

function drawMe() {
  if (!me) return;
  const pt = toScreen(me.la, me.lo);
  // Accuracy circle, sized in metres
  const edge = toScreen(me.la, me.lo + me.acc / (111320 * Math.cos((me.la * Math.PI) / 180)));
  const rad = Math.abs(edge.x - pt.x);
  if (rad > 10) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(74, 144, 226, 0.12)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(74, 144, 226, 0.35)';
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#4a90e2';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function startMe(centre) {
  if (!navigator.geolocation) return;
  meCentreNext = centre;
  locateBtn.classList.add('busy');
  if (meWatch == null) {
    meWatch = navigator.geolocation.watchPosition(
      (p) => {
        me = { la: p.coords.latitude, lo: p.coords.longitude, acc: p.coords.accuracy || 0 };
        locateBtn.classList.remove('busy');
        locateBtn.setAttribute('aria-pressed', 'true');
        store.set('locOn', true);
        if (meCentreNext) {
          meCentreNext = false;
          map.setView([me.la, me.lo], Math.max(map.getZoom(), 15));
        }
      },
      (err) => {
        locateBtn.classList.remove('busy');
        if (err.code === 1) {
          // Location turned off for this site
          stopMe();
          store.set('locOn', false);
        }
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
  } else if (me && centre) {
    meCentreNext = false;
    locateBtn.classList.remove('busy');
    map.setView([me.la, me.lo], Math.max(map.getZoom(), 15));
  }
}
function stopMe() {
  if (meWatch != null) navigator.geolocation.clearWatch(meWatch);
  meWatch = null;
  me = null;
  locateBtn.setAttribute('aria-pressed', 'false');
}
// Tap: show where you are and go there (tap again to come back to it)
locateBtn.onclick = () => startMe(true);
// If you allowed it before, show your dot straight away (no prompt)
if (store.get('locOn', false) && navigator.permissions) {
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((r) => r.state === 'granted' && startMe(false))
    .catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  // Save battery: stop watching while the app is in the background
  if (document.visibilityState === 'hidden' && meWatch != null) {
    navigator.geolocation.clearWatch(meWatch);
    meWatch = null;
  } else if (document.visibilityState === 'visible' && me) startMe(false);
});

window.chooStarted = true;
