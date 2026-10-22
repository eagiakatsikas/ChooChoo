// STOMP connection to Network Rail Open Data live feeds.
import stompit from 'stompit';
import { config } from './config.js';
import { handleTrust, handleTd, stats } from './trains.js';
import { applyVstp } from './schedule.js';

export const feedState = { connected: false, since: null, lastError: null };

const TOPICS = {
  TRAIN_MVT_ALL_TOC: (body) => handleTrust(JSON.parse(body)),
  TD_ALL_SIG_AREA: (body) => handleTd(JSON.parse(body)),
  VSTP_ALL: (body) => {
    stats.vstp++;
    applyVstp(JSON.parse(body));
  },
};

export function startFeeds() {
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
  const manager = new stompit.ConnectFailover([server], {
    initialReconnectDelay: 2000,
    maxReconnectDelay: 60000,
    useExponentialBackOff: true,
    maxReconnects: -1,
    randomize: false,
  });

  manager.on('error', (err) => {
    feedState.lastError = err.message;
    console.error('[feeds] connection error:', err.message);
  });

  manager.connect((err, client, reconnect) => {
    if (err) {
      feedState.connected = false;
      feedState.lastError = err.message;
      console.error('[feeds] cannot connect:', err.message);
      return;
    }
    feedState.connected = true;
    feedState.since = Date.now();
    console.log('[feeds] connected to', config.stompHost);

    client.on('error', (e) => {
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
