import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedState, feedHealthy, watchdog } from '../src/feeds.js';
import { stats } from '../src/trains.js';

test('feed watchdog: healthy stays put; stuck for 5+ minutes starts a fresh connection', () => {
  const t = Date.parse('2026-10-30T07:20:00Z');
  feedState.connected = true;
  feedState.since = t - 3600000;
  stats.lastMsg = t - 10000;
  assert.equal(feedHealthy(t), true);
  assert.equal(watchdog(t, () => assert.fail('should not restart')), false);
  // Messages stop (as on 30 Oct): quiet for 6 minutes, then the error arrives and it stays down
  stats.lastMsg = t;
  feedState.connected = false;
  feedState.lastError = 'AMQ339009 Exception getting session';
  const no = () => assert.fail('too soon to restart');
  assert.equal(watchdog(t + 6 * 60000, no), false, 'first notices the trouble');
  assert.equal(watchdog(t + 9 * 60000, no), false, 'gives ordinary reconnects a chance');
  let started = 0;
  const before = feedState.restarts;
  assert.equal(watchdog(t + 12 * 60000, () => started++), true);
  assert.equal(started, 1, 'starts again from scratch');
  assert.equal(feedState.restarts, before + 1);
  assert.equal(watchdog(t + 13 * 60000, () => started++), false, 'and gives the new connection time');
  // Back to normal once messages flow again
  feedState.connected = true;
  stats.lastMsg = t + 14 * 60000;
  assert.equal(watchdog(t + 14 * 60000, () => started++), false);
  assert.equal(started, 1);
});
