// Getting to the station: door-to-station routes from where you are, using TfL's journey
// planner (Tube, Overground, Elizabeth line, DLR, bus and walking, with live running).
// Home uses it to say when to leave and which train you can actually make.
import { config } from './config.js';
import { tfl } from './buses.js';

const MODES = 'tube,overground,elizabeth-line,dlr,bus,walking';
const CACHE_MS = 60000;
const cache = new Map(); // "lat,lng|crs" → { at, data }

const modeName = { tube: 'Underground', overground: 'Overground', 'elizabeth-line': 'Elizabeth line', dlr: 'DLR', bus: 'Bus', walking: 'Walk' };

/** TfL's journey reply → a few compact options, fastest first. Exported for tests. */
export function summariseJourneys(d) {
  const out = [];
  for (const j of (d && d.journeys) || []) {
    const legs = (j.legs || []).map((l) => {
      const mode = l.mode?.id || 'walking';
      const line = l.routeOptions?.[0]?.name || '';
      return {
        mode,
        line: mode === 'walking' ? '' : line,
        name: mode === 'bus' && line ? `Bus ${line}` : mode === 'tube' && line ? `${line} line` : modeName[mode] || mode,
        from: l.departurePoint?.commonName || '',
        to: l.arrivalPoint?.commonName || '',
        mins: l.duration || 0,
        stops: Array.isArray(l.path?.stopPoints) ? Math.max(0, l.path.stopPoints.length) : null,
        disrupted: Boolean(l.isDisrupted),
      };
    });
    const ride = legs.filter((l) => l.mode !== 'walking');
    out.push({
      mins: j.duration, // door to station, in minutes
      legs,
      walkOnly: ride.length === 0,
      summary: ride.length ? ride.map((l) => l.name).join(', then ') : 'Walk',
    });
  }
  out.sort((a, b) => a.mins - b.mins);
  // Drop near-duplicates (same summary)
  const seen = new Set();
  return out.filter((o) => (seen.has(o.summary) ? false : seen.add(o.summary))).slice(0, 3);
}

export async function getThere(la, lo, st) {
  if (!config.tflKey) return { options: [], ready: false };
  const k = `${la.toFixed(3)},${lo.toFixed(3)}|${st.crs}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const from = `${la.toFixed(5)},${lo.toFixed(5)}`;
  const to = `${st.lat.toFixed(5)},${st.lng.toFixed(5)}`;
  const d = await tfl(`/Journey/JourneyResults/${from}/to/${to}?mode=${MODES}&timeIs=Departing&journeyPreference=leasttime&walkingSpeed=average`);
  const data = { options: summariseJourneys(d), ready: true, at: Date.now() };
  cache.set(k, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}
