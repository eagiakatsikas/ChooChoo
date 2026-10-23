import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactSequence, addLine, ingestArrivals, placeBus, busSpeed, busesFor, busDetail, routeList, routeShapes, vehicles, lines } from '../src/buses.js';

// A made-up route 93 running east along a straight road, stops every ~700 m
const lon = (i) => -0.22 + i * 0.01;
const stopsOut = [0, 1, 2, 3, 4].map((i) => ({ id: `S${i}`, name: `Stop ${i}`, stopLetter: 'A', lat: 51.42, lon: lon(i) + 0.0002 }));
const line = JSON.stringify([[...Array(41)].map((_, k) => [-0.22 + k * 0.001, 51.42])]);
const seqOut = { lineStrings: [line], stopPointSequences: [{ stopPoint: stopsOut }] };
// Inbound: same road, other way round; TfL's line drawn in the outbound order (we should turn it round)
const seqIn = { lineStrings: [line], stopPointSequences: [{ stopPoint: [...stopsOut].reverse().map((s) => ({ ...s, id: s.id + 'i' })) }] };

test('route shapes: stops placed in order along the line, reversed lines turned round', () => {
  const out = compactSequence(seqOut);
  assert.equal(out.stops.length, 5);
  const along = out.stops.map((s) => s[4]);
  assert.ok(along.every((d, i) => d >= 0 && (i === 0 || d > along[i - 1])), `increasing: ${along}`);
  assert.equal(out.stops[0][1], 'Stop 0 (A)');
  const inb = compactSequence(seqIn);
  assert.ok(inb.pts[0][1] > inb.pts[inb.pts.length - 1][1], 'inbound line runs west');
  assert.ok(inb.stops[4][4] > inb.stops[0][4]);
  addLine('93', '93', { outbound: out, inbound: inb });
  assert.deepEqual(routeList()[0].e, ['Stop 0', 'Stop 4']);
});

test('a bus is placed between its last and next stop, using live speed from predictions', () => {
  const now = Date.parse('2026-10-22T14:00:00Z');
  const pred = (stop, min) => ({ vehicleId: 'LX11AAA', naptanId: stop, lineId: '93', lineName: '93', direction: 'outbound', destinationName: 'Stop 4', expectedArrival: new Date(now + min * 60000).toISOString() });
  // Next stop S2 in 1 minute; then S3 and S4 two minutes apart (~700 m each → ~5.8 m/s)
  ingestArrivals([pred('S2', 1), pred('S3', 3), pred('S4', 5)], ['93'], now);
  const v = vehicles.get('LX11AAA');
  const d = lines.get('93').dirs.outbound;
  const speed = busSpeed(v, d, 0);
  assert.ok(speed > 5 && speed < 6.5, `speed ${speed}`);
  const p = placeBus(v, now);
  assert.equal(p.next[0], 'S2');
  assert.ok(p.lo > lon(1) && p.lo < lon(2), `between stops 1 and 2: ${p.lo}`);
  assert.equal(Math.round(p.la * 100) / 100, 51.42);
  assert.ok(Math.abs(p.h - 90) < 5, `heading east: ${p.h}`);
  // A minute later it's at stop 2
  const p2 = placeBus(v, now + 60000);
  assert.ok(Math.abs(p2.lo - lon(2)) < 0.0005, `at stop 2: ${p2.lo}`);
  // Heavy traffic: the same stops predicted much further apart → slower, so placed further back
  ingestArrivals([pred('S2', 1), pred('S3', 8), pred('S4', 15)], ['93'], now);
  const slow = placeBus(vehicles.get('LX11AAA'), now);
  assert.ok(slow.lo > p.lo, 'in traffic it is closer to the next stop for the same minute away');
});

