import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, snap, route, simplify, pathFor, processQueue, getPaths, pathPoints, stationPoint, _setReadyForTest } from '../src/tracks.js';

// A made-up network around central London:
//  - a main line that curves south (like Waterloo → Vauxhall → Clapham)
//  - a branch off it at a junction
//  - an unconnected line nearby (must never be used)
const A = [51.5031, -0.1132]; // "Waterloo"
const B = [51.4643, -0.1704]; // "Clapham"
function curve(from, via, to, n = 40) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const la = (1 - t) ** 2 * from[0] + 2 * (1 - t) * t * via[0] + t * t * to[0];
    const lo = (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * via[1] + t * t * to[1];
    out.push(la, lo);
  }
  return out;
}
const main = curve(A, [51.47, -0.11], B); // bows east, well off the straight line
const junction = [main[40], main[41]]; // point 20 of the curve
const branch = [junction[0], junction[1], 51.45, -0.10, 51.44, -0.09];
const separate = [51.49, -0.16, 51.48, -0.15];

test('track routing follows the rails, not a straight line', () => {
  const n = buildGraph([main, branch, separate]);
  assert.ok(n > 40);
  _setReadyForTest(true);

  // Snapping finds the track end at each station
  const sa = snap(A[0], A[1]);
  const sb = snap(B[0], B[1]);
  assert.ok(sa >= 0 && sb >= 0);
  assert.equal(snap(52.5, -2, 400), -1, 'nothing to snap to far away');

  const r = route(sa, sb);
  assert.ok(r && r.length >= 40, 'route goes along the curve');

  // Through the station-pair API: first call queues, background work computes it
  const ca = { lat: A[0], lng: A[1] };
  const cb = { lat: B[0], lng: B[1] };
  assert.equal(pathFor('WATRLMN', ca, 'CLPHMJN', cb), null);
  processQueue(1000);
  const fwd = pathFor('WATRLMN', ca, 'CLPHMJN', cb);
  const back = pathFor('CLPHMJN', cb, 'WATRLMN', ca);
  assert.deepEqual(fwd, { key: 'CLPHMJN|WATRLMN', rev: true }, 'keys are order-independent');
  assert.deepEqual(back, { key: 'CLPHMJN|WATRLMN', rev: false });

  const pts = pathPoints('WATRLMN', ca, 'CLPHMJN', cb);
  assert.ok(pts.length > 3, 'kept the shape of the curve');
  // Starts at Waterloo end, finishes at Clapham end
  assert.ok(Math.abs(pts[0][0] - A[0]) < 1e-3 && Math.abs(pts.at(-1)[0] - B[0]) < 1e-3);
  // The middle of the route is far east of the straight line (which is at about -0.142)
  const mid = pts[Math.floor(pts.length / 2)];
  assert.ok(mid[1] > -0.13, `route bows east (mid lng ${mid[1]})`);

  const served = getPaths(['CLPHMJN|WATRLMN', 'NOPE|NOPE']);
  assert.deepEqual(Object.keys(served), ['CLPHMJN|WATRLMN']);

  // Stations snap onto the track
  const sp = stationPoint('WATRLMN', { lat: A[0] + 0.0005, lng: A[1] });
  assert.ok(Math.abs(sp.lat - A[0]) < 1e-5);
});

test('no route over unconnected track; outside the area stays straight', () => {
  const cs = { lat: 51.49, lng: -0.16 };
  const cb = { lat: B[0], lng: B[1] };
  pathFor('SEPARAT', cs, 'CLPHMJN', cb);
  processQueue(1000);
  assert.equal(pathFor('SEPARAT', cs, 'CLPHMJN', cb), null, 'unconnected line gives no route');
  assert.equal(pathFor('READING', { lat: 51.4588, lng: -0.9719 }, 'DIDCOTP', { lat: 51.611, lng: -1.2427 }), null);
});

test('simplify keeps corners and drops straight-line points', () => {
  const pts = [
    [51.5, -0.1],
    [51.5, -0.099],
    [51.5, -0.098],
    [51.501, -0.098],
  ];
  assert.deepEqual(simplify(pts), [pts[0], pts[2], pts[3]]);
});
