// STOMP connection to Network Rail Open Data live feeds.
import stompit from 'stompit';
import { config } from './config.js';
import { handleTrust, handleTd, stats } from './trains.js';
import { applyVstp } from './schedule.js';

export const feedState = { connected: false, since: null, lastError: null, restarts: 0, lastRestart: null };

// Watchdog: Network Rail's feed is never quiet for long (signalling messages arrive every
// second). If nothing arrives for a while, or the connection stays down, the session is
// probably stuck (e.g. 'Exception getting session'), so start a fresh connection.
const QUIET_MS = 5 * 60000;
const GIVE_IT_MS = 5 * 60000; // let ordinary reconnects try for this long first
let manager = null;
let current = null;
let troubleSince = null;

const TOPICS = {
  TRAIN_MVT_ALL_TOC: (body) => handleTrust(JSON.parse(body)),
  TD_ALL_SIG_AREA: (body) => handleTd(JSON.parse(body)),
  VSTP_ALL: (body) => {
    stats.vstp++;
    applyVstp(JSON.parse(body));
  },
};

export function startFeeds() {
  connect();
  setInterval(watchdog, 60000);
}

/** Is the feed healthy? Connected, and a message within the last few minutes. */
export function feedHealthy(now = Date.now()) {
  return feedState.connected && Boolean(stats.lastMsg) && now - stats.lastMsg < QUIET_MS;
}

export function watchdog(now = Date.now(), start = connect) {
  if (feedHealthy(now) || (!stats.lastMsg && feedState.connected && now - (feedState.since || now) < QUIET_MS)) {
    troubleSince = null;
    return false;
  }
  troubleSince ||= now;
  if (now - troubleSince < GIVE_IT_MS) return false;
  // Stuck: throw this connection away and start again from scratch
  feedState.restarts++;
  feedState.lastRestart = now;
  console.error(`[feeds] no train messages for a while (${feedState.lastError || 'no error'}): starting a fresh connection`);
  troubleSince = now; // and give the new one time before trying again
  const old = current;
  current = null;
  manager = null;
  try {
    if (old) old.destroy();
  } catch {}
  start();
  return true;
}

function connect() {
  const clientId = config.nrClientId || `${config.nrUser}-london-trains`;
  const server = {
    host: config.stompHost,
    port: config.stompPort,
    connectHeaders: {
      host: '/',
      login: config.nrUser,
      passcode: config.nrPass,
      'client-id': clientId,
      'heart-beat': '15000,15000',
    },
  };
  const m = new stompit.ConnectFailover([server], {
    initialReconnectDelay: 2000,
    maxReconnectDelay: 60000,
    useExponentialBackOff: true,
    maxReconnects: -1,
    randomize: false,
  });
  manager = m;

  m.on('error', (err) => {
    if (m !== manager) return;
    feedState.lastError = err.message;
    console.error('[feeds] connection error:', err.message);
  });

  m.connect((err, client, reconnect) => {
    // A connection the watchdog has already replaced: close it, don't keep it going
    if (m !== manager) {
      try {
        client && client.disconnect();
      } catch {}
      return;
    }
    if (err) {
      feedState.connected = false;
      feedState.lastError = err.message;
      console.error('[feeds] cannot connect:', err.message);
      return;
    }
    current = client;
    feedState.connected = true;
    feedState.since = Date.now();
    console.log('[feeds] connected to', config.stompHost);

    client.on('error', (e) => {
      if (m !== manager) return;
      feedState.connected = false;
      feedState.lastError = e.message;
      console.error('[feeds] client error, reconnecting:', e.message);
      reconnect();
    });

    for (const [topic, handler] of Object.entries(TOPICS)) {
      client.subscribe(
        {
          destination: `/topic/${topic}`,
          ack: 'client-individual',
          // Durable: messages sent while we're briefly disconnected are kept for us.
          'activemq.subscriptionName': `${clientId}-${topic}`,
        },
        (subErr, message) => {
          if (subErr) {
            console.error(`[feeds] ${topic} subscribe error:`, subErr.message);
            return;
          }
          message.readString('utf-8', (readErr, body) => {
            client.ack(message);
            if (readErr) return;
            try {
              handler(body);
            } catch (e) {
              console.error(`[feeds] ${topic} message error:`, e.message);
            }
          });
        },
      );
      console.log(`[feeds] subscribed to ${topic}`);
    }
  });
}
