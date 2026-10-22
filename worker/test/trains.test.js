import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { loadNaptan, loadSmart } from '../src/reference.js';
import { loadSchedule, sched, applyVstp } from '../src/schedule.js';
import { handleTrust, handleTd, trains, view, detail, _resetForTest } from '../src/trains.js';
import { londonParts, londonDateStr, normaliseLiveTs, londonOffsetMs, londonEpoch } from '../src/time.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-'));
const pad = (n) => String(n).padStart(2, '0');
const now = Date.now();
const today = londonDateStr(now);
const day = londonParts(now).d;

/** CIF "HHMM" for London local time now + offset minutes (kept within today) */
function cif(offsetMin) {
  const p = londonParts(now + offsetMin * 60000);
  return `${pad(p.h)}${pad(p.mi)}`;
}
const mins = (offsetMin) => {
  const p = londonParts(now + offsetMin * 60000);
  return p.h * 60 + p.mi;
};
// Avoid flakiness around midnight
const nearMidnight = mins(0) < 60 || mins(0) > 1380;

const STATIONS = [
  // tiploc, stanox, crs, name, lat, lng, inNaptan
  ['WATRLMN', '87219', 'WAT', 'LONDON WATERLOO', 51.5031, -0.1132, true],
  ['CLPHMJN', '87220', 'CLJ', 'CLAPHAM JUNCTION', 51.4643, -0.1704, true],
  ['CLPHMJW', '87220', 'CLJ', 'CLAPHAM JN WINDSOR', 0, 0, false],
  ['EARLFLD', '87221', '', 'EARLSFIELD JN', 0, 0, false],
  ['WDON', '87244', 'WIM', 'WIMBLEDON', 51.4214, -0.2064, true],
  ['WOKING', '86031', 'WOK', 'WOKING', 51.3185, -0.5569, true],
  ['RDNGSTN', '74237', 'RDG', 'READING', 51.4588, -0.9719, true],
  ['DIDCOTP', '74001', 'DID', 'DIDCOT PARKWAY', 51.611, -1.2427, true],
];

