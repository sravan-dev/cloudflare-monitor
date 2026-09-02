// Cloudflare real-time traffic monitor — zero-dependency Node server.
// Reads .env for CF_API_TOKEN (+ optional CF_ZONE_ID), auto-discovers the zone
// for CF_ZONE_NAME when no id is given, proxies the GraphQL Analytics API to
// the dashboard in ./public.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// ---------- .env ----------
function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env yet */ }
  return out;
}
const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };

const TOKEN = env.CF_API_TOKEN;
const ZONE_NAME = env.CF_ZONE_NAME || 'tijusacademy.com';
let zoneId = env.CF_ZONE_ID || null;
const PORT = Number(env.PORT) || 3000;

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body?.errors?.map((e) => e.message).join('; ') || res.statusText;
    throw new Error(`Cloudflare API ${res.status}: ${msg}`);
  }
  return body;
}

async function resolveZone() {
  if (zoneId) return zoneId;
  const body = await cfFetch(`${CF_API}/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  const zone = body.result?.[0];
  if (!zone) throw new Error(`Zone "${ZONE_NAME}" not found for this API token`);
  zoneId = zone.id;
  console.log(`Zone resolved: ${ZONE_NAME} -> ${zoneId}`);
  return zoneId;
}

// ---------- GraphQL ----------
const TRAFFIC_QUERY = `
query Traffic($zone: String!, $since: Time!, $until: Time!, $seriesLimit: Int!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      series: httpRequestsAdaptiveGroups(
        limit: $seriesLimit
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [datetimeMinute_ASC]
      ) {
        count
        sum { edgeResponseBytes visits }
        dimensions { datetimeMinute }
      }
      countries: httpRequestsAdaptiveGroups(
        limit: 8
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientCountryName }
      }
      statusCodes: httpRequestsAdaptiveGroups(
        limit: 12
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { edgeResponseStatus }
      }
      cache: httpRequestsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { cacheStatus }
      }
      paths: httpRequestsAdaptiveGroups(
        limit: 8
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientRequestPath }
      }
    }
  }
}`;

// Live humans estimate: unique client IPs over the last 5 minutes with
// bot-looking user agents filtered out (no Bot Management on this plan,
// so a user-agent heuristic is the best available signal).
const LIVE_QUERY = `
query Live($zone: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      live: httpRequestsAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $since, datetime_lt: $until }
      ) {
        count
        dimensions { clientIP userAgent }
      }
    }
  }
}`;

const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|go-http|httpclient|monitor|uptime|pingdom|scan|probe|headless|lighthouse|facebookexternalhit|preview/i;

// Bot traffic over the selected range: group by user agent, classify with
// the same heuristic (no Bot Management dataset on this plan).
const BOT_QUERY = `
query Bots($zone: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      agents: httpRequestsAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { userAgent }
      }
    }
  }
}`;

// Separate query: firewall dataset needs Zone > Firewall Services > Read,
// which the "Read analytics and logs" token template does not include.
// Queried on its own so a missing permission degrades gracefully.
const FIREWALL_QUERY = `
query Firewall($zone: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      firewall: firewallEventsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { action }
      }
    }
  }
}`;

async function graphql(query, variables) {
  const body = await cfFetch(`${CF_API}/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  const z = body.data?.viewer?.zones?.[0];
  if (!z) throw new Error('No zone data returned (check token permissions: Zone > Analytics > Read)');
  return z;
}

async function fetchStats(minutes) {
  const zone = await resolveZone();
  const until = new Date();
  const since = new Date(until.getTime() - minutes * 60 * 1000);
  const vars = { zone, since: since.toISOString(), until: until.toISOString() };

  const trafficPromise = graphql(TRAFFIC_QUERY, { ...vars, seriesLimit: Math.min(minutes + 5, 1440) });
  // Firewall dataset is optional — token may lack Firewall Services Read.
  const firewallPromise = graphql(FIREWALL_QUERY, vars)
    .then((z) => ({ firewall: z.firewall || [], firewallError: null }))
    .catch((err) => ({ firewall: [], firewallError: err.message }));
  // Live humans: fixed 5-minute window regardless of the selected range.
  const liveSince = new Date(until.getTime() - 5 * 60 * 1000);
  const livePromise = graphql(LIVE_QUERY, { zone, since: liveSince.toISOString(), until: until.toISOString() })
    .then((z) => {
      const ips = new Set();
      for (const g of z.live || []) {
        const ua = g.dimensions.userAgent || '';
        if (!BOT_UA.test(ua)) ips.add(g.dimensions.clientIP);
      }
      return { liveHumans: ips.size, liveError: null };
    })
    .catch((err) => ({ liveHumans: null, liveError: err.message }));

  const botsPromise = graphql(BOT_QUERY, vars)
    .then((z) => {
      let bot = 0, total = 0;
      for (const g of z.agents || []) {
        total += g.count;
        if (BOT_UA.test(g.dimensions.userAgent || '')) bot += g.count;
      }
      return { botRequests: bot, botPct: total ? (bot / total) * 100 : 0, botError: null };
    })
    .catch((err) => ({ botRequests: null, botPct: null, botError: err.message }));

  const [z, fw, live, bots] = await Promise.all([trafficPromise, firewallPromise, livePromise, botsPromise]);
  return {
    zoneName: ZONE_NAME,
    since: since.toISOString(),
    until: until.toISOString(),
    minutes,
    series: z.series || [],
    countries: z.countries || [],
    statusCodes: z.statusCodes || [],
    cache: z.cache || [],
    paths: z.paths || [],
    firewall: fw.firewall,
    firewallError: fw.firewallError,
    liveHumans: live.liveHumans,
    liveError: live.liveError,
    botRequests: bots.botRequests,
    botPct: bots.botPct,
    botError: bots.botError,
  };
}

// ---------- HTTP server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const PASSWORD = env.DASHBOARD_PASSWORD;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Optional HTTP Basic auth for public deployments: set DASHBOARD_PASSWORD.
  if (PASSWORD) {
    const auth = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer.from('admin:' + PASSWORD).toString('base64');
    if (auth !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cloudflare Monitor"' });
      return res.end('Authentication required');
    }
  }

  if (url.pathname === '/api/stats') {
    if (!TOKEN) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'CF_API_TOKEN missing. Copy .env.example to .env and set your token.' }));
    }
    const minutes = Math.max(5, Math.min(1440, Number(url.searchParams.get('minutes')) || 30));
    try {
      const stats = await fetchStats(minutes);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(stats));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // static files
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Cloudflare monitor: http://localhost:${PORT}`);
  if (!TOKEN) console.warn('WARNING: CF_API_TOKEN not set. Copy .env.example to .env and add your token.');
});
