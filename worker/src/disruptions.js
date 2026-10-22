// Disruptions: line status for National Rail operators and TfL's rail lines, from TfL's
// open data (it carries National Rail's operator-level status too). Refreshed every 2 min.
import { config } from './config.js';

const MODES = 'national-rail,elizabeth-line,overground,dlr,tube';
const EVERY_MS = 2 * 60000;
export const disruptions = { at: null, lines: [], error: null };

export function summarise(list) {
  const out = [];
  for (const l of Array.isArray(list) ? list : []) {
    for (const s of l.lineStatuses || []) {
      if (s.statusSeverity === 10) continue; // Good Service
      out.push({
        id: l.id,
        name: l.name,
        mode: l.modeName,
        severity: s.statusSeverityDescription || 'Disruption',
        level: s.statusSeverity, // lower is worse
        reason: (s.reason || '').replace(/\s+/g, ' ').trim(),
      });
    }
  }
  // Worst first; one entry per line (TfL can list several statuses)
  out.sort((a, b) => a.level - b.level);
  const seen = new Set();
  return out.filter((x) => (seen.has(x.id) ? false : seen.add(x.id)));
}

async function poll() {
  try {
    const res = await fetch(`${config.tflUrl}/Line/Mode/${MODES}/Status?app_key=${encodeURIComponent(config.tflKey)}`);
    if (!res.ok) throw new Error(`TfL status: HTTP ${res.status}`);
    disruptions.lines = summarise(await res.json());
    disruptions.at = Date.now();
    disruptions.error = null;
  } catch (err) {
    disruptions.error = err.message;
  }
}

export function startDisruptions() {
  if (!config.tflKey) {
    disruptions.error = 'Needs the TfL key';
    return;
  }
  poll();
  setInterval(poll, EVERY_MS);
}