function writeFixtures() {
  const csv = ['ATCOCode,CommonName,Longitude,Latitude,StopType'];
  for (const [t, , , n, lat, lng, inNaptan] of STATIONS)
    if (inNaptan) csv.push(`9100${t},"${n.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())} Rail Station",${lng},${lat},RLY`);
  fs.writeFileSync(path.join(dir, 'naptan.csv'), csv.join('\n'));

  fs.writeFileSync(
    path.join(dir, 'smart.json'),
    JSON.stringify({
      BERTHDATA: [
        { TD: 'WA', FROMBERTH: '0101', TOBERTH: '0103', STANOX: '87220', EVENT: 'C', BERTHOFFSET: '+5', PLATFORM: '9' },
      ],
    }),
  );

  const loc = (type, t, { a, d, p, pa, pd, plat } = {}) => ({
    location_type: type,
    tiploc_code: t,
    arrival: a ?? null,
    departure: d ?? null,
    pass: p ?? null,
    public_arrival: pa ?? null,
    public_departure: pd ?? null,
    platform: plat ?? null,
  });
  const sch = (uid, stp, headcode, toc, cat, locs, status = 'P') => ({
    JsonScheduleV1: {
      CIF_train_uid: uid,
      CIF_stp_indicator: stp,
      schedule_start_date: '2026-01-01',
      schedule_end_date: '2027-12-31',
      schedule_days_runs: '1111111',
      train_status: status,
      atoc_code: toc,
      transaction_type: 'Create',
      schedule_segment: { signalling_id: headcode, CIF_train_category: cat, schedule_location: locs },
    },
  });

  const lines = [JSON.stringify({ JsonTimetableV1: {} })];
  for (const [t, stanox, crs, n] of STATIONS)
    lines.push(JSON.stringify({ TiplocV1: { tiploc_code: t, stanox, crs_code: crs, tps_description: n } }));

  // 1. Waterloo → Woking, departed a few minutes ago
  lines.push(
    JSON.stringify(
      sch('W00001', 'P', '2D41', 'SW', 'OO', [
        loc('LO', 'WATRLMN', { d: cif(-3), pd: cif(-3), plat: '12' }),
        loc('LI', 'CLPHMJW', { a: cif(3), d: cif(4), pa: cif(3), pd: cif(4) }),
        loc('LI', 'EARLFLD', { p: cif(6) }),
        loc('LI', 'WDON', { a: cif(8), d: cif(9), pa: cif(8), pd: cif(9) }),
        loc('LT', 'WOKING', { a: cif(30), pa: cif(30) }),
      ]),
    ),
  );
  // 2. Permanent schedule cancelled today by a C overlay → must not run
  lines.push(
    JSON.stringify(
      sch('W00002', 'P', '2D43', 'SW', 'OO', [
        loc('LO', 'WATRLMN', { d: cif(5), pd: cif(5) }),
        loc('LT', 'WDON', { a: cif(15), pa: cif(15) }),
      ]),
    ),
  );
  lines.push(JSON.stringify({ JsonScheduleV1: { ...sch('W00002', 'C', '', '', '', []).JsonScheduleV1, schedule_segment: {} } }));
  // 3. Freight → excluded
  lines.push(
    JSON.stringify(
      sch('F00001', 'P', '6M23', 'ZZ', 'EE', [
        loc('LO', 'WATRLMN', { d: cif(0) }),
        loc('LT', 'WDON', { a: cif(10) }),
      ], 'F'),
    ),
  );
  // 4. Reading → Didcot never enters London → excluded
  lines.push(
    JSON.stringify(
      sch('G00001', 'P', '2N10', 'GW', 'OO', [
        loc('LO', 'RDNGSTN', { d: cif(0), pd: cif(0) }),
        loc('LT', 'DIDCOTP', { a: cif(15), pa: cif(15) }),
      ]),
    ),
  );
  // 5. Second London train, activation will be "missed"
  lines.push(
    JSON.stringify(
      sch('W00003', 'P', '1W10', 'SW', 'XX', [
        loc('LO', 'WOKING', { d: cif(-25), pd: cif(-25) }),
        loc('LI', 'WDON', { p: cif(-6) }),
        loc('LT', 'WATRLMN', { a: cif(5), pa: cif(5) }),
      ]),
    ),
  );
  fs.writeFileSync(path.join(dir, 'schedule.json.gz'), zlib.gzipSync(lines.join('\n')));
}

