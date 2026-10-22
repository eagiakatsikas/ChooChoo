import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from '../src/reference.js';
import { _addRunForTest } from '../src/schedule.js';
import { trains } from '../src/trains.js';
import { watchPairs, checkHistory, historyFor } from '../src/history.js';
import { londonDateStr, londonParts } from '../src/time.js';

test('reliability: arrivals on a saved route are recorded and summed up', { skip: (() => { const p = londonParts(Date.now()); const m = p.h * 60 + p.mi; return m < 120 && 'early morning'; })() }, () => {
  const now = Date.now();
  const p = londonParts(now);
  const m = p.h * 60 + p.mi;
  for (const [crs, name, t] of [['RAY', 'Raynes Park', 'RAYNSPK'], ['WAT', 'London Waterloo', 'WATRLMN']]) {
    ref.stations.set(crs, { crs, name, lat: 51.4, lng: -0.2, tiplocs: new Set([t]) });
  }
  const loc = (t, a, d) => ({ t, a, d, p: null, pub: true, plat: '' });
  const day = londonDateStr(now);
  _addRunForTest({ uid: 'H1', headcode: '2K01', toc: 'SW', cat: 'OO', locs: [loc('RAYNSPK', null, m - 40), loc('WATRLMN', m - 20, null)] }, day);
  _addRunForTest({ uid: 'H2', headcode: '2K02', toc: 'SW', cat: 'OO', locs: [loc('RAYNSPK', null, m - 30), loc('WATRLMN', m - 10, null)] }, day);
  trains.set(`H1|${day}`, { idx: 1, delay: 1 });
  trains.set(`H2|${day}`, { idx: 1, delay: 7 });
  watchPairs([{ f: 'RAY', t: 'WAT' }], now);
  checkHistory(now);
  const h = historyFor('RAY', 'WAT', now);
  assert.equal(h.week.trains, 2);
  assert.equal(h.week.onTime, 1);
  assert.equal(h.week.late, 1);
  assert.equal(h.week.avgLate, 7);
  assert.equal(h.times.length, 2);
});
