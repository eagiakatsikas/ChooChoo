// ATOC business codes used in Network Rail schedules → display names.
export const OPERATORS = {
  GW: 'Great Western Railway',
  SW: 'South Western Railway',
  SN: 'Southern',
  GX: 'Gatwick Express',
  TL: 'Thameslink',
  GN: 'Great Northern',
  SE: 'Southeastern',
  LE: 'Greater Anglia',
  CC: 'c2c',
  VT: 'Avanti West Coast',
  LM: 'London Northwestern',
  LO: 'London Overground',
  XR: 'Elizabeth line',
  GR: 'LNER',
  EM: 'East Midlands Railway',
  CH: 'Chiltern Railways',
  HX: 'Heathrow Express',
  HT: 'Hull Trains',
  GC: 'Grand Central',
  LD: 'Lumo',
  CS: 'Caledonian Sleeper',
  XC: 'CrossCountry',
  ES: 'Eurostar',
  ZZ: 'Other',
};

export function operatorName(code) {
  return OPERATORS[code] || code || 'Other';
}