test('end to end: schedule load, TRUST and TD updates, views', { skip: nearMidnight && 'near midnight' }, async () => {
  writeFixtures();
  _resetForTest();
  await loadNaptan(path.join(dir, 'naptan.csv'));
  await loadSmart(path.join(dir, 'smart.json'));
  await loadSchedule(path.join(dir, 'schedule.json.gz'), now);

  // Which runs exist today
  assert.ok(sched.runs.has(`W00001|${today}`), 'London passenger train loaded');
  assert.ok(!sched.runs.has(`W00002|${today}`), 'cancelled by STP overlay');
  assert.ok(!sched.runs.has(`F00001|${today}`), 'freight excluded');
  assert.ok(!sched.runs.has(`G00001|${today}`), 'non-London excluded');

  // Activation then a departure from Waterloo 1 minute late
  const trainId = `872D41MY${pad(day)}`;
  handleTrust([
    { header: { msg_type: '0001' }, body: { train_id: trainId, train_uid: 'W00001', tp_origin_timestamp: today } },
  ]);
  assert.equal(trains.size, 1);
  const depTs = londonEpoch(today, mins(-3)) + 60000;
  handleTrust([
    {
      header: { msg_type: '0003' },
      body: { train_id: trainId, event_type: 'DEPARTURE', loc_stanox: '87219', actual_timestamp: String(depTs), platform: '12' },
    },
  ]);
  let v = view(trains.get(`W00001|${today}`), now);
  assert.equal(v.st, 'mv');
  assert.equal(v.op, 'South Western Railway');
  assert.equal(v.o, 'London Waterloo');
  assert.equal(v.d, 'Woking');
  assert.equal(v.dl, 1);
  // Moving from Waterloo towards Clapham Junction (Windsor-side TIPLOC borrowed coords via CRS)
  assert.deepEqual(v.seg.slice(0, 4), [51.5031, -0.1132, 51.4643, -0.1704]);
  assert.equal(v.nx, 'Clapham Junction');

  // TD berth step at Clapham (SMART event C = arrive) → train shown at the station
  const tdTs = londonEpoch(today, mins(3)) + 90000;
  handleTd([{ CA_MSG: { area_id: 'WA', msg_type: 'CA', from: '0101', to: '0103', descr: '2D41', time: String(tdTs) } }]);
  v = view(trains.get(`W00001|${today}`), now);
  assert.equal(v.st, 'at');
  assert.equal(v.at, 'Clapham Junction');
  assert.equal(v.pl, '9');
  assert.equal(v.src, 'TD');

  // Late TRUST report of the same arrival must not override TD
  handleTrust([
    {
      header: { msg_type: '0003' },
      body: { train_id: trainId, event_type: 'ARRIVAL', loc_stanox: '87220', actual_timestamp: String(tdTs + 30000) },
    },
  ]);
  assert.equal(view(trains.get(`W00001|${today}`), now).src, 'TD');

  // Passing Earlsfield (no coordinates) → interpolate between Clapham and Wimbledon
  handleTrust([
    {
      header: { msg_type: '0003' },
      body: { train_id: trainId, event_type: 'DEPARTURE', loc_stanox: '87221', actual_timestamp: String(londonEpoch(today, mins(6))) },
    },
  ]);
  v = view(trains.get(`W00001|${today}`), now);
  assert.equal(v.st, 'mv');
  assert.deepEqual(v.seg.slice(0, 4), [51.4643, -0.1704, 51.4214, -0.2064]);
  assert.ok(v.seg[4] < v.seg[5]);

  // Missed activation: a movement for an unknown train is matched by headcode + location + time
  handleTrust([
    {
      header: { msg_type: '0003' },
      body: { train_id: `861W10MX${pad(day)}`, event_type: 'DEPARTURE', loc_stanox: '87244', actual_timestamp: String(londonEpoch(today, mins(-5))) },
    },
  ]);
  const t3 = trains.get(`W00003|${today}`);
  assert.ok(t3, 'resolved without activation');
  assert.equal(view(t3, now).nx, 'London Waterloo');

  // Detail view
  const d = detail(`W00001|${today}`);
  assert.equal(d.stops.length, 4); // passing point Earlsfield is not a stop
  assert.ok(d.stops[0].done);
  assert.ok(d.path.length >= 4);

  // Terminating
  handleTrust([
    {
      header: { msg_type: '0003' },
      body: { train_id: trainId, event_type: 'ARRIVAL', loc_stanox: '86031', actual_timestamp: String(londonEpoch(today, mins(30))), train_terminated: 'true' },
    },
  ]);
  assert.equal(view(trains.get(`W00001|${today}`), now).st, 'end');
});

test('VSTP create adds a run', { skip: nearMidnight && 'near midnight' }, () => {
  const t6 = (m) => cif(m) + '00';
  applyVstp({
    VSTPCIFMsgV1: {
      schedule: {
        transaction_type: 'Create',
        CIF_train_uid: ' 99999',
        schedule_start_date: today,
        schedule_end_date: today,
        schedule_days_runs: '1111111',
        CIF_stp_indicator: 'N',
        train_status: '1',
        atoc_code: 'SW',
        schedule_segment: [
          {
            signalling_id: '2Z99',
            CIF_train_category: 'OO',
            schedule_location: [
              { scheduled_departure_time: t6(1), public_departure_time: t6(1), location: { tiploc: { tiploc_id: 'WATRLMN' } } },
              { scheduled_arrival_time: t6(12), public_arrival_time: t6(12), location: { tiploc: { tiploc_id: 'WDON' } } },
            ],
          },
        ],
      },
    },
  });
  assert.ok(sched.runs.get(` 99999|${today}`)?.vstp);
});

test('local-time timestamps are normalised', () => {
  const t = Date.now();
  const off = londonOffsetMs(t);
  assert.ok(Math.abs(normaliseLiveTs(t + off, t) - t) < 2);
  assert.ok(Math.abs(normaliseLiveTs(t, t) - t) < 2);
});
