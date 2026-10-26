# Choo Choo

A live map of every passenger train running into, out of or through London, updated from Network Rail's signalling data. Filter by operator, colour trains by delay, switch between a plain map and satellite imagery, and tap a train to see its calling points.

```
london-trains/
├── web/      Map site → deploy to Vercel
└── worker/   Always-on data service → deploy to Railway (or Fly.io / any VPS)
```

The site works on its own in **demo mode** (simulated trains on real routes), so you can deploy it straight away and switch to live data once your Network Rail account is approved.

## How it works

```
Network Rail feeds ──STOMP──▶ worker ──Server-Sent Events──▶ map in your browser
 (TD signalling,               works out each train's            animates trains
  TRUST movements,             position, every 2 s               between updates
  VSTP, schedule)
```

- **Which trains:** passenger services whose timetable touches any station inside Greater London (National Rail termini, Thameslink, Elizabeth line, London Overground, plus long-distance trains). Freight, empty stock and buses are excluded.
- **Positions:** the Train Describer (TD) feed reports trains as they step between signal berths, usually within seconds. Network Rail's SMART data maps those steps to station arrivals and departures. TRUST movement reports fill gaps. Between stations, trains are moved along the line using their timetabled running time, adjusted for delay, and held just short of the next station until they're reported there.
- **Station locations** come from NaPTAN (DfT open data).

Across the London commuter belt (roughly Brighton to Milton Keynes and Cambridge, Reading/Basingstoke to Southend/Ashford, plus High Speed 1 to the Channel Tunnel), trains follow the real track: the worker downloads the railway lines from OpenStreetMap (via the Overpass API) once a week and works out the route between each pair of stations. Further out they move in straight lines between stations.

## 1. Deploy the map to Vercel (5 minutes)

1. Put this folder in a GitHub repo.
2. In Vercel: **Add New → Project**, import the repo, and set **Root Directory** to `web`. Vercel detects Vite automatically.
3. Deploy. With no worker configured, the site runs in demo mode.

Run locally: `cd web && npm install && npm run dev`

## 2. Get Network Rail data access (free)

1. Register at **https://publicdatafeeds.networkrail.co.uk** (Network Rail Open Data). Approval can take a few days.
2. There's nothing to subscribe to: the current portal gives every account access to all feeds (Movement, TD, VSTP, Schedule, SMART).
3. Your login email and password are what the worker uses.

If Network Rail has moved new sign-ups to the **Rail Data Marketplace** (raildata.org.uk) by the time you register, subscribe to the same feeds there; the worker's hosts and URLs are all overridable with environment variables (see `worker/src/config.js`).

## 3. Deploy the worker to Railway

Vercel can't hold the permanent connection to Network Rail, so the worker runs on a small always-on host. Railway is the simplest (Hobby plan, about $5/month; it needs ~300 MB RAM).

1. In Railway: **New Project → Deploy from GitHub repo**, choose the repo, and set the service's **Root Directory** to `worker`. It uses the included Dockerfile.
2. Add variables (see `worker/.env.example`):
   | Variable | Value |
   |---|---|
   | `NR_USERNAME` | your Network Rail login email |
   | `NR_PASSWORD` | your Network Rail password |
   | `NR_CLIENT_ID` | any unique name, e.g. `choo-choo-1` |
   | `ALLOWED_ORIGIN` | your Vercel URL, e.g. `https://choo-choo.vercel.app` |
3. Optional: attach a volume at `/app/data` so downloaded reference files survive restarts (faster start-up).
4. Under **Networking**, generate a public domain. Check `https://<that-domain>/api/status` — after a minute or two you should see `runsLoaded` in the thousands and `feed.connected: true`.

Fly.io works too: `cd worker && fly launch` then `fly secrets set NR_USERNAME=… NR_PASSWORD=…`.

### Free alternative: Oracle Cloud "Always Free" server

1. Sign up at **https://signup.cloud.oracle.com** and pick **UK South (London)** as your home region (it can't be changed later). A card is needed for identity checks; Always Free resources aren't charged.
2. In the console: **Compute → Instances → Create instance**.
   - Image: **Canonical Ubuntu 24.04**. Shape: **VM.Standard.E2.1.Micro** (Always Free; the Ampere A1 shape also works if it has capacity).
   - Networking: keep "Assign a public IPv4 address" on.
   - SSH keys: **Save private key** and keep the file safe.
   - **Show advanced options → Management → Paste cloud-init script**: paste the whole of `deploy/oracle-setup.sh`, with your Network Rail email and password filled in at the top.
3. Open web traffic in Oracle's network firewall: on the instance page, open the **Subnet → Security** (or Security Lists) → **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination ports `80,443`.
4. Wait about 10 minutes for setup to finish. The worker's address is `https://<your-ip-with-dashes>.sslip.io`, e.g. IP `132.145.10.20` → `https://132-145-10-20.sslip.io`. Check `https://…/api/status`.
5. Put that address in Vercel as `VITE_WORKER_URL` and redeploy.

To add or change your Network Rail login later: `ssh -i <your-key> ubuntu@<ip>`, then `sudo nano /etc/choochoo.env`, then `sudo systemctl restart choochoo`. To update the worker to the latest code, run `sudo bash /opt/choochoo/app/deploy/update.sh` on the server (your settings are kept). Logs: `journalctl -u choochoo -f`.

## 4. Point the map at the worker

In Vercel → Project → **Settings → Environment Variables**, add:

```
VITE_WORKER_URL = https://<your-worker-domain>
```

Redeploy. The status lamp turns green and reads **Live**.

Handy overrides: `?demo` forces demo mode; `?worker=https://…` tries a different worker without redeploying.

## Departure boards

