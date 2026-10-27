import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from '../src/reference.js';
import { addRepeat, removeRepeat, listRepeats, dueRepeats } from '../src/alerts.js';

const sub = { endpoint: 'https://web.push.apple.com/me', keys: { p256dh: 'x', auth: 'y' } };

test('regular trains: picked up about an hour before, on the right days', () => {
  ref.stations.set('WAT', { crs: 'WAT', name: 'London Waterloo', tiplocs: new Set() });
  const r = addRepeat({ sub, crs: 'WAT', std: '16:40', dest: 'Raynes Park', days: 'weekdays' });
  assert.ok(r.id);
  assert.deepEqual(listRepeats(sub.endpoint).map((x) => x.std), ['16:40']);
  // Setting it again replaces it rather than doubling up
  addRepeat({ sub, crs: 'WAT', std: '16:40', dest: 'Raynes Park', days: 'daily' });
  assert.equal(listRepeats(sub.endpoint).length, 1);
  assert.equal(listRepeats(sub.endpoint)[0].days, 'daily');
  const id = listRepeats(sub.endpoint)[0].id;
  removeRepeat(id, sub.endpoint);
  addRepeat({ sub, crs: 'WAT', std: '16:40', dest: 'Raynes Park', days: 'weekdays' });
  // Tue 27 Oct 2026, GMT: 15:30 is 70 min before, 14:00 too early, 16:45 too late
  assert.equal(dueRepeats(Date.parse('2026-10-27T15:30:00Z')).length, 1);
  assert.equal(dueRepeats(Date.parse('2026-10-27T14:00:00Z')).length, 0);
  assert.equal(dueRepeats(Date.parse('2026-10-27T16:45:00Z')).length, 0);
  // Saturday: not for weekday-only
  assert.equal(dueRepeats(Date.parse('2026-10-31T15:30:00Z')).length, 0);
  // Summer time: 16:40 London is 15:40 UTC
  assert.equal(dueRepeats(Date.parse('2026-06-02T14:30:00Z')).length, 1);
  assert.ok(addRepeat({ sub, crs: 'ZZZ', std: '16:40' }).error);
});
