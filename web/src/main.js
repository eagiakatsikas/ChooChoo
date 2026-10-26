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
// Simple line icons used across the app (instead of emoji)
const svg = (d, extra = '') => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
const ICON = {
  warn: svg('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
  star: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),
  starOn: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" fill="currentColor"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  follow: svg('<path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="6.5"/>'),
  bus: svg('<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14M8 18v2M16 18v2"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>'),
  pause: svg('<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>'),
  swap: svg('<path d="M7 4v16M7 4 3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4"/>'),
  dest: svg('<path d="M4 12h14M13 7l5 5-5 5"/>'),
  rail: svg('<path d="M5 20 9 4M19 20 15 4M7 15h10M8 10h8"/>'),
  stop: svg('<circle cx="12" cy="9" r="5.5"/><path d="M12 14.5V21"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
};
/** "updated 20s ago", kept ticking by the timer below. */
function fresh(at) {
  return `<span class="fresh" data-at="${Math.round(at)}">${agoText(at)}</span>`;
}
function agoText(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 10 ? 'updated just now' : s < 60 ? `updated ${s}s ago` : `updated ${Math.round(s / 60)} min ago`;
}
setInterval(() => {
  for (const el of document.querySelectorAll('.fresh[data-at]')) el.textContent = agoText(Number(el.dataset.at));
}, 5000);
const isStop = (id) => typeof id === 'string' && id.startsWith('stop:');
const isStn = (id) => typeof id === 'string' && id.startsWith('stn:');
const isRoute = (id) => typeof id === 'string' && id.startsWith('route:');
/** Places and routes (not things that move): the sheet shows a board, not a journey. */
const isPlace = (id) => isStop(id) || isStn(id) || isRoute(id);
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
let tab = 'map'; // bottom navigation: home (Now), map, search
let showTrains = store0('showTrains', true);
let showBuses = store0('showBuses', true);
const boardCrs = new Map(); // train id → the station you'd board at (when opened from a board)
let disrupt = { lines: [] }; // line status from the worker

// ---------- Map ----------
const lastView = store0('mapView', null); // where you left the map
const map = L.map('map', {
  center: lastView ? lastView.c : [51.505, -0.12],
  zoom: lastView ? lastView.z : 11,
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
    if (box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) return openBoard(crs, undefined, false);
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
  if (stn && (!best || stnD < 6)) return openBoard(stn, undefined, false);
  // A bus stop's name, tapped directly
  for (const [, , id, box] of drawnStops) {
    if (box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) return select('stop:' + id);
  }
  // A bus stop's dot, if it's at least as close as any train or bus
  let stop = null;
  let stopD = 18;
  for (const [px, py, id] of drawnStops) {
    const d = Math.hypot(px - x, py - y);
    if (d < stopD) {
      stop = id;
      stopD = d;
    }
  }
  if (stop && (!best || stopD <= bestD || stopD < 9)) return select('stop:' + stop);
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
  statusEl.title = text;
}

let trainsShown = 0;
function renderCount() {
  const nb = showBuses ? buses.size : 0;
  // The counts in the top bar double as on/off switches
  const qt = document.getElementById('qtTrains');
  const qb = document.getElementById('qtBuses');
  qt.setAttribute('aria-pressed', showTrains);
  qt.querySelector('.qt-t').textContent = showTrains ? `${trainsShown} ${trainsShown === 1 ? 'train' : 'trains'}` : 'Trains off';
  qb.setAttribute('aria-pressed', showBuses);
  qb.querySelector('.qt-t').textContent = showBuses ? `${nb} ${nb === 1 ? 'bus' : 'buses'}` : 'Buses off';
  if (selectedId && isRoute(selectedId)) renderRouteHeader();
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
        disruptedOp(opName(code)) ? ` <span class="op-warn" title="${esc(disruptedOp(opName(code)).severity)}">${ICON.warn}</span>` : ''
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
  summaryEl.textContent = on === total ? 'All' : `${on} of ${total}`;
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
toggleBtn.onclick = () => {
  setLayersOpen(false);
  setFiltersOpen(true);
};
document.getElementById('filtersClose').onclick = () => setFiltersOpen(false);
// On wide screens the filter panel starts open
// (The Operators list opens from the Layers sheet)

// ---------- Train details ----------
const detailEl = document.getElementById('detail');
const dHead = document.getElementById('dHeadcode');
const dOp = document.getElementById('dOp');
const dRoute = document.getElementById('dRoute');
const dFrom = document.getElementById('dFrom');
const dState = document.getElementById('dState');
const dCalls = document.getElementById('dCalls');
const dFoot = document.getElementById('dFoot');
const dActs = document.getElementById('dActs');
const dBoard = document.getElementById('dBoard');
const dPick = document.getElementById('dPick');
let peekRoute = null; // a bus route you're looking at, shown live even if you haven't starred it
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
  const kind = isStop(selectedId) ? 'stop' : isStn(selectedId) ? 'stn' : isRoute(selectedId) ? 'route' : isBus(selectedId) ? 'bus' : 'train';
  detailEl.dataset.kind = kind;
  dCalls.classList.toggle('deps', kind === 'stop' || kind === 'route');
  dCalls.hidden = kind === 'stn';
  dBoard.hidden = kind !== 'stn';
  if (kind !== 'stn') dPick.hidden = true;
  if (kind === 'stop') return renderStopHeader();
  if (kind === 'stn') return renderStationHeader();
  if (kind === 'route') return renderRouteHeader();
  if (kind === 'bus') return renderBusHeader();
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
  const on = alerts && alerts.has(selectedId);
  setActs([
    !DEMO && act('alert', on ? `${ICON.bell} Alert on` : `${ICON.bell} Alert me`, on),
    act('follow', following === selectedId ? `${ICON.follow} Following` : `${ICON.follow} Follow`, following === selectedId),
  ]);
}

/** One button in the sheet's row of actions. */
function act(name, html, on = false, extra = '') {
  return `<button class="act" type="button" data-act="${name}" aria-pressed="${Boolean(on)}"${extra}>${html}</button>`;
}
function setActs(list) {
  const html = list.filter(Boolean).join('');
  if (dActs.innerHTML !== html) dActs.innerHTML = html;
  dActs.hidden = !html;
}

async function loadCalls() {
  if (isBus(selectedId)) return loadBusCalls();
  if (isStop(selectedId)) return loadStopBoard();
  if (isStn(selectedId)) return loadBoard();
  if (isRoute(selectedId)) return loadRoute();
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

let detailFrom = null; // the tab you were on when you opened a sheet from a list
function select(id) {
  if (!selectedId) window.__detailDrag?.reset();
  if (!selectedId && tab !== 'map') detailFrom = tab;
  if (following && following !== id) setFollow(null);
  if (selectedId !== id) {
    dCalls.innerHTML = '';
    dBoard.innerHTML = '';
    dState.innerHTML = '';
    dFrom.textContent = '';
    dActs.innerHTML = '';
    dPick.hidden = true;
    if (routeLine) routeLine.remove();
    routeLine = null;
  }
  const wasRoute = peekRoute;
  peekRoute = isRoute(id) ? id.slice(6) : null;
  if (peekRoute !== wasRoute) pollBuses();
  selectedId = id;
  detailEl.hidden = false;
  setLayersOpen(false);
  if (window.matchMedia('(max-width: 899px)').matches) {
    setFiltersOpen(false);
    setBusPanelOpen(false);
    if (tab !== 'map') setTab('map', true);
  }
  renderDetailHeader();
  loadCalls();
  clearInterval(detailTimer);
  detailTimer = setInterval(() => {
    renderDetailHeader();
    loadCalls();
  }, isStn(id) ? 30000 : 15000);
}

/** Close the sheet. byYou: you closed it, so go back to where you came from. */
function closeDetail(byYou = false) {
  const back = byYou === true && detailFrom && window.matchMedia('(max-width: 899px)').matches ? detailFrom : null;
  detailFrom = null;
  selectedId = null;
  if (peekRoute) {
    peekRoute = null;
    pollBuses();
  }
  setFollow(null);
  detailEl.hidden = true;
  clearInterval(detailTimer);
  if (routeLine) routeLine.remove();
  routeLine = null;
  if (back && back !== 'map') setTab(back);
}
document.getElementById('detailClose').onclick = () => closeDetail(true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDetail();
    setBusPanelOpen(false);
    setLayersOpen(false);
  }
});

/** Put a place on the map where the sheet won't cover it (phones: in the top part). */
function showOnMap(la, lo, z) {
  const zoom = Math.max(map.getZoom(), z);
  if (!window.matchMedia('(max-width: 899px)').matches) return map.setView([la, lo], zoom);
  const p = map.project([la, lo], zoom).add([0, map.getSize().y * 0.22]);
  map.setView(map.unproject(p, zoom), zoom);
}

// The sheet's actions: star, alert, follow, I'm on it, destination
dActs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !selectedId) return;
  const a = b.dataset.act;
  if (a === 'follow') return setFollow(following ? null : selectedId);
  if (a === 'alert') {
    const own = alerts.list().find((x) => x.key === selectedId);
    if (own) alerts.remove(own.id);
    else alerts.watch(selectedId, boardCrs.get(selectedId) || null);
    return;
  }
  if (a === 'busstar') {
    const o = buses.get(selectedId.slice(4));
    if (o) toggleBusFav(o.v.r);
    return;
  }
  if (a === 'ride') {
    const o = buses.get(selectedId.slice(4));
    if (o) logRide(o.v);
    return;
  }
  if (a === 'stopstar') {
    const id = selectedId.slice(5);
    const d = stopBoards.get(id);
    return toggleStopFav(id, d ? d.name : id);
  }
  if (a === 'routestar') return toggleBusFav(selectedId.slice(6));
  if (a === 'stnstar') return toggleFav();
  if (a === 'to') return openPicker();
  if (a === 'clearto') return setTo(null);
});

