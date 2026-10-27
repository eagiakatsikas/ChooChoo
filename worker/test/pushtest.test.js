import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAlerts, testPush } from '../src/alerts.js';

test('a test notification that can’t be sent says why, instead of failing silently', async () => {
  startAlerts({ check: false });
  assert.equal((await testPush(null)).ok, false);
  const r = await testPush({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'bad', auth: 'bad' } });
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
  assert.equal(r.service, 'web.push.apple.com');
});
