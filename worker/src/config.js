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
  // Default: the London commuter belt — Brighton to Milton Keynes/Cambridge, Basingstoke/Reading to Southend/Ashford.
  trackBox: bbox(env.TRACK_BBOX || '50.78,-1.18,52.26,0.98'),
  overpassUrls: (env.OVERPASS_URLS ||
    'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter').split(','),

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