// ---------- Feeding data in ----------
function replaceAll(list) {
  trains.clear();
  for (const v of list) trains.set(v.id, v);
  afterUpdate();
}

function afterUpdate() {
  updateCounts();
  if (selectedId && !isBus(selectedId) && !isPlace(selectedId)) {
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

let offlineTimer = null;
function connect() {
  setStatus('connecting', 'Connecting');
  const es = new EventSource(`${WORKER}/api/stream`);
  es.addEventListener('snapshot', (e) => {
    clearTimeout(offlineTimer);
    document.getElementById('offline').hidden = true;
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
  es.onerror = () => {
    setStatus('connecting', 'Reconnecting');
    // Still nothing after a while: say so plainly
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => (document.getElementById('offline').hidden = false), 20000);
  };
}

// Re-render "x seconds ago" text
setInterval(() => selectedId && !isPlace(selectedId) && renderDetailHeader(), 5000);

// ---------- Stations: the list, searching it, and a station's board ----------
let stations = null; // [{c, n, la, lo}]
let stationsLoading = null;
// Starred stations and train routes, one list: { f: from, t: to or null for the whole station }
let favs = store.get('favs', []);
const stn = { from: null, to: null }; // the station sheet that's open
let toFor = store.get('toFor', {}); // the destination you last picked at each station

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

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

const isFav = (f = stn.from, t = stn.to) => favs.some((x) => x.f === f && (x.t || null) === (t || null));

function toggleFav() {
  if (!stn.from) return;
  if (isFav()) favs = favs.filter((x) => !(x.f === stn.from && (x.t || null) === (stn.to || null)));
  else favs = [{ f: stn.from, t: stn.to || null }, ...favs].slice(0, 16);
  store.set('favs', favs);
  renderStationHeader();
  home.render();
}

function expText(r) {
  if (r.cancelled) return ['Cancelled', 'cancel'];
  if (r.etdTime && r.etdTime !== r.std) return [`Exp ${r.etdTime}`, 'late'];
  if (/delay/i.test(r.etd || '')) return ['Delayed', 'late'];
  return ['On time', ''];
}

let lastBoard = null;

function renderStationHeader() {
  const s = byCrs(stn.from);
  const to = stn.to && byCrs(stn.to);
  dHead.textContent = 'Station';
  dOp.textContent = stn.from || '';
  dRoute.textContent = s ? s.n : stn.from || '';
  dFrom.textContent = to ? `Direct trains to ${to.n}` : 'Every train leaving';
  dState.innerHTML = '';
  const on = isFav();
  setActs([
    act('stnstar', on ? `${ICON.starOn} Starred` : `${ICON.star} Star`, on, ` title="${to ? 'Star this route' : 'Star this station'}"`),
    act('to', `${ICON.dest} ${to ? `To ${esc(short(to.n))}` : 'Where to?'}`, Boolean(to)),
    to && `<button class="act act-x" type="button" data-act="clearto" aria-label="Any destination">×</button>`,
  ]);
  dFoot.classList.add('tiny');
}

function renderBoard(d) {
  lastBoard = d;
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
          d.to && arr ? `Arrives ${arr}` : '',
          d.to && r.mins != null && !r.cancelled ? `${r.mins} min` : '',
          r.stops != null ? (r.stops === 0 ? 'non-stop' : `${r.stops} stop${r.stops === 1 ? '' : 's'}`) : '',
          r.coaches ? `${r.coaches} coaches` : '',
          r.op ? esc(r.op) : '',
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
  dBoard.innerHTML = body;
  dFoot.innerHTML = `${d.source === 'national-rail' ? 'Live times and platforms from National Rail' : 'Timetabled platforms until the station announces them'} · ${fresh(Date.now())}`;
}

async function loadBoard() {
  if (!stn.from) return;
  const key = `${stn.from}|${stn.to || ''}`;
  if (!lastBoard || `${lastBoard.from.crs}|${lastBoard.to?.crs || ''}` !== key) dBoard.innerHTML = '<p class="b-empty">Checking departures…</p>';
  try {
    const res = await fetch(`${WORKER}/api/board?from=${stn.from}&to=${stn.to || ''}`);
    const d = await res.json();
    if (`${stn.from}|${stn.to || ''}` !== key || selectedId !== 'stn:' + stn.from) return; // changed meanwhile
    if (d.error) dBoard.innerHTML = `<p class="b-empty">${esc(d.error)}.</p>`;
    else renderBoard(d);
    remember(selectedId, byCrs(stn.from)?.n || stn.from, 'Station');
  } catch {
    dBoard.innerHTML = '<p class="b-empty">Couldn’t reach the departures service. It will try again shortly.</p>';
  }
}

dBoard.addEventListener('click', (e) => {
  const row = e.target.closest('.b-row');
  if (!row) return;
  const id = row.dataset.id;
  if (!id || !trains.get(id)) {
    row.querySelector('.b-sub')?.insertAdjacentHTML('beforeend', ' · not on the map yet');
    return;
  }
  showTrain(id, stn.from);
});

/** Go to the map and show a train, e.g. from a departures board. */
function showTrain(id, crs = null) {
  const v = trains.get(id);
  if (crs) boardCrs.set(id, crs);
  if (!v) return false;
  select(id);
  const p = position(v, now());
  if (p) showOnMap(p.lat, p.lng, 14);
  return true;
}

/** Pick where you're going from this station: your usual places, or search. */
function openPicker() {
  dPick.hidden = !dPick.hidden;
  if (dPick.hidden) return;
  const c = store.get('commute', null);
  const quick = [
    ...new Set([
      c && (c.home === stn.from ? c.work : c.work === stn.from ? c.home : null),
      ...favs.filter((x) => x.f === stn.from && x.t).map((x) => x.t),
      ...favs.filter((x) => x.t === stn.from).map((x) => x.f),
    ]),
  ].filter((x) => x && x !== stn.from && byCrs(x));
  dPick.innerHTML = `<input class="sp-input" id="pickInput" type="text" autocomplete="off" spellcheck="false" placeholder="Where are you going?" aria-label="Destination station" />
    ${quick.length ? `<div class="pick-quick">${quick.map((x) => `<button class="act" type="button" data-pick="${x}">${esc(short(byCrs(x).n))}</button>`).join('')}</div>` : ''}
    <ul class="sp-list" id="pickList"></ul>`;
  setTimeout(() => document.getElementById('pickInput')?.focus(), 30);
  // Give the list room on a phone
  if (window.matchMedia('(max-width: 899px)').matches) detailEl.style.height = `${fullH()}px`;
}
dPick.addEventListener('input', (e) => {
  if (e.target.id !== 'pickInput') return;
  document.getElementById('pickList').innerHTML = search(e.target.value)
    .filter((x) => x.c !== stn.from)
    .slice(0, 6)
    .map((x) => `<li><button type="button" data-pick="${x.c}">${esc(x.n)} <small>${x.c}</small></button></li>`)
    .join('');
});
dPick.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (b) setTo(b.dataset.pick);
});
dPick.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dPick.querySelector('#pickList [data-pick]')?.click();
  if (e.key === 'Escape') {
    e.stopPropagation();
    dPick.hidden = true;
  }
});

