import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changes } from '../src/alerts.js';

const w = (last) => ({ label: '15:55 from Waterloo to Chessington South', last });

test('alerts: platform announced, then changed', () => {
  let m = changes(w({ plat: null, delay: null }), { plat: '5', platLive: true, delay: 0, expected: Date.now() });
  assert.equal(m.length, 1);
  assert.equal(m[0].title, 'Platform 5');
  m = changes(w({ plat: '5', delay: 0 }), { plat: '7', platLive: true, delay: 0, expected: Date.now() });
  assert.equal(m[0].title, 'Platform change: 7');
  assert.match(m[0].body, /was 5/);
  // Planned platform only: no alert
  assert.equal(changes(w({ plat: null, delay: null }), { plat: '5', platLive: false, delay: 0 }).length, 0);
});

test('alerts: running late, later still, back on time, cancelled', () => {
  const t = Date.parse('2026-10-22T15:00:00Z');
  let m = changes(w({ plat: null, delay: 0 }), { delay: 6, expected: t });
  assert.equal(m[0].title, '6 min late');
  assert.equal(changes(w({ plat: null, delay: 6 }), { delay: 7, expected: t }).length, 0, 'small changes stay quiet');
  assert.equal(changes(w({ plat: null, delay: 6 }), { delay: 10, expected: t })[0].title, '10 min late');
  assert.equal(changes(w({ plat: null, delay: 10 }), { delay: 0, expected: t })[0].title, 'Back on time');
  assert.equal(changes(w({ plat: '5', delay: 0 }), { cancelled: true })[0].title, 'Cancelled');
});

test('commute windows: weekday mornings and late afternoons, London time', async () => {
  const { commuteWindow } = await import('../src/alerts.js');
  assert.equal(commuteWindow(Date.parse('2026-10-22T07:30:00Z')).from, 'home'); // Thu 08:30 BST
  assert.equal(commuteWindow(Date.parse('2026-10-22T16:00:00Z')).from, 'work'); // Thu 17:00 BST
  assert.equal(commuteWindow(Date.parse('2026-10-22T11:00:00Z')), null); // midday
  assert.equal(commuteWindow(Date.parse('2026-10-24T07:30:00Z')), null); // Saturday
});
