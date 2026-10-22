import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';
import './style.css';
import { OPERATORS, opName, opColour, delayColour } from './operators.js';
import { demoSnapshot, demoDetail } from './demo.js';

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
let busesOn = store0('busesOn', true); // every bus when zoomed in (favourites always show)
const BUS_ZOOM = 14;
const isBus = (id) => typeof id === 'string' && id.startsWith('bus:');
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
  let selected = null;

  for (const v of trains.values()) {
    if (!visible(v)) continue;
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
  const selBus = drawBuses(t, size, z);
  if (selected) drawTrain(selected.v, selected.pt, selected.p, r + 2.5, true, true);
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
  if (best) select(best);
  else if (selectedId) closeDetail();
});

// ---------- Status ----------
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const countEl = document.getElementById('count');

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

let trainsShown = 0;
function renderCount() {
  const t = `${trainsShown} ${trainsShown === 1 ? 'train' : 'trains'}`;
  const nb = buses.size;
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
      <label for="${id}"><span class="sw" style="--c:${opColour(code)}"></span><span class="nm">${opName(code)}</span><span class="n">${perOp.get(code)}</span></label>`;
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
  const src = { TD: 'signalling', TRUST: 'train reporting', schedule: 'timetable', demo: 'simulated' }[v.src] || v.src;
  dFoot.textContent = DEMO ? 'Demo data, not real trains' : `Last reported ${ago(v.up)} from ${src} data`;
}

async function loadCalls() {
  if (isBus(selectedId)) return loadBusCalls();
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
  selectedId = id;
  detailEl.hidden = false;
  if (!finderEl.hidden) setFinderOpen(false);
  dCalls.innerHTML = '';
  if (window.matchMedia('(max-width: 899px)').matches) {
    setFiltersOpen(false);
    setBusPanelOpen(false);
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
const finderBtn = document.getElementById('finderOpen');
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
  const head = `<div class="b-head"><div class="b-title">${esc(short(d.to.name))}<small>Direct trains from ${esc(d.from.name)} · updated ${d.generated}</small></div><button class="b-save" type="button"></button></div>`;
  let body;
  if (!d.rows.length) {
    body = `<p class="b-empty">No direct trains to ${esc(d.to.name)} in the next two hours. You may need to change trains.</p>`;
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
  fBoard.querySelector('.b-save').onclick = toggleFav;
  renderBoardHead();
}

async function loadBoard() {
  clearInterval(boardTimer);
  if (!route.from || !route.to) {
    fBoard.innerHTML = '';
    return;
  }
  if (route.from === route.to) {
    fBoard.innerHTML = '<p class="b-empty">Choose two different stations.</p>';
    return;
  }
  const key = `${route.from}|${route.to}`;
  if (!lastBoard || `${lastBoard.from.crs}|${lastBoard.to.crs}` !== key) {
    fBoard.innerHTML = '<p class="b-empty">Checking departures…</p>';
  }
  try {
    const res = await fetch(`${WORKER}/api/board?from=${route.from}&to=${route.to}`);
    const d = await res.json();
    if (`${route.from}|${route.to}` !== key) return; // changed meanwhile
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
  setFinderOpen(false);
  select(id);
  const p = position(v, now());
  if (p) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14));
});

async function setFinderOpen(open) {
  finderEl.hidden = !open;
  finderBtn.setAttribute('aria-expanded', open);
  if (!open) {
    clearInterval(boardTimer);
    hideSuggest();
    return;
  }
  closeDetail();
  if (window.matchMedia('(max-width: 899px)').matches) setFiltersOpen(false);
  else if (filtersEl.classList.contains('open')) setFiltersOpen(false);
  try {
    await loadStations();
  } catch {
    setNote('Couldn’t load the station list. Check your connection and try again.');
    return;
  }
  fFrom.value = byCrs(route.from)?.n || '';
  fTo.value = byCrs(route.to)?.n || '';
  renderFavs();
  // Work out where you are each time the finder opens (once per visit)
  if (!located) locate();
  loadBoard();
}
finderBtn.onclick = () => setFinderOpen(finderEl.hidden);
document.getElementById('finderClose').onclick = () => setFinderOpen(false);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !finderEl.hidden && fSuggest.hidden) setFinderOpen(false);
});

// ---------- Ding Ding: buses ----------
// Favourite routes show at any zoom; zoomed in, every bus in view. Positions come from the
// worker, worked out from TfL's arrival predictions, and glide between updates.
const BUS_RED = '#d4302a';
const BUS_POLL_MS = 5000;
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
  if (![...q.keys()].length) {
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
  if (!buses.size) return null;
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
  roundRect(pt.x - w / 2, pt.y - h / 2, w, h, big ? 4 : 2.5);
  ctx.fillStyle = BUS_RED;
  ctx.fill();
  ctx.lineWidth = isSelected ? 3 : fav ? 2 : 1.4;
  ctx.strokeStyle = isSelected ? '#efeadb' : fav ? '#d4a64a' : '#1f3229';
  ctx.stroke();
  if (big) {
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(o.v.n, pt.x, pt.y + 4);
    ctx.textAlign = 'start';
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
  dOp.innerHTML = `<span class="sw" style="--c:${BUS_RED}"></span>London bus`;
  dRoute.textContent = v.d ? `To ${v.d}` : `Route ${v.n}`;
  const r = busRoutes && busRoutes.find((x) => x.id === v.r);
  dFrom.textContent = r ? `Route ${v.n} · ${r.e[0]} – ${r.e[1]}` : `Route ${v.n}`;
  const fav = busFavs.includes(v.r);
  dState.innerHTML = `Next stop ${esc(v.nx)}${v.m <= 0 ? ', due now' : ` in ${v.m} min`}<button class="pill star" id="busStar" aria-pressed="${fav}">${fav ? '★ Saved route' : '☆ Save route'}</button>`;
  document.getElementById('busStar').onclick = () => toggleBusFav(v.r);
  dFoot.textContent = 'Position estimated from TfL arrival predictions. Powered by TfL Open Data.';
}

async function loadBusCalls() {
  const id = selectedId.slice(4);
  let d = null;
  try {
    const res = await fetch(`${WORKER}/api/bus/${encodeURIComponent(id)}`);
    if (res.ok) d = await res.json();
  } catch {}
  if (!d || 'bus:' + d.id !== selectedId) return;
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
const busToggle = document.getElementById('busToggle');
const busSearch = document.getElementById('busSearch');
const busResults = document.getElementById('busResults');
const busFavList = document.getElementById('busFavList');
const busAll = document.getElementById('busAll');

function setBusPanelOpen(open) {
  const panel = document.getElementById('busPanel');
  if (!panel) return;
  if (open) setFiltersOpen(false);
  panel.classList.toggle('open', open);
  document.getElementById('busToggle').setAttribute('aria-expanded', open);
  if (open) {
    loadBusRoutes().then(renderBusLists);
    renderBusNote();
  }
}
busToggle.onclick = () => setBusPanelOpen(!busPanel.classList.contains('open'));
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

window.chooStarted = true;
