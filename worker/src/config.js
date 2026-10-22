// All configuration comes from environment variables.
const env = process.env;

function bbox(str) {
  // "south,west,north,east"
  const [s, w, n, e] = str.split(',').map(Number);
  return { s, w, n, e };
}

export const config = {
  port: Number(env.PORT || 8080),

  // Network Rail Open Data credentials (email + password used to sign in)
  nrUser: env.NR_USERNAME || '',
  nrPass: env.NR_PASSWORD || '',
  // Must be unique per running instance (durable subscriptions are tied to it)
  nrClientId: env.NR_CLIENT_ID || '',
  stompHost: env.NR_STOMP_HOST || 'publicdatafeeds.networkrail.co.uk',
  stompPort: Number(env.NR_STOMP_PORT || 61618),

  scheduleUrl:
    env.NR_SCHEDULE_URL ||
    'https://publicdatafeeds.networkrail.co.uk/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full',
  smartUrl:
    env.NR_SMART_URL ||
    'https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=SMART',
  // NaPTAN rail stops (ATCO area 910 = National Rail). Gives station lat/long by TIPLOC.
  naptanUrl:
    env.NAPTAN_URL || 'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv&atcoAreaCodes=910',

  // Trains are included if any calling/passing point falls inside this box.
  // Default ≈ Greater London.
  londonBox: bbox(env.LONDON_BBOX || '51.28,-0.52,51.70,0.34'),

  // Area where trains follow real track geometry (OpenStreetMap). Outside it they
  // move in straight lines between stations. south,west,north,east
  // Default: the London commuter belt — Brighton to Milton Keynes/Cambridge, Basingstoke/Reading to
  // Southend/Ashford — plus High Speed 1 all the way to the Channel Tunnel (for Eurostar).
  trackBox: bbox(env.TRACK_BBOX || '50.78,-1.18,52.26,1.25'),
  // Eurostar beyond the Channel Tunnel: the high-speed lines to Paris, Brussels and Amsterdam
  // (hs: high-speed lines only), plus every line in a few small areas: the tunnel itself and
  // the approaches to the big stations, where trains leave the high-speed line.
  euroBoxes:
    env.EURO_TRACKS === 'off'
      ? []
      : [
          { s: 48.8, w: 1.5, n: 52.45, e: 5.2, hs: true },
          { s: 50.9, w: 1.1, n: 51.12, e: 1.95 }, // Channel Tunnel, Folkestone to Calais-Fréthun
          { s: 48.86, w: 2.33, n: 48.97, e: 2.5 }, // Paris Nord
          { s: 50.6, w: 3.03, n: 50.66, e: 3.11 }, // Lille
          { s: 50.76, w: 4.26, n: 50.87, e: 4.42 }, // Brussels Midi
          { s: 50.84, w: 4.33, n: 51.25, e: 4.48 }, // Brussels to Antwerp
          { s: 51.88, w: 4.4, n: 51.95, e: 4.52 }, // Rotterdam
          { s: 52.28, w: 4.7, n: 52.4, e: 4.92 }, // Schiphol to Amsterdam
        ],
  overpassUrls: (env.OVERPASS_URLS ||
    'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter').split(','),

  // National Rail Live Departure Boards (Rail Data Marketplace). Optional: without a key the
  // train finder uses the timetable plus live running data, with planned platforms only.
  ldbKey: env.LDB_API_KEY || '',
  ldbUrl: (env.LDB_URL || 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120').replace(/\/$/, ''),

  // TfL Unified API (Ding Ding buses). Free key from api-portal.tfl.gov.uk
  tflKey: env.TFL_APP_KEY || '',
  tflUrl: (env.TFL_URL || 'https://api.tfl.gov.uk').replace(/\/$/, ''),

  // Eurostar's open data (France's national portal): timetable (GTFS) and live delays.
  // Set EUROSTAR_GTFS_URL to empty to turn Eurostar-in-Europe off.
  eurostarGtfsUrl: env.EUROSTAR_GTFS_URL ?? 'https://www.data.gouv.fr/api/1/datasets/r/bfd97acd-63f3-4ea4-bfe8-70e4c7fd8d13',
  eurostarRtUrl: env.EUROSTAR_RT_URL || 'https://www.data.gouv.fr/api/1/datasets/r/9c3a3d5c-a52c-451e-89c8-32822af20bee',

  // Where downloaded reference files are cached
  dataDir: env.DATA_DIR || './data',

  // CORS: the URL of your Vercel site, or * to allow any
  allowedOrigin: env.ALLOWED_ORIGIN || '*',

  // How often (ms) changes are pushed to browsers
  pushInterval: Number(env.PUSH_INTERVAL_MS || 2000),

  // Local time (London) to reload the daily schedule, "HH:MM"
  scheduleReloadAt: env.SCHEDULE_RELOAD_AT || '05:15',
};

export function hasCredentials() {
  return Boolean(config.nrUser && config.nrPass);
}
