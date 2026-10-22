// Demo mode: simulated trains on real London routes, so the map works before
// the live worker is set up. Positions are computed from the clock, so every
// device sees the same trains.

const S = {
  WAT: ['London Waterloo', 51.5031, -0.1132],
  VXH: ['Vauxhall', 51.4861, -0.1229],
  CLJ: ['Clapham Junction', 51.4643, -0.1704],
  WIM: ['Wimbledon', 51.4214, -0.2064],
  SUR: ['Surbiton', 51.3925, -0.304],
  WOK: ['Woking', 51.3185, -0.5569],
  RMD: ['Richmond', 51.4631, -0.3015],
  TWI: ['Twickenham', 51.45, -0.3301],
  VIC: ['London Victoria', 51.4952, -0.1441],
  ECR: ['East Croydon', 51.3755, -0.0927],
  GTW: ['Gatwick Airport', 51.1565, -0.161],
  LBG: ['London Bridge', 51.5049, -0.0863],
  LEW: ['Lewisham', 51.4657, -0.0139],
  ORP: ['Orpington', 51.3732, 0.089],
  SEV: ['Sevenoaks', 51.2768, 0.1817],
  CHX: ['London Charing Cross', 51.508, -0.1247],
  CST: ['London Cannon Street', 51.5113, -0.0904],
  PAD: ['London Paddington', 51.5154, -0.1755],
  EAL: ['Ealing Broadway', 51.5148, -0.3017],
  STL: ['Southall', 51.5059, -0.3786],
  SLO: ['Slough', 51.5119, -0.5915],
  RDG: ['Reading', 51.4588, -0.9719],
  HXX: ['Heathrow Terminals 2 & 3', 51.4713, -0.4542],
  EUS: ['London Euston', 51.5282, -0.1337],
  WMB: ['Wembley Central', 51.5524, -0.2964],
  HRW: ['Harrow & Wealdstone', 51.5921, -0.3346],
  WFJ: ['Watford Junction', 51.6636, -0.3961],
  MKC: ['Milton Keynes Central', 52.0343, -0.7741],
  KGX: ["London King's Cross", 51.5308, -0.1238],
  FPK: ['Finsbury Park', 51.5643, -0.1065],
  AAP: ['Alexandra Palace', 51.5983, -0.1201],
  PBR: ['Potters Bar', 51.6971, -0.1924],
  SVG: ['Stevenage', 51.9017, -0.2071],
  STP: ['London St Pancras', 51.532, -0.1263],
  KTN: ['Kentish Town', 51.5503, -0.1404],
  WHP: ['West Hampstead Thameslink', 51.5485, -0.1917],
  SAC: ['St Albans City', 51.7505, -0.3275],
  LTN: ['Luton Airport Parkway', 51.8723, -0.3956],
  ZFD: ['Farringdon', 51.5203, -0.1053],
  CTK: ['City Thameslink', 51.5139, -0.1036],
  BFR: ['London Blackfriars', 51.5117, -0.1034],
  LST: ['London Liverpool Street', 51.5179, -0.0814],
  SRA: ['Stratford', 51.5416, -0.0034],
  RMF: ['Romford', 51.5748, 0.1832],
  SNF: ['Shenfield', 51.6309, 0.3297],
  TOM: ['Tottenham Hale', 51.5884, -0.0601],
  CHN: ['Cheshunt', 51.7027, -0.024],
  FST: ['London Fenchurch Street', 51.5116, -0.0789],
  BKG: ['Barking', 51.5396, 0.0809],
  UPM: ['Upminster', 51.559, 0.251],
  MYB: ['London Marylebone', 51.5225, -0.1631],
  WCX: ['Wembley Stadium', 51.5543, -0.2853],
  HWY: ['High Wycombe', 51.6293, -0.7454],
  HHY: ['Highbury & Islington', 51.546, -0.104],
  DLJ: ['Dalston Junction', 51.5461, -0.0751],
  ZLW: ['Whitechapel', 51.5195, -0.0597],
  ZCW: ['Canada Water', 51.498, -0.0497],
  SPB: ["Shepherd's Bush", 51.5056, -0.2176],
  WIJ: ['Willesden Junction', 51.5323, -0.2443],
  ABW: ['Abbey Wood', 51.491, 0.1214],
  CWX: ['Canary Wharf', 51.5059, -0.0189],
  TCR: ['Tottenham Court Road', 51.5163, -0.1306],
  BDS: ['Bond Street', 51.5142, -0.1494],
};

