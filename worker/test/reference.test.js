import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref, addTiploc, finaliseTiplocs } from '../src/reference.js';

test('a station NaPTAN lists under a TIPLOC without a CRS code is still a station', () => {
  // NaPTAN has the location under WATRLOO (no CRS in the timetable); the timetable's
  // WATRLMN has the CRS code WAT and shares the STANOX.
  ref.coords.set('WATRLOO', { lat: 51.503, lng: -0.113, name: 'London Waterloo' });
  ref.coords.set('WATRLOE', { lat: 51.504, lng: -0.109, name: 'London Waterloo East' });
  addTiploc({ tiploc_code: 'WATRLOO', stanox: '87219', tps_description: 'LONDON WATERLOO' });
  addTiploc({ tiploc_code: 'WATRLMN', stanox: '87219', crs_code: 'WAT', tps_description: 'LONDON WATERLOO' });
  addTiploc({ tiploc_code: 'WATRLOE', stanox: '87100', crs_code: 'WAE', tps_description: 'LONDON WATERLOO EAST' });
  // A terminus with no location at all falls back to the built-in one
  addTiploc({ tiploc_code: 'VICTRIC', stanox: '87001', crs_code: 'VIC', tps_description: 'LONDON VICTORIA' });
  finaliseTiplocs();
  const wat = ref.stations.get('WAT');
  assert.ok(wat, 'Waterloo is a station');
  assert.equal(wat.name, 'London Waterloo');
  assert.ok(wat.tiplocs.has('WATRLMN'));
  assert.equal(ref.stations.get('WAE').name, 'London Waterloo East');
  assert.equal(ref.stations.get('VIC').name, 'London Victoria');
  assert.ok(ref.coords.has('VICTRIC'));
});
