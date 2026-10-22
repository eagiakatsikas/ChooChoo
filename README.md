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

Across the London commuter belt (roughly Brighton to Milton Keynes and Cambridge, Reading/Basingstoke to Southend/Ashford), trains follow the real track: the worker downloads the railway lines from OpenStreetMap (via the Overpass API) once a week and works out the route between each pair of stations. Further out they move in straight lines between stations.

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

## Worker API

| Endpoint | What it returns |
|---|---|
| `GET /api/stream` | Server-Sent Events: a `snapshot`, then `delta` updates every 2 s |
| `GET /api/trains` | Current snapshot as JSON |
| `GET /api/train/:id` | Calling points and route line for one train |
| `GET /api/status` | Feed connection, counts, message stats |

## Things to know

- **Start-up:** the worker downloads the day's full timetable (~tens of MB) and takes a minute or two to load before trains appear. It reloads it every morning at 05:15.
- **After a restart** it picks up trains already running from their next reported movement, so the map fills in over a few minutes.
- **Coverage:** TD covers almost all of London, but a few areas only report via TRUST, so trains there update less often.
- **Tests:** `cd worker && npm test` runs the position logic against sample feed messages.
- **Street maps** (Map and Dark) come from OpenFreeMap: free, no API key and no usage limits.
- **Satellite view** uses Esri World Imagery, which is free for personal and non-commercial use with attribution (shown on the map). If you ever make this a commercial product, you'd need an Esri account or a different imagery provider.
- Network Rail data © Network Rail Infrastructure Ltd, Open Government Licence. Street map © OpenStreetMap contributors (free tiles, fine for personal use; a busy public app should switch to a paid tile provider). Imagery and satellite labels © Esri, Maxar, Earthstar Geographics.
