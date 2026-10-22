// Helpers for UK local time. Rail schedules are in London wall-clock time.
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const pad = (n) => String(n).padStart(2, '0');

export function londonParts(ms) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

export function londonDateStr(ms) {
  const p = londonParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Offset of London local time from UTC at instant ms (0 in winter, 3600000 in summer). */
export function londonOffsetMs(ms) {
  const p = londonParts(ms);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms for London wall-clock `minutes` after midnight on dateStr (minutes may exceed 1440). */
export function londonEpoch(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + Math.round(minutes * 60000);
  const off = londonOffsetMs(guess);
  let t = guess - off;
  const off2 = londonOffsetMs(t);
  if (off2 !== off) t = guess - off2;
  return t;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday = 0 … Sunday = 6 (matches CIF schedule_days_runs). */
export function weekdayIndex(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** "0712", "0712H" (CIF) or "071230" (VSTP) → minutes after midnight. */
export function parseCifTime(s) {
  if (!s) return null;
  s = String(s).trim();
  if (s.length < 4) return null;
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  let extra = 0;
  if (s[4] === 'H') extra = 0.5;
  else if (s.length >= 6) extra = Number(s.slice(4, 6)) / 60 || 0;
  return h * 60 + m + extra;
}

/**
 * Some feed timestamps are UK local time written as if they were UTC.
 * Live events happen "now", so if removing the BST offset brings the timestamp
 * closer to the current time, assume it was local.
 */
export function normaliseLiveTs(ts, now = Date.now()) {
  ts = Number(ts);
  if (!ts) return now;
  const off = londonOffsetMs(now);
  if (off && Math.abs(ts - off - now) < Math.abs(ts - now)) return ts - off;
  return ts;
}

export function hhmm(ms) {
  const p = londonParts(ms);
  return `${pad(p.h)}:${pad(p.mi)}`;
}
