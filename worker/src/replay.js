// Replay: where every train was over the last hour, kept in memory as a frame every 30 s.
import { getPaths } from './tracks.js';

const EVERY_MS = 30000;
const KEEP_MS = 60 * 60000;
const frames = []; // [{ t, trains: [[id, lat, lng, delay, toc, headcode, dest]] }]
let lastAt = 0;

const r5 = (x) => Math.round(x * 1e5) / 1e5;

function along(pts, f) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    cum.push(cum[i - 1] + Math.hypot((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]));
  }
  const d = f * cum[cum.length - 1];
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const u = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
}

/** Where a train view puts the train at time now (as the map would draw it). */
export function placeView(v, now) {
  if (v.st === 'mv' && v.seg) {
    const [la0, ln0, la1, ln1, t0, t1] = v.seg;
    const f = Math.max(0, Math.min(0.97, t1 > t0 ? (now - t0) / (t1 - t0) : 1));
    const p = v.pk && getPaths([v.pk])[v.pk];
    if (p && p.length > 1) return along(p, v.rv ? 1 - f : f);
    return [la0 + (la1 - la0) * f, ln0 + (ln1 - ln0) * f];
  }
  return v.p || null;
}

export function record(views, now = Date.now()) {
  if (now - lastAt < EVERY_MS) return;
  lastAt = now;
  const list = [];
  for (const v of views.values()) {
    if (v.st === 'end') continue;
    const p = placeView(v, now);
    if (p) list.push([v.id, r5(p[0]), r5(p[1]), v.dl ?? 0, v.toc, v.hc, v.d]);
  }
  frames.push({ t: now, trains: list });
  while (frames.length && now - frames[0].t > KEEP_MS) frames.shift();
}

/** The recorded frame nearest to time t, plus the range available. */
export function frameAt(t) {
  if (!frames.length) return { from: null, to: null, frame: null };
  let best = frames[0];
  for (const f of frames) if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return { from: frames[0].t, to: frames[frames.length - 1].t, frame: best };
}

export const replayInfo = () => ({ frames: frames.length, from: frames[0]?.t || null });