function setTo(crs) {
  stn.to = crs || null;
  toFor = { ...toFor, [stn.from]: stn.to };
  store.set('toFor', toFor);
  dPick.hidden = true;
  lastBoard = null;
  renderStationHeader();
  loadBoard();
}

// ---------- Stations on the map (tap one for its departures) ----------
let drawnStations = [];
function drawStations(size, z) {
  drawnStations = [];
  if ((z < 12 && !isStn(selectedId)) || !stations) return;
  const b = map.getBounds().pad(0.05);
  const big = z >= 14;
  ctx.font = '600 11px "Work Sans", system-ui, sans-serif';
  for (const st of stations) {
    if (st.la < b.getSouth() || st.la > b.getNorth() || st.lo < b.getWest() || st.lo > b.getEast()) continue;
    if (z < 12 && selectedId !== 'stn:' + st.c) continue; // zoomed out: just the one you opened
    const pt = toScreen(st.la, st.lo);
    const entry = [pt.x, pt.y, st.c, null];
    drawnStations.push(entry);
    // A white station tick with a dark ring, like a railway map (gilt when it's open)
    const sel = selectedId === 'stn:' + st.c;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, sel ? 7 : big ? 4.5 : 3.2, 0, Math.PI * 2);
    ctx.fillStyle = sel ? '#d4a64a' : '#efeadb';
    ctx.fill();
    ctx.lineWidth = sel ? 2.5 : 1.6;
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

/**
 * Open a station's board in the sheet. to: a destination (null for every train; left out,
 * the one you last picked there). fly: move the map to the station.
 */
function openBoard(from, to, fly = true) {
  stn.from = from;
  stn.to = to === undefined ? toFor[from] || null : to;
  lastBoard = null;
  if (selectedId === 'stn:' + from) {
    renderStationHeader();
    loadBoard();
  } else select('stn:' + from);
  const s = byCrs(from);
  if (fly && s) showOnMap(s.la, s.lo, 14);
}

// ---------- Follow a train or bus ----------
let following = null;
let lastPan = 0;
function setFollow(id) {
  if (following === id) return;
  following = id;
  if (selectedId && !isPlace(selectedId)) renderDetailHeader();
}
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
window.addEventListener('resize', setBarHeight);
function markTab(name) {
  tab = name;
  store.set('lastTab', name);
  setTimeout(updateZoomHint, 0);
  document.body.dataset.tab = name;
  for (const b of document.querySelectorAll('.tabbar [data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === name);
}
const alerts = createAlerts({
  WORKER,
  DEMO,
  store,
  esc,
  // Alerts that can't be set explain why on the Commute & alerts panel
  setTab: () => setSettingsOpen(true),
  showTrain: (id) => showTrain(id),
  onChange() {
    if (selectedId && !isPlace(selectedId)) renderDetailHeader();
    home.render();
  },
});
document.getElementById('alertsClose').onclick = () => setSettingsOpen(false);
/** Commute & alerts: your two stations, weekday alerts, and the trains you're watching. */
function setSettingsOpen(open) {
  if (open) {
    setLayersOpen(false);
    closeDetail();
  }
  alerts.open(open);
  if (open) renderSaved();
}

const home = createHome({
  alerts: () => alerts,
  icon: ICON,
  fresh: (at) => fresh(at),
  commute: () => commuteStations(),
  openSetup: () => openSetup(),
  disruptionNote: (ops) => disruptionNote(ops),
  WORKER,
  store,
  esc,
  short,
  now,
  byCrs,
  loadStations,
  stations: () => stations,
  expText,
  favs: () => favs,
  stopFavs: () => stopFavs,
  busFavs: () => busFavs,
  routeName: (id) => routeName(id),
  busBadge: (n) => busBadge(n),
  fetchStop: (id) => fetchStop(id),
  stopBoard: (id) => stopBoards.get(id),
  setTab: (t) => setTab(t),
  openBoard,
  openStop: (id, la, lo) => openStop(id, la, lo),
  openRoute: (id) => openRoute(id),
  showTrain,
  setAuto: (on) => setAuto(on),
  startMe: () => {
    store.set('locDenied', false);
    startMe(false);
  },
});

/**
 * The three tabs. Now and Search are pages of their own; Map shows the map, with a sheet
 * for whatever you've opened. keepSheet: going to the map to show a sheet.
 */
function setTab(name, keepSheet = false) {
  if (!['home', 'map', 'search'].includes(name)) name = 'map';
  setDisruptOpen(false);
  setLayersOpen(false);
  alerts.open(false);
  setFiltersOpen(false);
  setBusPanelOpen(false);
  if (name !== 'map' && !keepSheet && window.matchMedia('(max-width: 899px)').matches) closeDetail();
  markTab(name);
  home.open(name === 'home');
  setSearchOpen(name === 'search');
  if (name === 'map') setTimeout(refit, 0);
}
for (const b of document.querySelectorAll('.tabbar [data-tab]')) {
  b.addEventListener('click', () => {
    // Opening the map: go to where you are (unless there's a sheet open to look at)
    if (b.dataset.tab === 'map' && tab !== 'map' && !selectedId) setTimeout(goToMe, 0);
    if (b.dataset.tab === tab && tab === 'map') closeDetail();
    detailFrom = null;
    setTab(b.dataset.tab);
  });
}
loadDisruptions();
setInterval(loadDisruptions, 120000);

// ---------- Map layers: trains and buses on/off, and the More sheet ----------
function applyLayers() {
  store.set('showTrains', showTrains);
  store.set('showBuses', showBuses);
  store.set('busesOn', busesOn);
  document.getElementById('busAll').setAttribute('aria-checked', busesOn);
  updateZoomHint();
  updateCounts();
  busShapes[showBuses ? 'addTo' : 'remove'](map);
}
// Every bus only shows once zoomed in: say so, rather than quietly showing nothing
function updateZoomHint() {
  document.getElementById('zoomHint').hidden = !(tab === 'map' && showBuses && busesOn && map.getZoom() < BUS_ZOOM && !selectedId && !document.body.classList.contains('replaying'));
}
document.getElementById('zoomHint').onclick = () => map.setZoom(BUS_ZOOM);
map.on('zoomend', updateZoomHint);
setTimeout(() => !showBuses && busShapes.remove(), 0); // after the bus layer is set up
document.getElementById('qtTrains').onclick = () => {
  showTrains = !showTrains;
  applyLayers();
};
document.getElementById('qtBuses').onclick = () => {
  showBuses = !showBuses;
  applyLayers();
  pollBuses();
  loadMapStops();
};
document.getElementById('busAll').onclick = () => {
  busesOn = !busesOn;
  if (busesOn) showBuses = true;
  applyLayers();
  pollBuses();
};
// The More sheet
const layersEl = document.getElementById('layers');
function setLayersOpen(open) {
  if (layersEl.hidden === !open) return;
  layersEl.hidden = !open;
  document.getElementById('moreBtn').setAttribute('aria-expanded', open);
  if (open) {
    setFiltersOpen(false);
    setBusPanelOpen(false);
    closeDetail();
    const n = disrupt.lines.length;
    document.getElementById('mDisruptSum').textContent = n ? `${n} ${n === 1 ? 'line' : 'lines'}` : 'Good service';
    document.getElementById('mRides').textContent = rides.length ? `${rides.length} ${rides.length === 1 ? 'ride' : 'rides'}` : '';
  }
}
document.getElementById('moreBtn').onclick = () => setLayersOpen(layersEl.hidden);
document.getElementById('layersClose').onclick = () => setLayersOpen(false);
document.getElementById('mDisrupt').onclick = () => {
  setLayersOpen(false);
  setDisruptOpen(true);
};
document.getElementById('mMyBuses').onclick = () => {
  setLayersOpen(false);
  setBusPanelOpen(true);
};
document.getElementById('mSettings').onclick = () => setSettingsOpen(true);

// A notification was tapped while the app was closed: show that train once it's on the map
const wantTrain = params.get('train');
if (wantTrain) {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (showTrain(wantTrain) || Date.now() - t0 > 20000) clearInterval(iv);
  }, 500);
}

// ---------- Disruption ----------
/** Escape text, then turn web addresses in it (https://…, www.…, tfl.gov.uk/…) into links. */
function linkify(text) {
  return esc(text).replace(/\b((?:https?:\/\/|www\.)[^\s<]+|(?:[a-z0-9-]+\.)+(?:gov\.uk|co\.uk|org\.uk|com|uk)(?:\/[^\s<]*)?)/gi, (m) => {
    const trail = /[.,;:)]+$/.exec(m)?.[0] || ''; // leave sentence punctuation outside the link
    const u = m.slice(0, m.length - trail.length);
    const href = /^https?:/i.test(u) ? u : `https://${u}`;
    return `<a href="${href}" target="_blank" rel="noopener">${u}</a>${trail}`;
  });
}
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
  disruptPill.innerHTML = `${ICON.warn}<span>${n}</span>`;
  disruptPill.setAttribute('aria-label', `${n} ${n === 1 ? 'line' : 'lines'} with disruption`);
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
        l.reason ? `<p>${linkify(l.reason)}</p>` : ''
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
    .map((l) => `<p><b>${ICON.warn} ${esc(l.name)}: ${esc(l.severity)}</b>${l.reason ? `<small>${linkify(l.reason)}</small>` : ''}</p>`)
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
replayBtn.onclick = () => {
  setLayersOpen(false);
  setReplay(!replay);
};
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
    rpPlay.innerHTML = ICON.play;
    return;
  }
  rpPlay.innerHTML = ICON.pause;
  rpTimer = setInterval(() => {
    if (!replay || replay.ago <= 0) {
      clearInterval(rpTimer);
      rpTimer = null;
      rpPlay.innerHTML = ICON.play;
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

map.attributionControl.addAttribution('Buses: Powered by TfL Open Data');

function busPos(o, t) {
  const f = Math.max(0, Math.min(1, (t - o.t0) / BUS_POLL_MS));
  return { la: o.fla + (o.v.la - o.fla) * f, lo: o.flo + (o.v.lo - o.flo) * f };
}

function busQuery() {
  const q = new URLSearchParams();
  const r = [...new Set([...busFavs, ...(peekRoute ? [peekRoute] : [])])];
  if (r.length) q.set('r', r.join(','));
  // Buses you've ridden, wherever they are today (most recent first)
  if (store.get('showRidden', true)) {
    const regs = [...new Set(store.get('rides', []).map((x) => x.reg))].slice(0, 60);
    if (regs.length) q.set('v', regs.join(','));
  }
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
  if (isBus(selectedId)) renderBusHeader();
  if (isRoute(selectedId)) loadRoute();
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

/** A side-on bus in white, 12 px long: two rows of windows for a double decker, one for a single. */
function drawBusGlyph(x, cy, k) {
  const dbl = k === 'D';
  const bh = dbl ? 11 : 7.5;
  const top = cy + 4.5 - bh; // both sit on the same "road"
  ctx.fillStyle = '#fff';
  roundRect(x, top, 12, bh, 1.8);
  ctx.fill();
  ctx.fillStyle = BUS_RED;
  const row = (y) => {
    for (let i = 0; i < 3; i++) ctx.fillRect(x + 1.6 + i * 3.4, y, 2.4, 2);
  };
  if (dbl) row(top + 1.6);
  row(top + (dbl ? 5.4 : 1.6));
  // wheels
  ctx.beginPath();
  ctx.arc(x + 3, cy + 4.6, 1.3, 0, Math.PI * 2);
  ctx.arc(x + 9.4, cy + 4.6, 1.3, 0, Math.PI * 2);
  ctx.fillStyle = '#1f1414';
  ctx.fill();
}

function drawBus(o, pt, z, isSelected) {
  const fav = busFavs.includes(o.v.r);
  const big = z >= BUS_ZOOM || isSelected;
  ctx.font = '700 11px "Work Sans", system-ui, sans-serif';
  const glyph = big && (o.v.k === 'D' || o.v.k === 'S') ? 15 : 0; // room for the bus picture
  const w = big ? Math.max(22, ctx.measureText(o.v.n).width + 10 + glyph) : 10;
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
  // A little single or double decker picture before the route number
  if (glyph) {
    drawBusGlyph(pt.x - w / 2 + 4, pt.y, o.v.k);
    roundRect(pt.x - w / 2, pt.y - h / 2, w, h, 4);
  }
  ctx.lineWidth = isSelected ? 3 : fav ? 2 : 1.4;
  ctx.strokeStyle = isSelected ? '#efeadb' : fav ? '#d4a64a' : '#1f3229';
  ctx.stroke();
  if (big) {
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(o.v.n, pt.x + glyph / 2, pt.y + 4);
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
    setActs([]);
    return;
  }
  const v = o.v;
  const facts = busFactsCache.get(v.id);
  const deckName = facts?.deck || (v.k === 'D' ? 'Double decker' : v.k === 'S' ? 'Single decker' : 'London bus');
  dHead.innerHTML = busBadge(v.n);
  dOp.innerHTML = `${busIcon(facts?.deck || v.k)}${esc(deckName)}${facts?.power ? ` · ${esc(facts.power)}` : ''}`;
  dRoute.textContent = v.d ? `To ${v.d}` : `Route ${v.n}`;
  const mine = ridesOn(v.id);
  dFrom.innerHTML = `<span class="reg">${esc(v.id)}</span>${
    mine.length ? ` · You’ve been on this bus ${mine.length === 1 ? 'once' : mine.length === 2 ? 'twice' : `${mine.length} times`}` : ''
  }${
    facts
      ? `<span class="facts">${[facts.model, facts.length ? `${facts.length} m` : '', facts.fleetNo ? `${facts.operator} ${facts.fleetNo}` : facts.operator, facts.year ? `from ${facts.year}` : '']
          .filter(Boolean)
          .map(esc)
          .join(' · ')}</span>`
      : ''
  }`;
  const fav = busFavs.includes(v.r);
  const onNow = mine.length && Date.now() - mine[0].at < RIDE_SAME_MS;
  dState.innerHTML = `Next stop ${esc(v.nx)}${v.m <= 0 ? ', due now' : ` in ${v.m} min`}`;
  setActs([
    act('busstar', fav ? `${ICON.starOn} Route starred` : `${ICON.star} Star route`, fav),
    act('follow', following === selectedId ? `${ICON.follow} Following` : `${ICON.follow} Follow`, following === selectedId),
    act('ride', onNow ? `${ICON.check} On board` : `${ICON.bus} I’m on it`, onNow),
  ]);
  dFoot.textContent = 'Estimated position · TfL Open Data';
  dFoot.classList.add('tiny');
}

/** A route number in a red roundel-ish badge. */
function busBadge(n) {
  return `<span class="bn">${esc(n)}</span>`;
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

// ---------- Starred bus routes, a route's sheet, and the My buses panel ----------
const busPanel = document.getElementById('busPanel');

function setBusPanelOpen(open) {
  if (open) {
    setFiltersOpen(false);
    closeDetail();
  }
  busPanel.classList.toggle('open', open);
  if (open) renderMyBuses();
}
document.getElementById('busClose').onclick = () => setBusPanelOpen(false);

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

function toggleBusFav(id) {
  busFavs = busFavs.includes(id) ? busFavs.filter((x) => x !== id) : [...busFavs, id];
  store.set('busFavs', busFavs);
  drawBusShapes();
  if (isBus(selectedId)) renderBusHeader();
  if (isRoute(selectedId)) renderRouteHeader();
  pollBuses();
  home.render();
}

/** A bus route's sheet: where it goes, and the buses on it right now. */
function openRoute(id) {
  select('route:' + id);
  loadBusRoutes().then(() => isRoute(selectedId) && renderRouteHeader());
}

function renderRouteHeader() {
  const id = selectedId.slice(6);
  const fav = busFavs.includes(id);
  const on = [...buses.values()].filter((o) => o.v.r === id);
  dHead.innerHTML = busBadge(routeName(id));
  dOp.textContent = 'Bus route';
  dRoute.innerHTML = routeEnds(id) || `Route ${esc(routeName(id))}`;
  dFrom.textContent = '';
  dState.textContent = !busMeta.ready && !DEMO ? 'Loading London’s bus routes…' : on.length ? `${on.length} ${on.length === 1 ? 'bus' : 'buses'} on the road now` : 'Looking for its buses…';
  setActs([act('routestar', fav ? `${ICON.starOn} Starred` : `${ICON.star} Star route`, fav)]);
  dFoot.textContent = 'Estimated positions · TfL Open Data';
  dFoot.classList.add('tiny');
}

let routeShapeFor = null;
async function loadRoute() {
  const id = selectedId.slice(6);
  renderRouteHeader();
  const on = [...buses.values()].filter((o) => o.v.r === id).sort((a, b) => (a.v.d || '').localeCompare(b.v.d || '') || a.v.m - b.v.m);
  dCalls.innerHTML = on.length
    ? on
        .map(
          (o) => `<li class="dep" data-reg="${esc(o.v.id)}"><span class="bp-num">${busIcon(o.v.k)}${esc(o.v.n)}</span><span class="dp-main"><b>To ${esc(o.v.d || '…')}</b><small><span class="reg">${esc(o.v.id)}</span> next ${esc(o.v.nx || '')}</small></span><span class="dp-when"><b>${o.v.m <= 0 ? 'Due' : `${o.v.m} min`}</b><small>to next stop</small></span></li>`,
        )
        .join('')
    : '<li class="dep-empty">No buses found on this route just now. They appear within a few seconds of being reported.</li>';
  if (routeShapeFor === selectedId && routeLine) return;
  routeShapeFor = selectedId;
  remember(selectedId, `Route ${routeName(id)}`, routeEnds(id).replace(/&amp;/g, '&'));
  try {
    const res = await fetch(`${WORKER}/api/busshapes?r=${encodeURIComponent(id)}`);
    const shapes = await res.json();
    if (selectedId !== 'route:' + id) return;
    if (routeLine) routeLine.remove();
    routeLine = L.featureGroup(Object.values(shapes).flat().map((pts) => L.polyline(pts, { color: BUS_RED, weight: 4, opacity: 0.75, interactive: false }))).addTo(map);
    // Opened from a list: show the whole route
    if (detailFrom || !map.getBounds().intersects(routeLine.getBounds())) {
      const phone = window.matchMedia('(max-width: 899px)').matches;
      map.fitBounds(routeLine.getBounds(), { paddingTopLeft: [20, 70], paddingBottomRight: [20, phone ? Math.round(window.innerHeight * 0.5) : 20] });
    }
  } catch {}
}

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

if (busFavs.length) loadBusRoutes().then(() => home.render());
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
    el.innerHTML = '<p class="bp-intro">When you’re on a bus, tap it on the map and choose <b>I’m on this bus</b>. Choo Choo remembers the bus itself (by its registration), so you’ll see when you get the same one again. Buses you’ve ridden show a gold dot on the map.</p>';
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
    ${onMap.length ? `<p class="mb-near">${ICON.bus} ${onMap.map((b) => `<b>${esc(b.reg)}</b>`).join(', ')} ${onMap.length === 1 ? 'is' : 'are'} on the map right now</p>` : ''}
    <ul class="bp-list mb-list">${top
      .slice(0, 12)
      .map(
        (b) => `<li><span class="mb-n">${b.n}×</span><span class="reg">${busIcon(b.deck)}${esc(b.reg)}</span><span class="bp-ends">${[...b.routes]
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
const STOP_ZOOM = 15;
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
    const entry = [pt.x, pt.y, st.i, null];
    drawnStops.push(entry);
    const fav = stopFavs.some((f) => f.i === st.i);
    // A bus stop sign: white disc with a red ring (gold for your saved stops)
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = fav ? '#d4a64a' : BUS_RED;
    ctx.stroke();
    if (z >= 16) {
      // The name can be tapped too
      entry[3] = [pt.x + 3, pt.y - 10, pt.x + 11 + ctx.measureText(st.n).width, pt.y + 9];
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

/** The same little bus picture, as an inline icon for panels and lists. */
function busIcon(deck) {
  const dbl = /^double|^D$/i.test(deck || '');
  const sgl = /^single|^S$/i.test(deck || '');
  if (!dbl && !sgl) return '';
  const h = dbl ? 11 : 7.5, top = 13 - h;
  const row = (y) => [0, 1, 2].map((i) => `<rect x="${1.6 + i * 3.4}" y="${y}" width="2.4" height="2" fill="#d4302a"/>`).join('');
  return `<svg class="bus-ic" viewBox="0 0 12 15" width="15" height="18" role="img" aria-label="${dbl ? 'Double decker' : 'Single decker'}"><rect x="0" y="${top}" width="12" height="${h}" rx="1.8" fill="currentColor"/>${dbl ? row(top + 1.6) : ''}${row(top + (dbl ? 5.4 : 1.6))}<circle cx="3" cy="13.3" r="1.3" fill="#1f1414"/><circle cx="9.4" cy="13.3" r="1.3" fill="#1f1414"/></svg>`;
}

const deckShort = (f) => (f && f.deck ? (f.deck.startsWith('Double') ? 'Double decker' : 'Single decker') : '');

function renderStopHeader() {
  const id = selectedId.slice(5);
  const d = stopBoards.get(id);
  const fav = stopFavs.some((f) => f.i === id);
  dHead.textContent = 'Bus stop';
  dOp.innerHTML = d ? d.routes.map(busBadge).join(' ') : '';
  dRoute.textContent = d ? d.name : 'Bus stop';
  dFrom.textContent = d && d.towards ? `Towards ${d.towards}` : '';
  // Every route due here, with all its times, at a glance
  const byRoute = new Map();
  for (const r of d ? d.rows : []) (byRoute.get(r.route) || byRoute.set(r.route, []).get(r.route)).push(r.m <= 0 ? 'due' : `${r.m}`);
  const summary = [...byRoute]
    .sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))
    .map(([rt, ms]) => `<span class="rt-sum"><span class="bp-num">${esc(rt)}</span>${ms.map(esc).join(', ')}${ms.length && ms[ms.length - 1] !== 'due' ? ' min' : ''}</span>`)
    .join('');
  dState.innerHTML = summary ? `<span class="rt-sums">${summary}</span>` : '';
  setActs([act('stopstar', fav ? `${ICON.starOn} Starred` : `${ICON.star} Star`, fav)]);
  dFoot.innerHTML = `Live times from TfL${d && d.at ? ` · ${fresh(d.at - skew)}` : ''}`;
  dFoot.classList.add('tiny');
}

function depRow(r) {
  const f = r.facts;
  const about = [deckShort(f), f && f.model, f && f.power].filter(Boolean).map(esc).join(' · ');
  return `<li class="dep" data-reg="${esc(r.reg)}"><span class="bp-num">${busIcon(f && f.deck)}${esc(r.route)}</span><span class="dp-main"><b>${esc(r.dest)}</b><small><span class="reg">${esc(r.reg)}</span>${about ? ` ${about}` : ''}</small></span><span class="dp-when"><b>${r.m <= 0 ? 'Due' : `${r.m} min`}</b><small>${esc(r.at)}</small></span></li>`;
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
  remember(selectedId, d.name, d.towards ? `Bus stop · towards ${d.towards}` : 'Bus stop', d.la, d.lo);
}
// Tap a departure: show that bus on the map, if it's there
dCalls.addEventListener('click', (e) => {
  const li = e.target.closest('li.dep');
  if (!li || !(isStop(selectedId) || isRoute(selectedId))) return;
  const reg = li.dataset.reg;
  if (buses.has(reg)) {
    const o = buses.get(reg);
    select('bus:' + reg);
    map.setView([o.v.la, o.v.lo], Math.max(map.getZoom(), 15));
  }
});

function openStop(id, la, lo) {
  select('stop:' + id);
  if (la && lo) showOnMap(la, lo, 16);
}

function toggleStopFav(id, name) {
  stopFavs = stopFavs.some((f) => f.i === id) ? stopFavs.filter((f) => f.i !== id) : [...stopFavs, { i: id, n: name }].slice(0, 12);
  store.set('busStopFavs', stopFavs);
  if (selectedId === 'stop:' + id) renderStopHeader();
  home.render();
}

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
          // Location turned off for this site: don't keep asking when the map opens
          stopMe();
          store.set('locOn', false);
          store.set('locDenied', true);
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
locateBtn.onclick = () => {
  store.set('locDenied', false);
  startMe(true);
};
/** When the map opens, centre it on where you are (unless you've said no to location). */
function goToMe() {
  if (DEMO || store.get('locDenied', false) || params.get('train')) return;
  startMe(true);
}
if (tab === 'map') goToMe();
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

// Buses you've ridden, shown wherever they are
const showRidden = document.getElementById('showRidden');
showRidden.setAttribute('aria-checked', store.get('showRidden', true));
showRidden.onclick = () => {
  const on = showRidden.getAttribute('aria-checked') !== 'true';
  showRidden.setAttribute('aria-checked', on);
  store.set('showRidden', on);
  pollBuses();
};

// ---------- Commute & alerts ----------
async function setAuto(on) {
  const c = store.get('commute', null);
  const ok = await alerts.setAuto(on, c && c.home, c && c.work);
  home.render();
  renderSaved();
  return ok;
}
function renderSaved() {
  const el = document.getElementById('savedBody');
  if (!el || document.getElementById('alertsPanel').hidden) return;
  const commute = commuteStations();
  el.innerHTML = `
    <div class="sv-commute">${
      commute
        ? `<b>${esc(short(commute.home.n))}</b> <span>and</span> <b>${esc(short(commute.work.n))}</b><button class="h-link" type="button" data-go="setup">Change</button>`
        : `<span>Your commute isn’t set yet.</span><button class="h-link" type="button" data-go="setup">Set your stations</button>`
    }</div>${
      commute
        ? `<div class="ly-row sv-auto"><span><b>Watch my commute every weekday</b><small>6–10am from home and 4–8pm from work, Choo Choo picks your next good train and tells you about its platform, delays and cancellations.</small></span><button class="switch" type="button" role="switch" id="autoSwitch" aria-checked="${alerts.autoOn()}" aria-label="Watch my commute every weekday"></button></div>`
        : ''
    }`;
}
document.getElementById('savedBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'autoSwitch') {
    const on = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', on); // straight away; put back if it didn't work
    if (!(await setAuto(on))) b.setAttribute('aria-checked', !on);
    return;
  }
  if (b.dataset.go === 'setup') openSetup();
});

// ---------- Recently opened places and routes (for Search) ----------
let recent = store.get('recent', []); // [{ id, label, sub, la, lo }]
function remember(id, label, sub = '', la = null, lo = null) {
  if (!id || !label) return;
  if (recent[0] && recent[0].id === id && recent[0].label === label) return;
  recent = [{ id, label, sub, la, lo }, ...recent.filter((x) => x.id !== id)].slice(0, 8);
  store.set('recent', recent);
}
/** Open a place or route by its sheet id (stn:WAT, stop:…, route:93). */
function openId(id, la, lo) {
  if (isStn(id)) return openBoard(id.slice(4));
  if (isStop(id)) return openStop(id.slice(5), la, lo);
  if (isRoute(id)) return openRoute(id.slice(6));
}

// ---------- Search: one box for everything ----------
const searchPanel = document.getElementById('searchPanel');
const qInput = document.getElementById('qInput');
const qResults = document.getElementById('qResults');
let qTimer = null;
let qStops = [];
function setSearchOpen(open) {
  searchPanel.hidden = !open;
  if (!open) return;
  loadStations()
    .then(() => renderSearch())
    .catch(() => {});
  loadBusRoutes().then(() => renderSearch());
  renderSearch();
  // On a computer, start typing straight away (phones would pop the keyboard up over the list)
  if (!window.matchMedia('(max-width: 899px)').matches) setTimeout(() => qInput.focus(), 50);
}
qInput.addEventListener('input', () => {
  renderSearch();
  clearTimeout(qTimer);
  const q = qInput.value.trim();
  if (q.length < 2) return (qStops = []);
  qTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${WORKER}/api/stops?q=${encodeURIComponent(q)}`);
      qStops = await res.json();
    } catch {
      qStops = [];
    }
    if (qInput.value.trim() === q) renderSearch();
  }, 250);
});

const pin = (kind, text = '') => `<span class="pin ${kind}">${kind === 'rail' ? ICON.rail : kind === 'bus' ? ICON.stop : text}</span>`;
const li = (attrs, icon, main, sub = '') => `<li><button class="sv-go" type="button" ${attrs}>${icon}<span class="sv-main">${main}</span>${sub ? `<small>${sub}</small>` : ''}</button></li>`;

/** Everything you've starred, as list rows (Search, when the box is empty). */
function starredRows() {
  const rows = [];
  for (const f of favs) {
    const a = byCrs(f.f), b = f.t && byCrs(f.t);
    if (!a) continue;
    rows.push(b ? li(`data-board="${f.f}|${f.t}"`, pin('rail'), `${esc(short(a.n))} → ${esc(short(b.n))}`, 'Trains') : li(`data-board="${f.f}|"`, pin('rail'), esc(a.n), 'Station'));
  }
  for (const f of stopFavs) rows.push(li(`data-stop="${esc(f.i)}"`, pin('bus'), esc(f.n), 'Bus stop'));
  for (const id of busFavs) rows.push(li(`data-route="${esc(id)}"`, busBadge(routeName(id)), routeEnds(id) || 'Bus route', 'Route'));
  return rows;
}

function renderSearch() {
  if (searchPanel.hidden) return;
  const raw = qInput.value.trim();
  const q = raw.toLowerCase();
  const section = (t, items) => (items.length ? `<h3 class="sv-head">${t}</h3><ul class="sv-list">${items.join('')}</ul>` : '');
  if (!q) {
    const st = starredRows();
    const rc = recent.map((x) =>
      li(
        `data-open="${esc(x.id)}" data-la="${x.la ?? ''}" data-lo="${x.lo ?? ''}"`,
        isStn(x.id) ? pin('rail') : isStop(x.id) ? pin('bus') : busBadge(x.id.slice(6).toUpperCase()),
        esc(x.label),
        esc(x.sub || ''),
      ),
    );
    qResults.innerHTML =
      section('Starred', st) +
      section('Recent', rc) +
      (st.length || rc.length
        ? ''
        : '<p class="bp-intro">Find a station, a bus stop or a bus route. You can also look up a train by its headcode (like 2K25) or a bus by its registration.</p><p class="bp-intro">Tap <b>☆ Star</b> on anything you open to keep it here and on Now.</p>');
    return;
  }
  const groups = [];
  const up = raw.toUpperCase().replace(/\s/g, '');
  // Stations
  const st = search(raw).slice(0, 6);
  groups.push(['Stations', st.map((s2) => li(`data-stn="${s2.c}"`, pin('rail'), esc(s2.n), s2.c))]);
  // Bus stops
  if (q.length >= 2) groups.push(['Bus stops', qStops.slice(0, 6).map((x) => li(`data-stop="${esc(x.i)}" data-la="${x.la}" data-lo="${x.lo}"`, pin('bus'), esc(x.n), esc(x.r.join(', '))))]);
  // Bus routes
  const br = (busRoutes || []).filter((r) => r.n.toLowerCase().startsWith(q) || r.id === q).slice(0, 5);
  if (q.length <= 4) groups.push(['Bus routes', br.map((r) => li(`data-route="${esc(r.id)}"`, busBadge(r.n), `${esc(r.e[0])} – ${esc(r.e[1])}`))]);
  // Trains by headcode
  if (/^\d[A-Z]?\d{0,2}$/i.test(up)) {
    const tr = [...trains.values()].filter((v) => v.hc && v.hc.toUpperCase().startsWith(up)).slice(0, 5);
    groups.push(['Trains', tr.map((v) => li(`data-train="${esc(v.id)}"`, `<span class="pin hc">${esc(v.hc)}</span>`, `To ${esc(v.d)}`, esc(opName(v.toc))))]);
  }
  // Buses by registration
  if (up.length >= 3) {
    const bs = [...buses.values()].filter((o) => o.v.id.startsWith(up)).slice(0, 5);
    groups.push(['Buses', bs.map((o) => li(`data-bus="${esc(o.v.id)}"`, busBadge(o.v.n), `To ${esc(o.v.d)}`, `<span class="reg">${esc(o.v.id)}</span>`))]);
  }
  const html = groups.map(([t, items]) => section(t, items)).join('');
  qResults.innerHTML =
    html ||
    (/^[A-Z]{2}\d{2}[A-Z]{3}$/.test(up)
      ? '<p class="bp-intro">That bus isn’t on the map right now. Buses show here when you’ve starred their route, or when they’re in view with every bus on.</p>'
      : '<p class="bp-intro">Nothing found yet.</p>');
}
qResults.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  detailFrom = 'search';
  const la = Number(b.dataset.la) || null, lo = Number(b.dataset.lo) || null;
  if (b.dataset.train) return showTrain(b.dataset.train);
  if (b.dataset.bus) {
    const o = buses.get(b.dataset.bus);
    select('bus:' + b.dataset.bus);
    if (o) showOnMap(o.v.la, o.v.lo, 15);
    return;
  }
  if (b.dataset.board) {
    const [f, t] = b.dataset.board.split('|');
    return openBoard(f, t || null);
  }
  if (b.dataset.stn) return openBoard(b.dataset.stn);
  if (b.dataset.route) return openRoute(b.dataset.route);
  if (b.dataset.stop) return openStop(b.dataset.stop, la, lo);
  if (b.dataset.open) return openId(b.dataset.open, la, lo);
});

