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

## Deploying publicly (Hostinger, VPS, etc.)

- Node 18+ app; entry point `server.js` (`npm start`).
- Set environment variables on the host: `CF_API_TOKEN`, `CF_ZONE_NAME` (or `CF_ZONE_ID`), and **`DASHBOARD_PASSWORD`** — with it set, the dashboard requires HTTP Basic auth (username `admin`). Without it the dashboard and your traffic stats are public to anyone with the URL.
- The host's `PORT` variable is respected automatically.

## Notes

- Data source is `httpRequestsAdaptiveGroups` / `firewallEventsAdaptiveGroups` (available on all plans, adaptive sampling). Edge analytics lag roughly 1–5 minutes — "near real time".
- The token never leaves the local server; the browser only talks to `localhost`.
