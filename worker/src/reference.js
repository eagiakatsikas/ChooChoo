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

/** British National Grid easting/northing → WGS84 [lat, lng] (accurate to a few metres). */
export function osgbToWgs84(E, N) {
  if (!E || !N) return null;
  const a = 6377563.396, b = 6356256.909, F0 = 0.9996012717;
  const lat0 = (49 * Math.PI) / 180, lon0 = (-2 * Math.PI) / 180, N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b);
  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const dl = lat - lat0, sl = lat + lat0;
    M = b * F0 * ((1 + n + 1.25 * n * n + 1.25 * n ** 3) * dl
      - (3 * n + 3 * n * n + 2.625 * n ** 3) * Math.sin(dl) * Math.cos(sl)
      + (1.875 * n * n + 1.875 * n ** 3) * Math.sin(2 * dl) * Math.cos(2 * sl)
      - (35 / 24) * n ** 3 * Math.sin(3 * dl) * Math.cos(3 * sl));
  } while (Math.abs(N - N0 - M) >= 0.00001);
  const s = Math.sin(lat), c = Math.cos(lat), t = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * s * s);
  const rho = (a * F0 * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
  const eta2 = nu / rho - 1;
  const dE = E - E0;
  const VII = t / (2 * rho * nu);
  const VIII = (t / (24 * rho * nu ** 3)) * (5 + 3 * t * t + eta2 - 9 * t * t * eta2);
  const IX = (t / (720 * rho * nu ** 5)) * (61 + 90 * t * t + 45 * t ** 4);
  const X = 1 / (c * nu);
  const XI = (1 / (c * 6 * nu ** 3)) * (nu / rho + 2 * t * t);
  const XII = (1 / (c * 120 * nu ** 5)) * (5 + 28 * t * t + 24 * t ** 4);
  const XIIA = (1 / (c * 5040 * nu ** 7)) * (61 + 662 * t * t + 1320 * t ** 4 + 720 * t ** 6);
  const phi = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lam = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;
  // OSGB36 → WGS84 (Helmert)
  const toXYZ = (p, l, A, B) => {
    const ee = 1 - (B * B) / (A * A);
    const v = A / Math.sqrt(1 - ee * Math.sin(p) ** 2);
    return [v * Math.cos(p) * Math.cos(l), v * Math.cos(p) * Math.sin(l), (1 - ee) * v * Math.sin(p)];
  };
  const [x1, y1, z1] = toXYZ(phi, lam, a, b);
  const sc = 20.4894e-6, sec = Math.PI / 648000;
  const rx = 0.1502 * sec, ry = 0.247 * sec, rz = 0.8421 * sec;
  const x2 = 446.448 + (1 + sc) * x1 - rz * y1 + ry * z1;
  const y2 = -125.157 + rz * x1 + (1 + sc) * y1 - rx * z1;
  const z2 = 542.06 - ry * x1 + rx * y1 + (1 + sc) * z1;
  const A2 = 6378137, B2 = 6356752.3142, ee2 = 1 - (B2 * B2) / (A2 * A2);
  const p = Math.hypot(x2, y2);
  let la = Math.atan2(z2, p * (1 - ee2)), prev;
  do {
    prev = la;
    const v = A2 / Math.sqrt(1 - ee2 * Math.sin(la) ** 2);
    la = Math.atan2(z2 + ee2 * v * Math.sin(la), p);
  } while (Math.abs(la - prev) > 1e-12);
  return [(la * 180) / Math.PI, (Math.atan2(y2, x2) * 180) / Math.PI];
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
  let buf = '';
  for await (const line of lines(file)) {
    // A quoted field can contain line breaks: keep joining lines until the quotes balance
    buf = buf ? `${buf}\n${line}` : line;
    if ((buf.match(/"/g) || []).length % 2) continue;
    const record = buf;
    buf = '';
    if (!record.trim()) continue;
    const row = parseCsvLine(record);
    if (!header) {
      header = Object.fromEntries(row.map((h, i) => [h.trim().replace(/^﻿/, ''), i]));
      continue;
    }
    const atco = (row[header.ATCOCode] || '').trim();
    const type = (row[header.StopType] || '').trim();
    if (!atco.startsWith('9100') || (type && type !== 'RLY')) continue;
    let lat = Number(row[header.Latitude]);
    let lng = Number(row[header.Longitude]);
    if (!lat || !lng) {
      // Some stops only have British National Grid coordinates
      const ll = osgbToWgs84(Number(row[header.Easting]), Number(row[header.Northing]));
      if (!ll) continue;
      [lat, lng] = ll;
    }
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

// CRS → [name, lat, lng] for London's termini and busiest interchanges, used only if
// NaPTAN doesn't give them
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
  CLJ: ['Clapham Junction', 51.4643, -0.1704],
  SRA: ['Stratford', 51.5419, -0.0034],
  ZFD: ['Farringdon', 51.5203, -0.1053],
  CTK: ['City Thameslink', 51.5139, -0.1033],
  VXH: ['Vauxhall', 51.4861, -0.1229],
  ECR: ['East Croydon', 51.3753, -0.0927],
  WIM: ['Wimbledon', 51.4214, -0.2064],
  SUR: ['Surbiton', 51.3925, -0.3041],
  RMD: ['Richmond', 51.4631, -0.3013],
  WIJ: ['Willesden Junction', 51.5325, -0.2447],
  HHY: ['Highbury & Islington', 51.5461, -0.1040],
  CBW: ['Canada Water', 51.4980, -0.0498],
  WWA: ['Woolwich Arsenal', 51.4900, 0.0693],
  LEW: ['Lewisham', 51.4657, -0.0141],
  BRX: ['Brixton', 51.4633, -0.1145],
  DMK: ['Denmark Hill', 51.4682, -0.0894],
  NWX: ['New Cross', 51.4764, -0.0324],
  SVS: ['Seven Sisters', 51.5822, -0.0749],
  TOM: ['Tottenham Hale', 51.5883, -0.0599],
  EAL: ['Ealing Broadway', 51.5150, -0.3017],
  ABW: ['Abbey Wood', 51.4911, 0.1214],
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
  // TIPLOCs with no CRS code of their own that share a STANOX with a station are part of
  // it (London Waterloo's code sits on one TIPLOC while its trains are timetabled at another).
  const stanoxCrs = new Map();
  for (const t of pendingTiplocs) {
    if (t._crs && t._stanox && ref.stations.has(t._crs) && !stanoxCrs.has(t._stanox)) stanoxCrs.set(t._stanox, t._crs);
  }
  for (const t of pendingTiplocs) {
    if (t._crs || !t._stanox) continue;
    const crs = stanoxCrs.get(t._stanox);
    if (!crs) continue;
    ref.stations.get(crs).tiplocs.add(t._tiploc);
    ref.tiplocCrs.set(t._tiploc, crs);
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
