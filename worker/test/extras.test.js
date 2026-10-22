import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise } from '../src/disruptions.js';
import { record, frameAt, placeView } from '../src/replay.js';

test('disruptions: only lines without good service, worst first, one each', () => {
  const out = summarise([
    { id: 'south-western-railway', name: 'South Western Railway', modeName: 'national-rail', lineStatuses: [{ statusSeverity: 9, statusSeverityDescription: 'Minor Delays', reason: 'Signal failure at  Wimbledon' }, { statusSeverity: 9 }] },
    { id: 'c2c', name: 'c2c', modeName: 'national-rail', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] },
    { id: 'elizabeth', name: 'Elizabeth line', modeName: 'elizabeth-line', lineStatuses: [{ statusSeverity: 6, statusSeverityDescription: 'Severe Delays' }] },
  ]);
  assert.deepEqual(out.map((x) => x.id), ['elizabeth', 'south-western-railway']);
  assert.equal(out[1].reason, 'Signal failure at Wimbledon');
});

test('replay: frames recorded and the nearest one returned', () => {
  const t0 = Date.parse('2026-10-22T14:00:00Z');
  const mk = (lat) => new Map([['a', { id: 'a', st: 'at', p: [lat, -0.1], dl: 2, toc: 'SW', hc: '2K11', d: 'Woking' }]]);
  record(mk(51.5), t0);
  record(mk(51.4), t0 + 10000); // too soon: skipped
  record(mk(51.3), t0 + 31000);
  const f = frameAt(t0 + 25000);
  assert.equal(f.frame.trains[0][1], 51.3);
  assert.equal(frameAt(t0).frame.trains[0][1], 51.5);
  // A moving train is placed part way along
  const p = placeView({ st: 'mv', seg: [51, 0, 52, 0, 0, 1000] }, 500);
  assert.ok(Math.abs(p[0] - 51.5) < 1e-9);
});
