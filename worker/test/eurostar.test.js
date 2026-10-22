import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8 } from 'fflate';
import GtfsRealtime from 'gtfs-realtime-bindings';
import { loadGtfs, ingestRealtime, euroViews, euroDetail, serviceEpoch } from '../src/eurostar.js';

const { transit_realtime: rt } = GtfsRealtime;

test('GTFS times are counted in the agency time zone', () => {
  // 10:00 in Paris on 22 Oct 2026 (summer time ends 25 Oct) = 08:00 UTC
  assert.equal(new Date(serviceEpoch('20261022', 10 * 3600, 'Europe/Paris')).toISOString(), '2026-10-22T08:00:00.000Z');
});

test('Eurostar: placed between Lille and Paris from timetable plus live delay; hidden on the UK side', () => {
  const now = Date.parse('2026-10-22T10:00:00Z'); // 12:00 in Paris
  const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  const files = {
    'agency.txt': strToU8('agency_id,agency_name,agency_url,agency_timezone\nES,Eurostar,https://eurostar.com,Europe/Paris\n'),
    'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nSTP,London St Pancras International,51.531,-0.126\nLIL,Lille Europe,50.639,3.075\nPNO,Paris Nord,48.880,2.355\n'),
    'calendar_dates.txt': strToU8('service_id,date,exception_type\nS1,20261022,1\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,trip_headsign,trip_short_name\nR1,S1,T9014,Paris Nord,9014\nR1,S1,T9010,Paris Nord,9010\n'),
    'stop_times.txt': strToU8(
      [
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
        // 9014: London 10:01 (UK time = 11:01 Paris), Lille 12:20/12:23... we want it between Lille and Paris at 12:00 Paris → Lille dep 11:30
        `T9014,${hm(11, 1)},${hm(11, 1)},STP,1`,
        `T9014,${hm(11, 28)},${hm(11, 30)},LIL,2`,
        `T9014,${hm(12, 30)},${hm(12, 30)},PNO,3`,
        // 9010 has only just left London: still on the UK side
        `T9010,${hm(11, 50)},${hm(11, 55)},STP,1`,
        `T9010,${hm(13, 20)},${hm(13, 22)},LIL,2`,
        `T9010,${hm(14, 20)},${hm(14, 20)},PNO,3`,
      ].join('\n') + '\n',
    ),
  };
  const r = loadGtfs(files, now);
  assert.equal(r.trips, 2);
  let v = euroViews(now);
  assert.equal(v.length, 1);
  assert.equal(v[0].hc, '9014');
  assert.equal(v[0].st, 'mv');
  assert.equal(v[0].at, 'Lille Europe');
  assert.equal(v[0].nx, 'Paris Nord');
  assert.equal(v[0].dl, 0);
  // Live feed says 9014 is 10 minutes late leaving Lille
  const feed = rt.FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(now / 1000) },
    entity: [{ id: '1', tripUpdate: { trip: { tripId: 'T9014', startDate: '20261022' }, stopTimeUpdate: [{ stopId: 'LIL', departure: { delay: 600 } }] } }],
  });
  ingestRealtime(rt.FeedMessage.decode(rt.FeedMessage.encode(feed).finish()));
  v = euroViews(now);
  assert.equal(v[0].dl, 10);
  assert.equal(v[0].nxt, '11:40', 'Paris arrival 12:40 Paris time = 11:40 London');
  const d = euroDetail(v[0].id, now);
  assert.equal(d.stops.length, 3);
  assert.equal(d.stops[2].e, '11:40');
  assert.ok(d.stops[0].done);
});
