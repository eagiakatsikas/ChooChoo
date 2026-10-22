// Static reference data: station coordinates, TIPLOC/STANOX lookups, SMART berth map.
import { lines, readAll } from './download.js';

export const ref = {
  /** tiploc → { lat, lng, name } */
  coords: new Map(),
  /** tiploc → display name (from schedule TIPLOC records) */
  names: new Map(),
  /** stanox → [tiploc] */
  stanoxTiplocs: new Map(),
  /** "TD|FROM|TO" → [{ stanox, event, offset, platform }] */
  smart: new Map(),
  /** tiplocs inside the London box */
  london: new Set(),
  /** CRS code → { crs, name, lat, lng, tiplocs: Set } for passenger stations */
  stations: new Map(),
  /** tiploc → CRS code */
  tiplocCrs: new Map(),
};

export function normStanox(s) {
  if (s == null) return '';
  s = String(s).trim();
  return s ? s.padStart(5, '0') : '';
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bJn\b/g, 'Jn');
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** NaPTAN CSV: rail stations have ATCO code "9100" + TIPLOC. */
export async function loadNaptan(file) {
  let header = null;
  let n = 0;
  for await (const line of lines(file)) {
    if (!line.trim()) continue;
    const row = parseCsvLine(line);
    if (!header) {
      header = Object.fromEntries(row.map((h, i) => [h.trim(), i]));
      continue;
    }
    const atco = row[header.ATCOCode] || '';
    const type = row[header.StopType] || '';
    if (!atco.startsWith('9100') || (type && type !== 'RLY')) continue;
    const lat = Number(row[header.Latitude]);
    const lng = Number(row[header.Longitude]);
    if (!lat || !lng) continue;
    const tiploc = atco.slice(4).trim();
    const name = (row[header.CommonName] || tiploc).replace(/\s+Rail Station$/i, '').trim();
    ref.coords.set(tiploc, { lat, lng, name });
    n++;
  }
  console.log(`[ref] ${n} station coordinates`);
}

/** SMART: maps train describer berth steps to station events. */
export async function loadSmart(file) {
  const json = JSON.parse(await readAll(file));
  const rows = json.BERTHDATA || json;
  ref.smart.clear();
  let n = 0;
  for (const r of rows) {
    const stanox = normStanox(r.STANOX);
    if (!stanox || !r.TD) continue;
    const key = `${r.TD}|${(r.FROMBERTH || '').trim()}|${(r.TOBERTH || '').trim()}`;
    const entry = {
      stanox,
      event: (r.EVENT || '').trim(),
      offset: Number(r.BERTHOFFSET) || 0,
      platform: (r.PLATFORM || '').trim(),
    };
    const list = ref.smart.get(key);
    if (list) list.push(entry);
    else ref.smart.set(key, [entry]);
    n++;
  }
  console.log(`[ref] ${n} SMART berth steps`);
}

/** Called with each TiplocV1 record from the schedule file. */
export function addTiploc(t) {
  const tiploc = (t.tiploc_code || '').trim();
  if (!tiploc) return;
  const stanox = normStanox(t.stanox);
  const desc = t.tps_description || t.description || tiploc;
  ref.names.set(tiploc, titleCase(desc));
  if (stanox) {
    const list = ref.stanoxTiplocs.get(stanox);
    if (list) {
      if (!list.includes(tiploc)) list.push(tiploc);
    } else ref.stanoxTiplocs.set(stanox, [tiploc]);
  }
  t._crs = (t.crs_code || '').trim();
  t._stanox = stanox;
  t._tiploc = tiploc;
  pendingTiplocs.push(t);
}

const pendingTiplocs = [];

/**
 * After all TIPLOC records are read: stations often have several TIPLOCs but NaPTAN
 * lists one. Borrow coordinates from a sibling sharing a CRS code or STANOX.
 */
export function finaliseTiplocs() {
  const byCrs = new Map();
  const byStanox = new Map();
  for (const t of pendingTiplocs) {
    const c = ref.coords.get(t._tiploc);
    if (!c) continue;
    if (t._crs && !byCrs.has(t._crs)) byCrs.set(t._crs, c);
    if (t._stanox && !byStanox.has(t._stanox)) byStanox.set(t._stanox, c);
  }
  let borrowed = 0;
  for (const t of pendingTiplocs) {
    if (ref.coords.has(t._tiploc)) continue;
    const c = (t._crs && byCrs.get(t._crs)) || (t._stanox && byStanox.get(t._stanox));
    if (c) {
      ref.coords.set(t._tiploc, c);
      borrowed++;
    }
  }
  // Passenger stations: CRS codes that have a known location (from NaPTAN)
  ref.stations.clear();
  ref.tiplocCrs.clear();
  for (const t of pendingTiplocs) {
    if (!t._crs) continue;
    const c = byCrs.get(t._crs);
    if (!c) continue;
    let st = ref.stations.get(t._crs);
    if (!st) ref.stations.set(t._crs, (st = { crs: t._crs, name: c.name, lat: c.lat, lng: c.lng, tiplocs: new Set() }));
    st.tiplocs.add(t._tiploc);
    ref.tiplocCrs.set(t._tiploc, t._crs);
  }
  pendingTiplocs.length = 0;
  console.log(`[ref] ${borrowed} extra TIPLOCs mapped via CRS/STANOX; ${ref.stations.size} stations`);
}

export function computeLondon(box) {
  ref.london.clear();
  for (const [tiploc, c] of ref.coords) {
    if (c.lat >= box.s && c.lat <= box.n && c.lng >= box.w && c.lng <= box.e) ref.london.add(tiploc);
  }
  console.log(`[ref] ${ref.london.size} TIPLOCs inside the London area`);
}

export function locName(tiploc) {
  return ref.coords.get(tiploc)?.name || ref.names.get(tiploc) || tiploc;
}

export function tiplocsForStanox(stanox) {
  return ref.stanoxTiplocs.get(normStanox(stanox)) || [];
}
