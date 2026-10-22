// London's bus fleet, by registration: single or double deck, model, fuel, fleet number and
// operator. From TfL's annual bus fleet audit (static/bus-fleet.json, made from the
// spreadsheet TfL publishes). Buses don't change type, so an older list stays mostly right;
// buses newer than the list just show without these details.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'bus-fleet.json');
let fleet = null;
export const fleetInfo = { buses: 0, source: null };

function load() {
  if (fleet) return fleet;
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    fleet = d.buses;
    fleetInfo.buses = Object.keys(fleet).length;
    fleetInfo.source = d.source;
  } catch {
    fleet = {};
  }
  return fleet;
}

/** 'D' (double deck), 'S' (single deck), or null if the bus isn't on the list. */
export function deckOf(reg) {
  const b = load()[String(reg || '').replace(/\s/g, '').toUpperCase()];
  return b ? b[3] || null : null;
}

/** Everything known about one bus, for its panel. */
export function busFacts(reg) {
  const b = load()[String(reg || '').replace(/\s/g, '').toUpperCase()];
  if (!b) return null;
  const [fleetNo, operator, year, deck, type, body, length] = b;
  const nrm = /NRM/i.test(type) || /NRM/i.test(body);
  return {
    fleetNo,
    operator,
    year,
    deck: deck === 'D' ? 'Double decker' : deck === 'S' ? 'Single decker' : null,
    model: nrm ? 'New Routemaster' : body.replace(/\s+NRM$/i, ''),
    power: type.replace(/\s*-\s*NRM$/i, ''),
    length: length || null,
  };
}
