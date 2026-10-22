import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseJourneys } from '../src/getthere.js';

test('getting to the station: TfL journeys summed up, fastest first', () => {
  const out = summariseJourneys({
    journeys: [
      { duration: 24, startDateTime: '2026-10-22T16:30:00', arrivalDateTime: '2026-10-22T16:54:00', legs: [{ duration: 24, mode: { id: 'walking' }, departurePoint: { commonName: 'Here' }, arrivalPoint: { commonName: 'Waterloo' } }] },
      { duration: 11, startDateTime: '2026-10-22T16:30:00', arrivalDateTime: '2026-10-22T16:41:00', legs: [
        { duration: 2, mode: { id: 'walking' } },
        { duration: 6, mode: { id: 'tube' }, routeOptions: [{ name: 'Northern' }], departurePoint: { commonName: 'Leicester Square Underground Station' }, arrivalPoint: { commonName: 'Waterloo Underground Station' }, path: { stopPoints: [{}, {}] } },
        { duration: 3, mode: { id: 'walking' } },
      ] },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].mins, 11);
  assert.equal(out[0].summary, 'Northern line');
  assert.equal(out[0].legs[1].from, 'Leicester Square Underground Station');
  assert.ok(out[1].walkOnly);
});
