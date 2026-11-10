import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from '../src/reference.js';
import { sched, _addRunForTest } from '../src/schedule.js';
import { plan } from '../src/trains.js';
import { londonDateStr, londonParts } from '../src/time.js';

const now = Date.now();
const p = londonParts(now);
const m = p.h * 60 + p.mi;
const nearMidnight = m < 90 || m > 1250;

test('a train that hasn’t started yet can still be described (for shared links)', { skip: nearMidnight && 'near midnight' }, () => {
  for (const [t, name] of [['WATRLMN', 'London Waterloo'], ['CLPHMJW', 'Clapham Junction'], ['RAYNSPK', 'Raynes Park']]) ref.coords.set(t, { lat: 51.5, lng: -0.1, name });
  const loc = (t, a, d) => ({ t, a, d, p: null, pub: true, plat: '' });
  _addRunForTest({ uid: 'P1', headcode: '2D46', toc: 'SW', cat: 'OO', locs: [loc('WATRLMN', null, m + 60), loc('CLPHMJW', m + 67, m + 68), loc('RAYNSPK', m + 80, null)] }, londonDateStr(now));
  const key = [...sched.runs.keys()].find((k) => sched.runs.get(k).uid === 'P1');
  const d = plan(key, now);
  assert.equal(d.d, 'Raynes Park');
  assert.equal(d.o, 'London Waterloo');
  assert.equal(d.running, false);
  assert.equal(d.done, false);
  assert.equal(d.stops.length, 3);
  assert.ok(d.depAt > now);
  assert.equal(plan('nope'), null);
  // Long after it's arrived: done
  assert.equal(plan(key, now + 4 * 3600000).done, true);
});
