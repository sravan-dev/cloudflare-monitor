# Cloudflare Traffic Monitor — tijusacademy.com

Near-real-time traffic dashboard for a Cloudflare zone. Zero dependencies — plain Node.js server proxying the Cloudflare GraphQL Analytics API, vanilla HTML/SVG dashboard.

## Setup

1. Create an API token at <https://dash.cloudflare.com/profile/api-tokens>
   - Template: **Read analytics and logs**, or custom with:
     - `Zone > Analytics > Read`
     - `Zone > Zone > Read` (lets the server auto-discover the zone ID)
   - Scope it to the `tijusacademy.com` zone.
2. Copy `.env.example` to `.env` and paste the token into `CF_API_TOKEN`.
3. Run:

   ```
   node server.js
   ```

4. Open <http://localhost:3000>.

## What it shows

- Stat tiles: requests, visits, bandwidth, cache hit ratio, 5xx error rate, challenged/blocked requests
- Requests-per-minute and bandwidth-per-minute line charts with hover tooltips
- Top countries, status codes, cache status, top paths, firewall actions
- Time ranges: 15m / 30m / 1h / 6h / 24h; auto-refreshes every 30 seconds
- Email alerts on 5xx errors (see below)

## 5xx email alerts

The server emails when the site starts returning 5xx and again when it clears.
Two independent checks run every `ALERT_INTERVAL_SEC` (default 60s):

1. A direct GET to `https://<CF_ZONE_NAME>/` — alerts if the response is 5xx.
2. Cloudflare edge analytics — alerts when 5xx responses served to real
   visitors in the window reach `ALERT_5XX_THRESHOLD` (5xx origin/edge errors
   such as 502/504/520–526 that a healthcheck on `/` would miss).

Configure in `.env`:

```
ALERT_EMAIL_TO=you@example.com     # comma-separated; empty disables alerts
SMTP_USER=you@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx      # Gmail app password, NOT the account password
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
ALERT_INTERVAL_SEC=60
ALERT_5XX_THRESHOLD=1              # raise this on a noisy site to avoid alert fatigue
ALERT_COOLDOWN_MIN=30              # minutes before re-alerting while still broken
```

Gmail app password: <https://myaccount.google.com/apppasswords> (requires 2-Step
Verification). Verify the settings with:

```
node server.js --test-alert
```

Mail is sent over implicit TLS by `mailer.js` — a small SMTP client, still no
npm dependencies.

## Deploying publicly (Hostinger, VPS, etc.)

- Node 18+ app; entry point `server.js` (`npm start`).
- Set environment variables on the host: `CF_API_TOKEN`, `CF_ZONE_NAME` (or `CF_ZONE_ID`), and **`DASHBOARD_PASSWORD`** — with it set, the dashboard requires HTTP Basic auth (username `admin`). Without it the dashboard and your traffic stats are public to anyone with the URL.
- The host's `PORT` variable is respected automatically.

## Notes

- Data source is `httpRequestsAdaptiveGroups` / `firewallEventsAdaptiveGroups` (available on all plans, adaptive sampling). Edge analytics lag roughly 1–5 minutes — "near real time".
- The token never leaves the local server; the browser only talks to `localhost`.
- Alerts only run while `server.js` is running. For 24/7 alerting, keep it alive with a process manager (pm2, systemd) on an always-on host.
