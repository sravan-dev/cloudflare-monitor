// Zero-dependency SMTP client (implicit TLS, e.g. smtp.gmail.com:465).
// Speaks just enough SMTP to send a plain-text alert: EHLO, AUTH LOGIN,
// MAIL FROM, RCPT TO, DATA. Gmail requires an app password, not the
// account password.

const tls = require('node:tls');
const os = require('node:os');

function smtpSession(socket) {
  let buffer = '';
  let pending = [];
  const waiters = [];

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    // A reply ends with a line "NNN <text>" (no hyphen after the code).
    while ((idx = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      pending.push(line);
      if (/^\d{3} /.test(line)) {
        const reply = pending.join('\n');
        pending = [];
        const w = waiters.shift();
        if (w) w.resolve(reply);
      }
    }
  });

  function readReply() {
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  async function send(line, expect) {
    if (line !== null) socket.write(line + '\r\n');
    const reply = await readReply();
    const code = Number(reply.slice(0, 3));
    if (expect && !expect.includes(code)) {
      // Never echo the command back — it may contain the base64 password.
      throw new Error(`SMTP error: ${reply.split('\n')[0]}`);
    }
    return reply;
  }

  return { send };
}

// opts: { host, port, user, pass, from, to, subject, text }
function sendMail(opts) {
  const host = opts.host || 'smtp.gmail.com';
  const port = Number(opts.port) || 465;
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, async () => {
      try {
        const { send } = smtpSession(socket);
        await send(null, [220]);                                    // greeting
        await send(`EHLO ${os.hostname() || 'localhost'}`, [250]);
        await send('AUTH LOGIN', [334]);
        await send(Buffer.from(opts.user).toString('base64'), [334]);
        await send(Buffer.from(opts.pass).toString('base64'), [235]);
        await send(`MAIL FROM:<${opts.from}>`, [250]);
        for (const rcpt of to) await send(`RCPT TO:<${rcpt}>`, [250, 251]);
        await send('DATA', [354]);
        socket.write(buildMessage({ ...opts, to }));
        await send('.', [250]);
        await send('QUIT').catch(() => {});
        socket.end();
        resolve();
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });
    socket.setTimeout(30000, () => {
      socket.destroy();
      reject(new Error('SMTP timeout'));
    });
    socket.on('error', reject);
  });
}

function buildMessage({ from, to, subject, text }) {
  const headers = [
    `From: Cloudflare Monitor <${from}>`,
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@cloudflare-monitor>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ].join('\r\n');
  // Dot-stuffing: a line that is just "." would end DATA early.
  const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return `${headers}\r\n\r\n${body}\r\n.\r\n`;
}

module.exports = { sendMail };