// Remember where the map was left
map.on('moveend', () => {
  const c = map.getCenter();
  store.set('mapView', { c: [Math.round(c.lat * 1e5) / 1e5, Math.round(c.lng * 1e5) / 1e5], z: map.getZoom() });
});

// ---------- Sheets you can drag (phones): pull up for more, flick down to close ----------
function draggable(panel, { onClose, snaps }) {
  const grab = document.createElement('div');
  grab.className = 'grab';
  grab.setAttribute('aria-hidden', 'true');
  panel.prepend(grab);
  const phone = () => window.matchMedia('(max-width: 899px)').matches;
  let startY = 0, startH = 0, dragging = false, moved = false, lastY = 0, lastT = 0, speed = 0;
  const heights = () => snaps().map((f) => (typeof f === 'number' ? f : f()));
  const start = (e) => {
    if (!phone()) return;
    // Only from the handle or the panel's heading, so lists still scroll normally
    if (!e.target.closest('.grab, .panel-head, .d-route, .d-op')) return;
    if (e.target.closest('button, input, a')) return;
    dragging = true;
    moved = false;
    startY = lastY = e.clientY;
    lastT = performance.now();
    startH = panel.getBoundingClientRect().height;
    panel.classList.add('dragging');
    panel.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const now = performance.now();
    speed = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY;
    lastT = now;
    const hs = heights();
    panel.style.height = `${Math.max(80, Math.min(hs[hs.length - 1], startH - dy))}px`;
    panel.style.maxHeight = 'none';
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    if (!moved) return;
    const h = panel.getBoundingClientRect().height;
    const hs = heights();
    // A quick flick down, or below the smallest size: close
    if (speed > 0.8 || h < hs[0] - 50) {
      panel.style.height = '';
      return onClose();
    }
    // Otherwise settle at the nearest size (a flick up goes up a size)
    let best = hs.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
    if (speed < -0.8) best = hs.find((x) => x > h + 10) || hs[hs.length - 1];
    panel.style.height = `${best}px`;
  };
  panel.addEventListener('pointerdown', start);
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  return { reset: () => ((panel.style.height = ''), (panel.style.maxHeight = '')) };
}
const fullH = () => window.innerHeight - (barEl.getBoundingClientRect().bottom || 80) - (document.querySelector('.tabbar').getBoundingClientRect().height || 60);
const detailDrag = (window.__detailDrag = draggable(detailEl, {
  snaps: () => [Math.min(200, fullH()), Math.round(window.innerHeight * 0.5), fullH],
  onClose: () => closeDetail(true),
}));