test('the map gets favourite routes anywhere, and every bus in a zoomed-in view', () => {
  const now = Date.parse('2026-10-22T14:00:00Z');
  const fav = busesFor({ routes: ['93'] }, now);
  assert.equal(fav.buses.length, 1);
  assert.equal(fav.buses[0].n, '93');
  assert.equal(fav.buses[0].nx, 'Stop 2 (A)');
  const view = busesFor({ box: [51.41, -0.215, 51.43, -0.19] }, now);
  assert.equal(view.buses.length, 1, 'route passes through the view');
  const away = busesFor({ box: [51.5, -0.1, 51.52, -0.08] }, now);
  assert.equal(away.buses.length, 0);
  const det = busDetail('LX11AAA', now);
  assert.equal(det.stops[0].done, true);
  assert.equal(det.stops[1].n, 'Stop 2 (A)');
  assert.ok(routeShapes(['93'])['93'].length === 2);
  // Bus no longer in the predictions: it has finished
  ingestArrivals([], ['93'], now);
  assert.equal(vehicles.size, 0);
});

test('bus to the station: routes from near you to near the station', async () => {
  const { busOptions } = await import('../src/buses.js');
  // You're by Stop 0; the station is by Stop 3
  const opts = busOptions(51.4203, -0.2198, { lat: 51.4202, lng: lon(3) + 0.0003 });
  assert.equal(opts.length, 1);
  assert.equal(opts[0].name, '93');
  assert.equal(opts[0].stop[0], 'S0');
  assert.equal(opts[0].off[0], 'S3');
  assert.ok(opts[0].rideMins >= 5 && opts[0].rideMins <= 10, `ride ${opts[0].rideMins}`);
  // Station far from every stop: nothing
  assert.equal(busOptions(51.4203, -0.2198, { lat: 51.6, lng: -0.1 }).length, 0);
});

test('bus fleet: single or double deck and model, by registration', async () => {
  const { deckOf, busFacts } = await import('../src/fleet.js');
  assert.equal(deckOf('LJ09KRO'), 'D');
  assert.equal(deckOf('lj09 kro'), 'D');
  assert.equal(deckOf('NOTABUS'), null);
  const f = busFacts('LJ09KRO');
  assert.equal(f.deck, 'Double decker');
  assert.equal(f.operator, 'Arriva');
  assert.equal(f.fleetNo, 'DW201');
  assert.equal(f.year, 2009);
});

test('bus stops: indexed from the routes, found in a box and near a point', async () => {
  const { stopsIn, stopsNear, stopIndex } = await import('../src/buses.js');
  assert.ok(stopIndex.has('S0'));
  const inBox = stopsIn([51.41, -0.225, 51.43, -0.205]);
  assert.deepEqual(inBox.map((x) => x.i).sort(), ['S0', 'S0i', 'S1', 'S1i']);
  assert.deepEqual(inBox[0].r, ['93']);
  assert.equal(stopsIn([51, -1, 52, 0]).length, 0, 'not when zoomed out');
  const near = stopsNear(51.4203, -0.2198);
  assert.ok(['S0', 'S0i'].includes(near[0].i));
  assert.ok(near[0].d < 50);
});

test('buses you have ridden are shown wherever they are, and found by registration', async () => {
  const { ingestArrivals, busesFor, stopsNamed, vehicles: vs } = await import('../src/buses.js');
  const now = Date.parse('2026-10-22T14:00:00Z');
  const pred = (stop, min) => ({ vehicleId: 'LX99RID', naptanId: stop, lineId: '93', lineName: '93', direction: 'outbound', destinationName: 'Stop 4', expectedArrival: new Date(now + min * 60000).toISOString() });
  ingestArrivals([pred('S2', 1), pred('S3', 3)], [], now, ['LX99RID']);
  // Not a favourite route, nowhere near the view: still shown because you've ridden it
  const r = busesFor({ regs: ['lx99rid'], box: [51.5, -0.1, 51.52, -0.08] }, now);
  assert.equal(r.buses.length, 1);
  assert.equal(r.buses[0].id, 'LX99RID');
  ingestArrivals([], [], now, ['LX99RID']); // off the road now
  assert.ok(!vs.has('LX99RID'));
  assert.deepEqual(stopsNamed('stop 2').map((x) => x.n), ['Stop 2 (A)', 'Stop 2 (A)']);
});