// [operator, headcode prefix, headway minutes, avg km/h, stations…]
const ROUTES = [
  ['SW', '2D', 10, 65, 'WAT', 'VXH', 'CLJ', 'WIM', 'SUR', 'WOK'],
  ['SW', '2R', 15, 50, 'WAT', 'VXH', 'CLJ', 'RMD', 'TWI'],
  ['SN', '1C', 12, 70, 'VIC', 'CLJ', 'ECR', 'GTW'],
  ['GX', '9G', 30, 95, 'VIC', 'GTW'],
  ['TL', '9X', 10, 60, 'SAC', 'WHP', 'KTN', 'STP', 'ZFD', 'CTK', 'BFR', 'LBG', 'ECR', 'GTW'],
  ['SE', '2K', 12, 60, 'CHX', 'LBG', 'LEW', 'ORP', 'SEV'],
  ['SE', '2H', 15, 45, 'CST', 'LBG', 'LEW'],
  ['GW', '1R', 15, 110, 'PAD', 'SLO', 'RDG'],
  ['GW', '2N', 20, 60, 'PAD', 'EAL', 'STL', 'SLO', 'RDG'],
  ['HX', '1Z', 15, 90, 'PAD', 'HXX'],
  ['XR', '9U', 6, 45, 'ABW', 'CWX', 'ZLW', 'LST', 'ZFD', 'TCR', 'BDS', 'PAD', 'EAL', 'STL', 'HXX'],
  ['VT', '1A', 20, 120, 'EUS', 'WFJ', 'MKC'],
  ['LM', '2Y', 15, 60, 'EUS', 'WMB', 'HRW', 'WFJ'],
  ['GR', '1S', 30, 125, 'KGX', 'SVG'],
  ['GN', '2V', 12, 50, 'KGX', 'FPK', 'AAP', 'PBR'],
  ['EM', '1M', 30, 120, 'STP', 'LTN'],
  ['LE', '2W', 10, 60, 'LST', 'SRA', 'RMF', 'SNF'],
  ['LE', '2C', 15, 55, 'LST', 'TOM', 'CHN'],
  ['CC', '2E', 15, 60, 'FST', 'BKG', 'UPM'],
  ['CH', '2H', 20, 70, 'MYB', 'WCX', 'HWY'],
  ['LO', '9P', 8, 40, 'HHY', 'DLJ', 'ZLW', 'ZCW'],
  ['LO', '9J', 12, 40, 'CLJ', 'SPB', 'WIJ'],
];

const DWELL = 45; // seconds at each intermediate stop

function km(a, b) {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[2] - a[2]) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x)) * 1.15; // track is longer than straight line
}

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const hhmm = (ms) => fmt.format(new Date(ms));

// Pre-compute each route's timings (seconds from departure) in both directions
const TRIPS = [];
ROUTES.forEach(([toc, prefix, headway, speed, ...codes], r) => {
  for (const dir of [0, 1]) {
    const stops = (dir ? [...codes].reverse() : codes).map((c) => S[c]);
    const arr = [0];
    const dep = [0];
    for (let i = 1; i < stops.length; i++) {
      arr[i] = dep[i - 1] + (km(stops[i - 1], stops[i]) / speed) * 3600 + 30;
      dep[i] = arr[i] + (i < stops.length - 1 ? DWELL : 0);
    }
    TRIPS.push({ toc, prefix, headway: headway * 60, stops, arr, dep, total: arr[arr.length - 1], key: `${r}${dir}` });
  }
});

function tripState(trip, k, now) {
  const offset = hash(trip.key) * trip.headway;
  const start = (k * trip.headway + offset) * 1000;
  const r = hash(trip.key + k);
  const delay = r > 0.85 ? Math.round((r - 0.85) * 80) : r > 0.6 ? 1 + Math.round(r * 2) : 0;
  const t = (now - start) / 1000 - delay * 60;
  return { start, delay, t };
}

function build(trip, k, now) {
  const { start, delay, t } = tripState(trip, k, now);
  if (t < -120 || t > trip.total + 60) return null;
  const { stops, arr, dep } = trip;
  const hc = `${trip.prefix}${String((k * 7 + Number(trip.key)) % 100).padStart(2, '0')}`;
  const v = {
    id: `demo-${trip.key}-${k}`,
    hc,
    toc: trip.toc,
    o: stops[0][0],
    d: stops[stops.length - 1][0],
    dep: hhmm(start),
    dl: delay,
    src: 'demo',
    up: now,
  };
  const base = start + delay * 60000;
  const at = (i) => [stops[i][1], stops[i][2]];
  if (t < 0) {
    Object.assign(v, { st: 'wait', p: at(0), at: stops[0][0] });
  } else if (t >= trip.total) {
    Object.assign(v, { st: 'end', p: at(stops.length - 1), at: stops[stops.length - 1][0] });
  } else {
    let i = 0;
    while (i < stops.length - 1 && t >= arr[i + 1]) i++;
    if (t < dep[i]) {
      Object.assign(v, { st: 'at', p: at(i), at: stops[i][0] });
    } else {
      const a = at(i);
      const b = at(i + 1);
      v.st = 'mv';
      v.seg = [a[0], a[1], b[0], b[1], base + dep[i] * 1000, base + arr[i + 1] * 1000];
      v.at = stops[i][0];
    }
    const n = Math.min(i + 1, stops.length - 1);
    v.nx = stops[n][0];
    v.nxt = hhmm(base + arr[n] * 1000);
  }
  return v;
}

export function demoSnapshot(now = Date.now()) {
  const out = [];
  for (const trip of TRIPS) {
    const kNow = Math.floor(now / 1000 / trip.headway);
    const span = Math.ceil(trip.total / trip.headway) + 2;
    for (let k = kNow - span; k <= kNow + 1; k++) {
      const v = build(trip, k, now);
      if (v) out.push(v);
    }
  }
  return out;
}

export function demoDetail(id, now = Date.now()) {
  const [, key, kStr] = id.split('-');
  const trip = TRIPS.find((t) => t.key === key);
  if (!trip) return null;
  const k = Number(kStr);
  const { start, delay, t } = tripState(trip, k, now);
  const stops = trip.stops.map((s, i) => {
    const sch = start + (i === 0 ? 0 : trip.arr[i]) * 1000;
    const done = t > (i === trip.stops.length - 1 ? trip.arr[i] : trip.dep[i]);
    const here = !done && t >= trip.arr[i] && i > 0;
    return { n: s[0], s: hhmm(sch), e: done || here ? null : hhmm(sch + delay * 60000), done, here };
  });
  return { id, hc: build(trip, k, now)?.hc, toc: trip.toc, stops, path: trip.stops.map((s) => [s[1], s[2]]), delay };
}