// ---------- Your commute: home and work stations ----------
function commuteStations() {
  const c = store.get('commute', null);
  if (!c || !stations) return null;
  const home = byCrs(c.home), work = byCrs(c.work);
  return home && work ? { home, work } : null;
}

// ---------- First-run setup: stations, location, home screen ----------
const setupEl = document.getElementById('setup');
const setupBody = document.getElementById('setupBody');
const setupStep = document.getElementById('setupStep');
let setupPick = { home: null, work: null };

function stationPicker(which, label, placeholder) {
  const s0 = setupPick[which] && byCrs(setupPick[which]);
  return `<label class="sp-label" for="sp-${which}">${label}</label>
    <input class="sp-input" id="sp-${which}" type="text" autocomplete="off" spellcheck="false" placeholder="${placeholder}" value="${s0 ? esc(s0.n) : ''}" data-which="${which}" />
    <ul class="sp-list" id="sp-${which}-list"></ul>`;
}

function setupStep1() {
  setupStep.textContent = 'Step 1 of 3';
  setupBody.innerHTML = `<h2>Your commute</h2>
    <p>Choose your two stations. Home then shows your next train the right way round: from home in the morning (or wherever you are), from work later on.</p>
    ${stationPicker('home', 'Home station', 'e.g. Raynes Park')}
    ${stationPicker('work', 'Work station', 'e.g. London Waterloo')}
    <div class="setup-btns"><button class="h-link" type="button" data-s="skip1">Skip for now</button><button class="setup-next" type="button" data-s="next1" ${setupPick.home && setupPick.work ? '' : 'disabled'}>Next</button></div>`;
}
function setupStep2() {
  setupStep.textContent = 'Step 2 of 3';
  setupBody.innerHTML = `<h2>Where you are</h2>
    <p>With your location, Choo Choo opens the map on you, works out which way you’re going, how long it takes you to get to the station and when to leave. It stays on your phone.</p>
    <div class="setup-btns"><button class="h-link" type="button" data-s="skip2">Not now</button><button class="setup-next" type="button" data-s="loc">Use my location</button></div>`;
}
function setupStep3() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!ios || installed) return finishSetup();
  setupStep.textContent = 'Step 3 of 3';
  setupBody.innerHTML = `<h2>Add it to your home screen</h2>
    <p>On iPhone, alerts about your train only work when Choo Choo is on your home screen, and it opens full screen like an app.</p>
    <ol class="setup-how"><li>Tap <b>Share</b> at the bottom of Safari</li><li>Choose <b>Add to Home Screen</b></li><li>Open Choo Choo from your home screen</li></ol>
    <div class="setup-btns"><span></span><button class="setup-next" type="button" data-s="done">Done</button></div>`;
}
function finishSetup() {
  store.set('setupDone', true);
  setupEl.hidden = true;
  if (setupPick.home && setupPick.work) setTab('home');
  else home.render();
}
function openSetup() {
  const c = store.get('commute', null);
  const f = favs.find((x) => x.t);
  setupPick = { home: c?.home || f?.f || null, work: c?.work || f?.t || null };
  setupEl.hidden = false;
  loadStations().then(setupStep1, setupStep1);
}
setupBody.addEventListener('input', (e) => {
  const inp = e.target.closest('.sp-input');
  if (!inp) return;
  const list = document.getElementById(`${inp.id}-list`);
  setupPick[inp.dataset.which] = null;
  setupBody.querySelector('[data-s=next1]')?.setAttribute('disabled', '');
  list.innerHTML = search(inp.value)
    .slice(0, 6)
    .map((st) => `<li><button type="button" data-pick="${inp.dataset.which}" data-crs="${st.c}">${esc(st.n)} <small>${st.c}</small></button></li>`)
    .join('');
});
setupBody.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.pick) {
    setupPick[b.dataset.pick] = b.dataset.crs;
    document.getElementById(`sp-${b.dataset.pick}`).value = byCrs(b.dataset.crs)?.n || '';
    document.getElementById(`sp-${b.dataset.pick}-list`).innerHTML = '';
    if (setupPick.home && setupPick.work) setupBody.querySelector('[data-s=next1]')?.removeAttribute('disabled');
    return;
  }
  const s = b.dataset.s;
  if (s === 'next1') {
    store.set('commute', { home: setupPick.home, work: setupPick.work });
    // Keep it as a saved route too, so its board and reliability are one tap away
    if (!favs.some((x) => x.f === setupPick.home && x.t === setupPick.work)) {
      favs = [{ f: setupPick.home, t: setupPick.work }, ...favs].slice(0, 8);
      store.set('favs', favs);
    }
    home.render();
    return setupStep2();
  }
  if (s === 'skip1') return setupStep2();
  if (s === 'skip2') return setupStep3();
  if (s === 'loc') {
    if (!navigator.geolocation) return setupStep3();
    b.textContent = 'Waiting for your phone…';
    navigator.geolocation.getCurrentPosition(
      () => {
        store.set('locDenied', false);
        startMe(false);
        setupStep3();
      },
      () => setupStep3(),
      { timeout: 15000 },
    );
    return;
  }
  if (s === 'done') return finishSetup();
});
// First time: set things up
if (!store.get('setupDone', false) && !DEMO && !params.get('train')) openSetup();

// Start where you left off: Now if you've set up a commute and haven't been anywhere yet
const startTab = store.get('lastTab', null);
if (wantTrain || params.has('demo')) markTab('map');
else if (startTab === 'home' || startTab === 'search') setTab(startTab);
else if (!startTab && store.get('commute', null)) setTab('home');
else setTab('map');

window.chooStarted = true;
