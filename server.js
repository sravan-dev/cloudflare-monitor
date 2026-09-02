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
// Free-plan GraphQL caps each query's time range at 1 day, so wider ranges
// are split into daily chunks and merged. The series bucket adapts to span.
function bucketFor(spanMinutes) {
  if (spanMinutes <= 360) return { dim: 'datetimeMinute', minutes: 1 };
  if (spanMinutes <= 2880) return { dim: 'datetimeFifteenMinutes', minutes: 15 };
  return { dim: 'datetimeHour', minutes: 60 };
}

const trafficQuery = (bucketDim) => `
query Traffic($zone: String!, $since: Time!, $until: Time!, $seriesLimit: Int!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      series: httpRequestsAdaptiveGroups(
        limit: $seriesLimit
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [${bucketDim}_ASC]
      ) {
        count
        sum { edgeResponseBytes visits }
        dimensions { ts: ${bucketDim} }
      }
      agents: httpRequestsAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { userAgent }
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

// AI crawlers and assistants, classified by user agent. Referer-based
// attribution (visitors arriving FROM chatgpt.com etc.) needs the
// clientRefererHost dimension, which is Pro-plan-gated.
const AI_PLATFORMS = [
  { name: 'ChatGPT / OpenAI', re: /gptbot|chatgpt-user|oai-searchbot/i },
  { name: 'Perplexity', re: /perplexity/i },
  { name: 'Google AI', re: /google-extended|googleother|google-cloudvertexbot/i },
  { name: 'Claude / Anthropic', re: /claudebot|claude-web|claude-user|claude-searchbot|anthropic/i },
  { name: 'Meta AI', re: /meta-external|facebookbot/i },
  { name: 'Bing / Copilot', re: /bingbot|bingpreview/i },
  { name: 'Other AI', re: /bytespider|amazonbot|applebot|ccbot|cohere|youbot|duckassistbot|mistralai|ai2bot|diffbot|timpibot|omgili|webzio/i },
];

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

const DAY_MS = 24 * 60 * 60 * 1000;

// Live site health check, cached so dashboard refreshes don't hammer the site.
let siteCache = { at: 0, result: null };
async function checkSite() {
  if (Date.now() - siteCache.at < 20000 && siteCache.result) return siteCache.result;
  const started = Date.now();
  let result;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`https://${ZONE_NAME}/`, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'cloudflare-monitor-healthcheck' },
    });
    clearTimeout(t);
    const ms = Date.now() - started;
    result = {
      up: res.status < 500,
      status: res.status,
      ms,
    };
  } catch (err) {
    result = { up: false, status: null, ms: Date.now() - started, error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
  siteCache = { at: Date.now(), result };
  return result;
}

// Split [since, until) into chunks no wider than 1 day (free-plan limit).
function dayChunks(since, until) {
  const chunks = [];
  let start = since.getTime();
  while (start < until.getTime()) {
    const end = Math.min(start + DAY_MS, until.getTime());
    chunks.push({ since: new Date(start).toISOString(), until: new Date(end).toISOString() });
    start = end;
  }
  return chunks;
}

// Merge grouped rows across chunks: sum counts by dimension key, sort desc.
function mergeGroups(lists, key, limit) {
  const map = new Map();
  for (const rows of lists) {
    for (const r of rows || []) {
      const k = String(r.dimensions[key]);
      map.set(k, (map.get(k) || 0) + r.count);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, count]) => ({ count, dimensions: { [key]: k } }));
}

async function fetchStats(since, until) {
  const zone = await resolveZone();
  const spanMinutes = Math.round((until - since) / 60000);
  const bucket = bucketFor(spanMinutes);
  const query = trafficQuery(bucket.dim);
  const chunks = dayChunks(since, until);

  const trafficPromise = Promise.all(chunks.map((c) =>
    graphql(query, {
      zone, since: c.since, until: c.until,
      seriesLimit: Math.min(Math.ceil(1440 / bucket.minutes) + 5, 1500),
    })
  ));
  // Firewall dataset is optional — token may lack Firewall Services Read.
  const firewallPromise = Promise.all(chunks.map((c) =>
    graphql(FIREWALL_QUERY, { zone, since: c.since, until: c.until })
  ))
    .then((zs) => ({ firewall: mergeGroups(zs.map((z) => z.firewall), 'action', 10), firewallError: null }))
    .catch((err) => ({ firewall: [], firewallError: err.message }));
  // Live humans: always the last 5 minutes from now, regardless of range.
  const now = new Date();
  const liveSince = new Date(now.getTime() - 5 * 60 * 1000);
  const livePromise = graphql(LIVE_QUERY, { zone, since: liveSince.toISOString(), until: now.toISOString() })
    .then((z) => {
      const ips = new Set();
      for (const g of z.live || []) {
        const ua = g.dimensions.userAgent || '';
        if (!BOT_UA.test(ua)) ips.add(g.dimensions.clientIP);
      }
      return { liveHumans: ips.size, liveError: null };
    })
    .catch((err) => ({ liveHumans: null, liveError: err.message }));

  const sitePromise = checkSite();

  const [zs, fw, live, site] = await Promise.all([trafficPromise, firewallPromise, livePromise, sitePromise]);

  const series = zs.flatMap((z) => z.series || [])
    .sort((a, b) => a.dimensions.ts < b.dimensions.ts ? -1 : 1);
  let bot = 0, agentTotal = 0;
  const ai = AI_PLATFORMS.map((p) => ({ name: p.name, count: 0 }));
  for (const z of zs) {
    for (const g of z.agents || []) {
      const ua = g.dimensions.userAgent || '';
      agentTotal += g.count;
      if (BOT_UA.test(ua)) bot += g.count;
      const idx = AI_PLATFORMS.findIndex((p) => p.re.test(ua));
      if (idx >= 0) ai[idx].count += g.count;
    }
  }

  return {
    zoneName: ZONE_NAME,
    since: since.toISOString(),
    until: until.toISOString(),
    minutes: spanMinutes,
    bucketMinutes: bucket.minutes,
    series,
    countries: mergeGroups(zs.map((z) => z.countries), 'clientCountryName', 8),
    statusCodes: mergeGroups(zs.map((z) => z.statusCodes), 'edgeResponseStatus', 12),
    cache: mergeGroups(zs.map((z) => z.cache), 'cacheStatus', 10),
    paths: mergeGroups(zs.map((z) => z.paths), 'clientRequestPath', 8),
    firewall: fw.firewall,
    firewallError: fw.firewallError,
    liveHumans: live.liveHumans,
    liveError: live.liveError,
    botRequests: bot,
    botPct: agentTotal ? (bot / agentTotal) * 100 : 0,
    botError: null,
    aiTraffic: ai,
    site,
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
    // Either an absolute window (since/until ISO) or a rolling ?minutes= one.
    let since, until;
    const sinceParam = Date.parse(url.searchParams.get('since'));
    const untilParam = Date.parse(url.searchParams.get('until'));
    if (!Number.isNaN(sinceParam) && !Number.isNaN(untilParam) && untilParam > sinceParam) {
      since = new Date(sinceParam);
      until = new Date(untilParam);
    } else {
      const minutes = Math.max(5, Math.min(10080, Number(url.searchParams.get('minutes')) || 30));
      until = new Date();
      since = new Date(until.getTime() - minutes * 60 * 1000);
    }
    // Cap span at 7 days (free-plan analytics retention).
    if (until - since > 7 * DAY_MS) since = new Date(until.getTime() - 7 * DAY_MS);
    try {
      const stats = await fetchStats(since, until);
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
