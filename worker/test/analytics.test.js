import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingest, usage, dayKey, _reset } from '../src/analytics.js';

test('counts devices and events per day, anonymously', () => {
  _reset();
  const t = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(ingest({ d: 'abc12345', p: 'phone', a: 1, e: [{ n: 'open' }, { n: 'sheet:stn' }, { n: 'search:miss', q: '  Raynes  PARK ' }] }, t).n, 3);
  ingest({ d: 'xyz98765', p: 'desktop', e: [{ n: 'open' }, { n: 'BAD NAME' }, { n: 'error', m: 'Boom happened' }] }, t);
  ingest({ d: 'abc12345', e: [{ n: 'sheet:stn' }] }, t);
  const u = usage(t);
  assert.equal(u.today.day, dayKey(t));
  assert.equal(u.today.devices, 2);
  assert.equal(u.week.devices, 2);
  assert.equal(u.week.newDevices, 2);
  assert.equal(u.week.phone, 1);
  const ev = Object.fromEntries(u.week.events.map((x) => [x.key, x.count]));
  assert.equal(ev.open, 2);
  assert.equal(ev['sheet:stn'], 2);
  assert.equal(ev['BAD NAME'], undefined);
  assert.deepEqual(u.week.misses, [{ key: 'raynes park', count: 1 }]);
  assert.equal(u.week.errors[0].key, 'boom happened');
  assert.equal(u.days.length, 30);
});

test('rejects a batch without a proper device id', () => {
  assert.ok(ingest({ d: 'x', e: [{ n: 'open' }] }).error);
  assert.ok(ingest(null).error);
});
