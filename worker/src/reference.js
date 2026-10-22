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

// CRS → [name, lat, lng] for the London termini, used only if NaPTAN doesn't give them
const TERMINI = {
  WAT: ['London Waterloo', 51.5031, -0.1132],
  VIC: ['London Victoria', 51.4952, -0.1441],
  LBG: ['London Bridge', 51.5049, -0.0863],
  CHX: ['London Charing Cross', 51.5080, -0.1247],
  CST: ['London Cannon Street', 51.5113, -0.0904],
  BFR: ['London Blackfriars', 51.5116, -0.1033],
  LST: ['London Liverpool Street', 51.5178, -0.0817],
  FST: ['London Fenchurch Street', 51.5116, -0.0789],
  EUS: ['London Euston', 51.5282, -0.1337],
  KGX: ['London Kings Cross', 51.5320, -0.1233],
  STP: ['London St Pancras International', 51.5320, -0.1270],
  PAD: ['London Paddington', 51.5154, -0.1755],
  MYB: ['London Marylebone', 51.5225, -0.1631],
  MOG: ['Moorgate', 51.5186, -0.0886],
};

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
  // Passenger stations: CRS codes that have a known location. Usually NaPTAN lists the
  // station under one of its own TIPLOCs; when it lists it under a TIPLOC with no CRS code
  // (London Waterloo, for one), the location is borrowed via the shared STANOX above and
  // the name comes from the timetable instead.
  ref.stations.clear();
  ref.tiplocCrs.clear();
  for (const t of pendingTiplocs) {
    if (!t._crs) continue;
    const own = byCrs.get(t._crs);
    const c = own || ref.coords.get(t._tiploc);
    if (!c) continue;
    let st = ref.stations.get(t._crs);
    if (!st) {
      const name = own ? c.name : ref.names.get(t._tiploc) || c.name;
      ref.stations.set(t._crs, (st = { crs: t._crs, name, lat: c.lat, lng: c.lng, tiplocs: new Set() }));
    }
    st.tiplocs.add(t._tiploc);
    ref.tiplocCrs.set(t._tiploc, t._crs);
  }
  // Last resort for the London termini, so the train finder always has them
  for (const t of pendingTiplocs) {
    const f = TERMINI[t._crs];
    if (!f || (ref.stations.has(t._crs) && ref.stations.get(t._crs)._fixed !== true)) continue;
    let st = ref.stations.get(t._crs);
    if (!st) {
      st = { crs: t._crs, name: f[0], lat: f[1], lng: f[2], tiplocs: new Set(), _fixed: true };
      ref.stations.set(t._crs, st);
      console.log(`[ref] ${t._crs} not in NaPTAN; using built-in location`);
    }
    st.tiplocs.add(t._tiploc);
    ref.tiplocCrs.set(t._tiploc, t._crs);
    if (!ref.coords.has(t._tiploc)) ref.coords.set(t._tiploc, { lat: f[1], lng: f[2], name: f[0] });
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