Open any station (tap it on the map, or find it in Search) to see every train leaving, with platforms. **Where to?** narrows it to direct trains to one station, with the best one (earliest arrival) marked.

For live platforms and expected times, add a free National Rail key: register at https://raildata.org.uk, subscribe to the **Live Departure Board** product, copy its *Consumer key*, then on the server add `LDB_API_KEY=<key>` to `/etc/choochoo.env` and run `sudo systemctl restart choochoo`. Without a key the board uses the timetable and Choo Choo's own live data, with planned platforms.

## Getting around the app

On first open, Choo Choo asks for your home and work stations, your location, and (on iPhone) to be added to the home screen. There are three tabs:

- **Now:** what should I catch? Your commute the right way round (from where you are, or by time of day; the arrows swap it) with the next good train, its platform, when to leave, **Alert me** and **Every weekday** alerts. Then the stations and bus stops nearest you with what's leaving next, then everything you've starred.
- **Map:** opens on where you are. The top bar shows whether it's live and switches trains and buses on or off; **⋯** holds the rest (disruption, replay, every bus when zoomed in, operators, colours, map style, My buses, Commute & alerts).
- **Search:** one box for stations, bus stops, bus routes, train headcodes and bus registrations. Empty, it lists what you've starred and opened recently.

Everything opens in the same sheet over the map: a station's board, a bus stop's arrivals, a bus route and its buses, or a train or bus and its stops. Drag it up for more or flick it down to close. **Star** a station, a station-to-station route, a bus stop or a bus route to keep it on Now and in Search. Trains have **Alert me** (platform, delays, cancellation) and **Follow**; buses have **Follow** and **I'm on it**. On iPhone, notifications only work once Choo Choo is on the home screen.

**Usage** (under ⋯ More) shows how many phones use Choo Choo each day and which parts get used: sheets opened, stars, alerts, searches that found nothing, how quickly trains appear, and errors. It's anonymous: each phone sends a random ID it made itself and short event names, to your own server only, and the counts are kept for 90 days.

Your saved routes and alerts are kept on your phone. The server records how your saved routes' trains arrive (30 days) for the reliability figures, and keeps the last hour of train positions for replay.

**Eurostar** trains carry on beyond the Channel Tunnel to Paris, Brussels and Amsterdam using Eurostar's own open data (timetable plus live delays, from France's open data portal), placed between stations on the high-speed lines.

**Server check:** a GitHub Actions job (`.github/workflows/uptime.yml`) checks the server every 15 minutes. If it's down, or has lost its Network Rail connection for a few minutes, the run fails and GitHub emails you. (GitHub pauses scheduled jobs in a repo after 60 days without any commits; re-enable it under Actions if that happens.)

## Ding Ding (buses)

London buses, from TfL's open data. TfL doesn't publish bus GPS positions, so each bus is placed on its route between its last stop and the next, using its predicted arrival time and a speed worked out from its own predictions (so it slows down in traffic). Your starred routes show at any zoom; turn on **Every bus when zoomed in** (under ⋯) to see every bus in view.

Get a free key at https://api-portal.tfl.gov.uk (subscribe to the 500 requests a minute plan, copy the primary key), then on the server add `TFL_APP_KEY=<key>` to `/etc/choochoo.env` and run `sudo systemctl restart choochoo`. The first start downloads every bus route (a few minutes); after that they're kept on disk and refreshed weekly. Live predictions are only fetched for routes someone is looking at.

## Worker API

| Endpoint | What it returns |
|---|---|
| `GET /api/stream` | Server-Sent Events: a `snapshot`, then `delta` updates every 2 s |
| `GET /api/trains` | Current snapshot as JSON |
| `GET /api/train/:id` | Calling points and route line for one train |
| `GET /api/stations` | All stations (CRS code, name, location) |
| `GET /api/board?from=WAT&to=RAY` | Direct departures from one station to another |
| `GET /api/buses?r=93,57&b=s,w,n,e` | Buses on those routes, plus every bus in the box |
| `GET /api/bus/:id` | One bus: next stops and route line |
| `GET /api/busroutes` | All bus routes (number and ends) |
| `GET /api/board?from=WAT` | Every departure from a station (no destination) |
| `GET /api/busto?la=&lo=&crs=` | Buses from where you are to a station |
| `GET /api/disruptions` | Line status (National Rail operators and TfL rail lines) |
| `GET /api/history?f=RAY&t=WAT` | How a saved route's trains have run |
| `POST /api/ev` · `GET /api/usage` | Anonymous usage events from the app, and the daily totals |
| `GET /api/replay?t=` | Train positions at a time in the last hour |
| `POST /api/alerts` | Watch a train (Web Push subscription + train) |
| `GET /api/status` | Feed connection, counts, message stats |

## Things to know

- **Start-up:** the worker downloads the day's full timetable (~tens of MB) and takes a minute or two to load before trains appear. It reloads it every morning at 05:15.
- **After a restart** it picks up trains already running from their next reported movement, so the map fills in over a few minutes.
- **Coverage:** TD covers almost all of London, but a few areas only report via TRUST, so trains there update less often.
- **Tests:** `cd worker && npm test` runs the position logic against sample feed messages.
- **Street maps** (Map and Dark) come from OpenFreeMap: free, no API key and no usage limits.
- **Satellite view** uses Esri World Imagery, which is free for personal and non-commercial use with attribution (shown on the map). If you ever make this a commercial product, you'd need an Esri account or a different imagery provider.
- Network Rail data © Network Rail Infrastructure Ltd, Open Government Licence. Street map © OpenStreetMap contributors (free tiles, fine for personal use; a busy public app should switch to a paid tile provider). Imagery and satellite labels © Esri, Maxar, Earthstar Geographics. Bus data: Powered by TfL Open Data (contains OS data © Crown copyright and database rights).
