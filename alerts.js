// 5xx alerting: polls the live site and Cloudflare's edge status codes, and
// emails when the site starts returning 5xx (and again when it recovers).
//
// Config (.env):
//   ALERT_EMAIL_TO        comma-separated recipients; empty disables alerts
//   SMTP_USER / SMTP_PASS Gmail address + app password
//   SMTP_HOST / SMTP_PORT default smtp.gmail.com : 465
//   ALERT_INTERVAL_SEC    poll interval, default 60
//   ALERT_5XX_THRESHOLD   edge 5xx responses per window before alerting, default 1
//   ALERT_COOLDOWN_MIN    minutes before re-alerting on a still-broken site, default 30

const { sendMail } = require('./mailer.js');

const EDGE_5XX_QUERY = `
query Errors($zone: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      errors: httpRequestsAdaptiveGroups(
        limit: 20
        filter: { datetime_geq: $since, datetime_lt: $until, edgeResponseStatus_geq: 500 }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { edgeResponseStatus clientRequestPath }
      }
    }
  }
}`;

// Fallback for tokens/plans where edgeResponseStatus_geq is rejected:
// pull the top status codes and filter to 5xx here.
const EDGE_STATUS_QUERY = `
query Status($zone: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      errors: httpRequestsAdaptiveGroups(
        limit: 20
        filter: { datetime_geq: $since, datetime_lt: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { edgeResponseStatus }
      }
    }
  }
}`;

function startAlerts({ env, zoneName, checkSite, graphql, resolveZone }) {
  const to = String(env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  if (!to.length || !user || !pass) {
    console.log('Alerts disabled (set ALERT_EMAIL_TO, SMTP_USER, SMTP_PASS in .env).');
    return { enabled: false };
  }

  const intervalMs = (Number(env.ALERT_INTERVAL_SEC) || 60) * 1000;
  const threshold = Number(env.ALERT_5XX_THRESHOLD) || 1;
  const cooldownMs = (Number(env.ALERT_COOLDOWN_MIN) || 30) * 60 * 1000;
  const mailOpts = { host: env.SMTP_HOST, port: env.SMTP_PORT, user, pass, from: env.SMTP_FROM || user, to };

  // Per-check state: is it currently failing, and when did we last email.
  const state = { site: { bad: false, lastMail: 0 }, edge: { bad: false, lastMail: 0 } };
  let useGeqFilter = true;

  async function mail(subject, text) {
    try {
      await sendMail({ ...mailOpts, subject, text });
      console.log(`Alert email sent: ${subject}`);
    } catch (err) {
      console.error(`Alert email FAILED: ${err.message}`);
    }
  }

  // Fires the alert on the failing edge, a repeat after the cooldown, and a
  // recovery notice when it clears.
  async function report(key, bad, subject, body) {
    const s = state[key];
    const now = Date.now();
    if (bad) {
      if (!s.bad || now - s.lastMail >= cooldownMs) {
        s.lastMail = now;
        await mail(subject, body);
      }
      s.bad = true;
    } else {
      if (s.bad) await mail(`RECOVERED: ${zoneName} no longer returning 5xx`, body);
      s.bad = false;
      s.lastMail = 0;
    }
  }

  async function checkOnce() {
    const when = new Date().toISOString();

    // 1. Direct request to the site.
    try {
      const site = await checkSite();
      const bad = site.status !== null && site.status >= 500;
      await report('site', bad,
        `ALERT: ${zoneName} returning HTTP ${site.status}`,
        [
          `Site: https://${zoneName}/`,
          `Status: ${site.status === null ? 'no response (' + (site.error || 'unknown') + ')' : site.status}`,
          `Response time: ${site.ms} ms`,
          `Checked at: ${when}`,
        ].join('\n'));
    } catch (err) {
      console.error(`Alert site check failed: ${err.message}`);
    }

    // 2. Edge 5xx served to real visitors, over the last poll window.
    try {
      const zone = await resolveZone();
      const until = new Date();
      const since = new Date(until.getTime() - Math.max(intervalMs, 5 * 60 * 1000));
      const vars = { zone, since: since.toISOString(), until: until.toISOString() };
      let rows;
      if (useGeqFilter) {
        try {
          rows = (await graphql(EDGE_5XX_QUERY, vars)).errors || [];
        } catch (err) {
          useGeqFilter = false;
          console.warn(`edgeResponseStatus_geq filter rejected (${err.message}); using client-side filter.`);
        }
      }
      if (!rows) {
        rows = ((await graphql(EDGE_STATUS_QUERY, vars)).errors || [])
          .filter((r) => Number(r.dimensions.edgeResponseStatus) >= 500);
      }
      const total = rows.reduce((n, r) => n + r.count, 0);
      const detail = rows
        .map((r) => `  ${r.dimensions.edgeResponseStatus}  x${r.count}${r.dimensions.clientRequestPath ? '  ' + r.dimensions.clientRequestPath : ''}`)
        .join('\n');
      await report('edge', total >= threshold,
        `ALERT: ${total} 5xx responses on ${zoneName}`,
        [
          `Zone: ${zoneName}`,
          `Window: ${vars.since} to ${vars.until}`,
          `5xx responses: ${total}`,
          detail ? `\n${detail}` : '',
          `\nDashboard: http://localhost:${Number(env.PORT) || 3000}/`,
        ].join('\n'));
    } catch (err) {
      console.error(`Alert edge check failed: ${err.message}`);
    }
  }

  console.log(`Alerts enabled: 5xx on ${zoneName} -> ${to.join(', ')} (every ${intervalMs / 1000}s)`);
  checkOnce();
  const timer = setInterval(checkOnce, intervalMs);
  timer.unref?.();
  return { enabled: true, checkOnce, state };
}

// `node server.js --test-alert` sends one message to verify SMTP settings.
async function sendTestAlert(env) {
  const to = String(env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length || !env.SMTP_USER || !env.SMTP_PASS) {
    throw new Error('Set ALERT_EMAIL_TO, SMTP_USER and SMTP_PASS in .env first.');
  }
  await sendMail({
    host: env.SMTP_HOST, port: env.SMTP_PORT,
    user: env.SMTP_USER, pass: env.SMTP_PASS,
    from: env.SMTP_FROM || env.SMTP_USER, to,
    subject: `Test alert from cloudflare-monitor (${env.CF_ZONE_NAME || 'site'})`,
    text: `SMTP is configured correctly.\n\nSent at ${new Date().toISOString()}.`,
  });
  console.log(`Test email sent to ${to.join(', ')}`);
}

module.exports = { startAlerts, sendTestAlert };
