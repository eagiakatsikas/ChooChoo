import { config, hasCredentials } from './config.js';
import { download } from './download.js';
import { loadNaptan, loadSmart } from './reference.js';
import { loadSchedule } from './schedule.js';
import { startFeeds } from './feeds.js';
import { startServer } from './server.js';
import { londonParts } from './time.js';

async function loadReference({ fresh = false } = {}) {
  const naptan = await download(config.naptanUrl, 'naptan-rail.csv', { maxAgeHours: fresh ? 0 : 24 * 7 });
  if (!naptan) throw new Error('Could not download station locations (NaPTAN).');
  await loadNaptan(naptan);

  const smart = await download(config.smartUrl, 'smart.json.gz', { auth: true, maxAgeHours: fresh ? 0 : 24 * 7 });
  if (smart) await loadSmart(smart);
  else console.warn('[ref] SMART unavailable — positions will come from TRUST only (less frequent).');

  await refreshSchedule(fresh);
}

async function refreshSchedule(fresh = true) {
  const file = await download(config.scheduleUrl, 'schedule.json.gz', { auth: true, maxAgeHours: fresh ? 0 : 12 });
  if (!file) throw new Error('Could not download the daily schedule.');
  await loadSchedule(file);
}

function scheduleDailyReload() {
  const [h, m] = config.scheduleReloadAt.split(':').map(Number);
  let lastDay = null;
  setInterval(async () => {
    const p = londonParts(Date.now());
    const day = `${p.y}-${p.m}-${p.d}`;
    if (p.h === h && p.mi >= m && lastDay !== day) {
      lastDay = day;
      try {
        await refreshSchedule(true);
      } catch (err) {
        console.error('[schedule] daily reload failed:', err.message);
      }
    }
  }, 60000);
}

async function main() {
  if (!hasCredentials()) {
    console.error('Set NR_USERNAME and NR_PASSWORD (your Network Rail Open Data login). See README.');
    process.exit(1);
  }
  startServer(); // start answering health checks straight away
  await loadReference();
  startFeeds();
  scheduleDailyReload();
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
