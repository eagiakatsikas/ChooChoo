import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

/**
 * Download url to dataDir/name. Uses basic auth for Network Rail URLs.
 * Keeps the previous copy if the download fails. Returns the local path (or null).
 */
export async function download(url, name, { auth = false, maxAgeHours = 20 } = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dest = path.join(config.dataDir, name);
  if (fs.existsSync(dest)) {
    const ageH = (Date.now() - fs.statSync(dest).mtimeMs) / 3600000;
    if (ageH < maxAgeHours) return dest;
  }
  const headers = {};
  if (auth) {
    headers.Authorization =
      'Basic ' + Buffer.from(`${config.nrUser}:${config.nrPass}`).toString('base64');
  }
  try {
    console.log(`[download] ${name} …`);
    const res = await fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tmp = dest + '.part';
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    console.log(`[download] ${name} done (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
    return dest;
  } catch (err) {
    console.error(`[download] ${name} failed: ${err.message}`);
    return fs.existsSync(dest) ? dest : null;
  }
}

/** Readable stream of the file's text, gunzipping if it is gzip-compressed. */
export function openText(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(2);
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  const raw = fs.createReadStream(file);
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  return gz ? raw.pipe(zlib.createGunzip()) : raw;
}

export function lines(file) {
  return readline.createInterface({ input: openText(file), crlfDelay: Infinity });
}

export async function readAll(file) {
  const chunks = [];
  for await (const c of openText(file)) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
