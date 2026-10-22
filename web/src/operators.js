// ATOC code → name and lamp colour on the map
export const OPERATORS = {
  SW: ['South Western Railway', '#4ea8ff'],
  SN: ['Southern', '#9bdc4a'],
  GX: ['Gatwick Express', '#ff6b6b'],
  TL: ['Thameslink', '#ff5fb8'],
  GN: ['Great Northern', '#8f9bff'],
  SE: ['Southeastern', '#34d6e0'],
  GW: ['Great Western Railway', '#2fcf8a'],
  HX: ['Heathrow Express', '#b07cff'],
  XR: ['Elizabeth line', '#c39bff'],
  LO: ['London Overground', '#ff9a3c'],
  LE: ['Greater Anglia', '#ff4d4d'],
  CC: ['c2c', '#f06fff'],
  VT: ['Avanti West Coast', '#1fc7b0'],
  LM: ['London Northwestern', '#d4e157'],
  GR: ['LNER', '#ffd166'],
  EM: ['East Midlands Railway', '#d9a3ff'],
  CH: ['Chiltern Railways', '#7ad3ff'],
  HT: ['Hull Trains', '#5ee0f0'],
  GC: ['Grand Central', '#ffb347'],
  LD: ['Lumo', '#62c6ff'],
  CS: ['Caledonian Sleeper', '#4fb3a0'],
  XC: ['CrossCountry', '#e0679a'],
  ES: ['Eurostar', '#ffe45c'],
};

export function opName(code) {
  return OPERATORS[code]?.[0] || 'Other';
}
export function opColour(code) {
  return OPERATORS[code]?.[1] || '#b9c4cc';
}

// Terminus palette: glass = on time, gilt = late, brick = very late
export function delayColour(dl) {
  if (dl >= 15) return '#e07f63';
  if (dl >= 1) return '#d4a64a';
  return '#a9d6cf';
}
