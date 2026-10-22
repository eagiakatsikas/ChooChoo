import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from '../src/reference.js';
import { _addRunForTest } from '../src/schedule.js';
import { board, stationList } from '../src/board.js';
import { londonDateStr, londonParts } from '../src/time.js';

const now = Date.now();
const today = londonDateStr(now);
const p = londonParts(now);
const m = p.h * 60 + p.mi;
const nearMidnight = m < 30 || m > 1300;

function station(crs, name, lat, lng, tiplocs) {
  ref.stations.set(crs, { crs, name, lat, lng, tiplocs: new Set(tiplocs) });
  for (const t of tiplocs) ref.coords.set(t, { lat, lng, name });
}

test('departures board from the timetable: direct trains only, best train marked', { skip: nearMidnight && 'near midnight' }, async () => {
  station('WAT', 'London Waterloo', 51.5031, -0.1132, ['WATRLMN']);
  station('CLJ', 'Clapham Junction', 51.4643, -0.1704, ['CLPHMJN', 'CLPHMJW']);
  station('RAY', 'Raynes Park', 51.4093, -0.2302, ['RAYNSPK']);
  station('WOK', 'Woking', 51.3185, -0.5569, ['WOKING']);

  // A slow train to Raynes Park leaving first, a faster one leaving a bit later and arriving first,
  // and one that doesn't stop at Raynes Park at all.
  const loc = (t, a, d, plat = '') => ({ t, a, d, p: null, pub: true, plat });
  _addRunForTest({ uid: 'S1', headcode: '2K11', toc: 'SW', cat: 'OO', locs: [loc('WATRLMN', null, m + 5, '3'), loc('CLPHMJW', m + 12, m + 13), loc('RAYNSPK', m + 30, m + 31), loc('WOKING', m + 60, null)] }, today);
  _addRunForTest({ uid: 'F1', headcode: '2H22', toc: 'SW', cat: 'OO', locs: [loc('WATRLMN', null, m + 8, '9'), loc('RAYNSPK', m + 22, m + 23), loc('WOKING', m + 50, null)] }, today);
  _addRunForTest({ uid: 'X1', headcode: '1D33', toc: 'SW', cat: 'XX', locs: [loc('WATRLMN', null, m + 6, '11'), { t: 'RAYNSPK', a: null, d: null, p: m + 18, pub: false, plat: '' }, loc('WOKING', m + 30, null)] }, today);
  // Already left
  _addRunForTest({ uid: 'G1', headcode: '2K09', toc: 'SW', cat: 'OO', locs: [loc('WATRLMN', null, m - 10), loc('RAYNSPK', m + 10, null)] }, today);

  const b = await board('wat', 'RAY');
  assert.equal(b.source, 'timetable');
  assert.equal(b.from.name, 'London Waterloo');
  assert.deepEqual(b.rows.map((r) => r.hc), ['2K11', '2H22'], 'only direct trains still to leave, in departure order');
  const [slow, fast] = b.rows;
  assert.equal(slow.plat, '3');
  assert.equal(slow.platLive, false);
  assert.equal(fast.mins, 14);
  assert.equal(slow.stops, 1, 'one stop in between (Clapham Junction)');
  assert.ok(fast.best && !slow.best, 'the faster train that arrives first is best');
  assert.equal(slow.dest, 'Woking');

  assert.equal((await board('WAT', 'WAT')).error, 'Choose two different stations');
  assert.equal((await board('WAT', 'ZZZ')).error, 'Unknown station');

  const list = JSON.parse(stationList());
  assert.ok(list.find((s) => s.c === 'RAY' && s.n === 'Raynes Park'));
});

test('departures board from National Rail when a key is set', { skip: nearMidnight && 'near midnight' }, async () => {
  const { config } = await import('../src/config.js');
  const hm = (d) => { const q = londonParts(now + d * 60000); return `${String(q.h).padStart(2, '0')}:${String(q.mi).padStart(2, '0')}`; };
  config.ldbKey = 'test-key';
  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    seen = { url, key: opts.headers['x-apikey'] };
    return {
      ok: true,
      json: async () => ({
        trainServices: [
          { std: hm(4), etd: 'On time', platform: '6', operator: 'South Western Railway', operatorCode: 'SW', destination: [{ locationName: 'Woking' }],
            subsequentCallingPoints: [{ callingPoint: [{ crs: 'CLJ', st: hm(11), et: 'On time' }, { crs: 'RAY', st: hm(26), et: 'On time' }] }] },
          { std: hm(7), etd: hm(9), platform: '9', operatorCode: 'SW', destination: [{ locationName: 'Woking' }],
            subsequentCallingPoints: [{ callingPoint: [{ crs: 'RAY', st: hm(19), et: hm(21) }] }] },
          { std: hm(10), etd: 'Cancelled', operatorCode: 'SW', isCancelled: true, destination: [{ locationName: 'Woking' }],
            subsequentCallingPoints: [{ callingPoint: [{ crs: 'RAY', st: hm(20), et: 'Cancelled' }] }] },
        ],
      }),
    };
  };
  try {
    const b = await board('WAT', 'WOK'); // different pair from the first test, so not cached
    assert.equal(b.source, 'national-rail');
    assert.match(seen.url, /GetDepBoardWithDetails\/WAT\?.*filterCrs=WOK/);
    assert.equal(seen.key, 'test-key');
    // calling points don't include WOK in this fake reply, so no arrival times; still listed
    assert.equal(b.rows.length, 3);
    const b2 = await board('WAT', 'CLJ');
    assert.equal(b2.rows[0].sta, hm(11));
    const b3 = await board('CLJ', 'RAY');
    assert.equal(b3.rows[1].etdTime, hm(9));
    assert.ok(b3.rows[1].best, 'delayed fast train still arrives first');
    assert.ok(b3.rows[2].cancelled && !b3.rows[2].best);
    assert.equal(b3.rows[0].plat, '6');
    assert.equal(b3.rows[0].platLive, true);
  } finally {
    global.fetch = realFetch;
    config.ldbKey = '';
  }
});

test('departures board with no destination lists every train leaving', { skip: nearMidnight && 'near midnight' }, async () => {
  const b = await board('WAT', '');
  assert.equal(b.source, 'timetable');
  assert.equal(b.to, null);
  assert.ok(b.rows.length >= 3, `rows ${b.rows.length}`);
  assert.ok(b.rows.every((r) => !r.best && r.mins == null));
  assert.equal(b.rows[0].dest, 'Woking');
});
