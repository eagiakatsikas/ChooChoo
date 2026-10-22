import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { OPERATORS, opName, opColour, delayColour } from './operators.js';
import { demoSnapshot, demoDetail } from './demo.js';

// ---------- Data source ----------
const params = new URLSearchParams(location.search);
const WORKER = (params.get('worker') || import.meta.env.VITE_WORKER_URL || '').replace(/\/$/, '');
const DEMO = !WORKER || params.has('demo');

const trains = new Map(); // id → view from the worker
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
// ---------- Basemaps: plain map or satellite imagery ----------
const CARTO_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const BASEMAPS = {
  map: [
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: CARTO_ATTR,
    }),
  ],
  satellite: [
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      maxNativeZoom: 18,
      className: 'sat-tiles',
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    }),
    // Place names on top of the imagery
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      pane: 'shadowPane',
      attribution: CARTO_ATTR,
    }),
  ],
};

function setBasemap(name) {
  if (!BASEMAPS[name]) name = 'map';
  for (const layers of Object.values(BASEMAPS)) for (const l of layers) l.remove();
  for (const l of BASEMAPS[name]) l.addTo(map);
  store.set('basemap', name);
  document.body.dataset.basemap = name;
  for (const b of document.querySelectorAll('[data-basemap]')) b.setAttribute('aria-pressed', b.dataset.basemap === name);
}
for (const b of document.querySelectorAll('[data-basemap]')) b.addEventListener('click', () => setBasemap(b.dataset.basemap));
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
map.on('zoomstart', () => canvas.classList.add('hide'));
map.on('zoomend', () => canvas.classList.remove('hide'));
resize();

function position(v, t) {
  if (v.st === 'mv' && v.seg) {
    const [la0, ln0, la1, ln1, t0, t1] = v.seg;
    let f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    f = Math.max(0, Math.min(0.97, f)); // wait just short of the station until it's reported
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
    const pt = map.latLngToContainerPoint([p.lat, p.lng]);
    if (pt.x < -20 || pt.y < -20 || pt.x > size.x + 20 || pt.y > size.y + 20) continue;
    drawn.push([pt.x, pt.y, v.id]);
    if (v.id === selectedId) {
      selected = { v, pt, p };
      continue;
    }
    drawTrain(v, pt, p, r, labels, false);
  }
  if (selected) drawTrain(selected.v, selected.pt, selected.p, r + 2.5, true, true);
  requestAnimationFrame(draw);
}

function drawTrain(v, pt, p, r, label, isSelected) {
  const c = colourOf(v);
  const faded = v.st === 'end' || v.st === 'wait';
  ctx.globalAlpha = faded ? 0.5 : 1;

  // Direction of travel
  if (p.dir && (p.dir[0] || p.dir[1])) {
    const ahead = map.latLngToContainerPoint([p.lat + p.dir[0] * 0.001, p.lng + p.dir[1] * 0.001]);
    const dx = ahead.x - pt.x;
    const dy = ahead.y - pt.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
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

function updateCounts() {
  let shown = 0;
  const perOp = new Map();
  for (const v of trains.values()) {
    if (v.st === 'end') continue;
    const k = v.toc in OPERATORS ? v.toc : 'ZZ';
    perOp.set(k, (perOp.get(k) || 0) + 1);
    if (visible(v)) shown++;
  }
  countEl.textContent = `${shown} ${shown === 1 ? 'train' : 'trains'} on the map`;
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

function renderDetailHeader() {
  const v = trains.get(selectedId);
  if (!v) return;
  dHead.textContent = v.hc;
  dOp.innerHTML = `<span class="sw" style="--c:${opColour(v.toc)}"></span>${opName(v.toc)}`;
  dRoute.textContent = `To ${v.d}`;
  dFrom.textContent = `${v.dep} from ${v.o}`;
  const dl = delayText(v.dl);
  dState.innerHTML = `${stateText(v)}<span class="pill" style="--c:${delayColour(v.dl)}">${dl}</span>`;
  const src = { TD: 'signalling', TRUST: 'train reporting', schedule: 'timetable', demo: 'simulated' }[v.src] || v.src;
  dFoot.textContent = DEMO ? 'Demo data, not real trains' : `Last reported ${ago(v.up)} from ${src} data`;
}

async function loadCalls() {
  let d = null;
  if (DEMO) d = demoDetail(selectedId, now());
  else {
    try {
      const res = await fetch(`${WORKER}/api/train/${encodeURIComponent(selectedId)}`);
      if (res.ok) d = await res.json();
    } catch {}
  }
  if (!d || d.id !== selectedId) return;
  dCalls.innerHTML = d.stops
    .map(
      (s) =>
        `<li class="${s.done ? 'done' : ''} ${s.here ? 'here' : ''}"><span class="t">${s.s}</span><span class="n">${s.n}</span><span class="e">${
          s.e && s.e !== s.s ? `exp ${s.e}` : s.pl ? `plat ${s.pl}` : ''
        }</span></li>`,
    )
    .join('');
  if (routeLine) routeLine.remove();
  routeLine = L.polyline(d.path, { color: '#d4a64a', weight: 3, opacity: 0.85, dashArray: '2 7', interactive: false }).addTo(map);
}

function select(id) {
  selectedId = id;
  detailEl.hidden = false;
  dCalls.innerHTML = '';
  if (window.matchMedia('(max-width: 899px)').matches) setFiltersOpen(false);
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
  if (e.key === 'Escape') closeDetail();
});

// ---------- Feeding data in ----------
function replaceAll(list) {
  trains.clear();
  for (const v of list) trains.set(v.id, v);
  afterUpdate();
}

function afterUpdate() {
  updateCounts();
  if (selectedId) {
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
    for (const id of d.del) trains.delete(id);
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
