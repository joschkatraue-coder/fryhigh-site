// Fry High — Pilot-Flight Game Worker
//
// Routes:
//   POST /session/start                  → { token, expires_at }
//   POST /score/submit                   → { ok, verify_required: true }   (sendet Magic-Link-Mail)
//   GET  /verify?t=<token>               → HTML-Bestätigung (oder Redirect zu /spiel?verified=1)
//   GET  /leaderboard[?period=all]       → { period, top: [{ rank, name, score }] }
//   GET  /vouchers/check?code=…          → { ok, valid, score, expires_at }       (Crew-Tool, public)
//   POST /vouchers/redeem                → { ok, redeemed_at }                    (Crew-Tool, PIN-gated)
//
// Cron (Sonntag 22:00 UTC):
//   → Ermittelt Top-1 dieser Woche, generiert Voucher-Code, sendet Mail an Gewinner, Notification an Crew.
//
// Caveman: ein File, keine Routing-Library. switch(pathname) reicht.

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS(origin) },
  });

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const uuid = () => crypto.randomUUID();
const now = () => Date.now();

// ISO-Week-Key, z. B. "2026-W20" — basiert auf Berlin-Time (Europe/Berlin)
function weekKey(date = new Date()) {
  // Berlin = UTC + 1 (Winter) oder + 2 (Sommer). Für Wochen-Boundary reicht UTC-basierter ISO-Calc:
  // Die paar Stunden Drift kosten in Edge-Fällen 1 Woche — bei "Sonntag-23:00-Score" ist Cron eh schon gelaufen.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function maskEmail(email) {
  const [user, dom] = String(email).split('@');
  if (!user || !dom) return '***';
  const head = user.slice(0, Math.min(2, user.length));
  return `${head}${user.length > 2 ? '***' : ''}@${dom}`;
}

function voucherCode() {
  // FLY-XXXX (4 alphanumerisch, ohne 0/O/1/I-Verwechslung)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'FLY-';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

async function hashIp(ip) {
  if (!ip) return null;
  const data = new TextEncoder().encode(ip + '|fryhigh-2026');
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Mail-Helpers ─────────────────────────────────────────────────────────

async function sendMail(env, { to, subject, html: body, reply_to }) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — mail not sent', { to, subject });
    return { ok: false, mode: 'no-key' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL ?? 'spiel@fryhigh.de',
      to,
      reply_to,
      subject,
      html: body,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('resend failed', res.status, detail);
    return { ok: false, status: res.status, detail };
  }
  return { ok: true };
}

async function subscribeMailerlite(env, email) {
  if (!env.MAILERLITE_API_KEY || !env.MAILERLITE_GROUP_ID) {
    console.warn('mailerlite skipped (key or group_id missing)');
    return { ok: false, mode: 'skipped' };
  }
  const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MAILERLITE_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ email, groups: [env.MAILERLITE_GROUP_ID] }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('mailerlite subscribe failed', res.status, detail);
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

// ─── Route-Handlers ───────────────────────────────────────────────────────

async function sessionStart(request, env, origin) {
  const token = uuid();
  const created = now();
  const expires = created + 10 * 60 * 1000; // 10 min
  const ip = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For');
  const ipHash = await hashIp(ip);

  await env.DB.prepare(
    'INSERT INTO sessions (token, created_at, expires_at, used, ip_hash) VALUES (?, ?, ?, 0, ?)'
  ).bind(token, created, expires, ipHash).run();

  return json({ token, expires_at: expires }, 200, origin);
}

async function scoreSubmit(request, env, origin) {
  let data;
  try { data = await request.json(); } catch {
    return json({ error: 'invalid json' }, 400, origin);
  }

  const token = String(data.token ?? '').trim();
  const email = String(data.email ?? '').trim().toLowerCase().slice(0, 120);
  const displayName = String(data.display_name ?? '').trim().slice(0, 32);
  const score = Math.floor(Number(data.score));
  const durationMs = Math.floor(Number(data.duration_ms));
  const consent = data.consent === true;

  if (!token) return json({ error: 'missing session token' }, 422, origin);
  if (!isEmail(email)) return json({ error: 'invalid email' }, 422, origin);
  if (!consent) return json({ error: 'consent required (newsletter + score-storage)' }, 422, origin);
  if (!Number.isFinite(score) || score < 0) return json({ error: 'invalid score' }, 422, origin);
  if (!Number.isFinite(durationMs) || durationMs < 0) return json({ error: 'invalid duration' }, 422, origin);

  const hardCap = Number(env.SCORE_HARD_CAP ?? 99999);
  const minDuration = Number(env.MIN_DURATION_MS ?? 5000);
  const maxRate = Number(env.SCORE_PER_SECOND_MAX ?? 5);

  if (score > hardCap) return json({ error: 'score impossible' }, 422, origin);
  if (durationMs < minDuration) return json({ error: 'session too short' }, 422, origin);
  if (score / (durationMs / 1000) > maxRate) {
    return json({ error: 'score/duration implausible' }, 422, origin);
  }

  const session = await env.DB.prepare(
    'SELECT token, expires_at, used FROM sessions WHERE token = ?'
  ).bind(token).first();
  if (!session) return json({ error: 'invalid session' }, 410, origin);
  if (session.used) return json({ error: 'session already used' }, 410, origin);
  if (session.expires_at < now()) return json({ error: 'session expired' }, 410, origin);

  await env.DB.prepare('UPDATE sessions SET used = 1 WHERE token = ?').bind(token).run();

  const id = uuid();
  const verifyToken = uuid();
  const wk = weekKey();
  const created = now();

  await env.DB.prepare(
    `INSERT INTO scores (id, email, display_name, score, duration_ms, verified, verify_token, created_at, week_key)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).bind(id, email, displayName || null, score, durationMs, verifyToken, created, wk).run();

  const verifyUrl = `${request.url.split('/score/submit')[0]}/verify?t=${verifyToken}`;
  const mailHtml = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1A1A1A">
      <h2 style="font-family:'Impact',Arial,sans-serif;letter-spacing:1px;color:#1A2A4E">Bestätige deinen Highscore</h2>
      <p>Hi${displayName ? ' ' + escape(displayName) : ''},</p>
      <p>Du hast bei <strong>Pilot Flight</strong> auf fryhigh.de
         <strong>${score} Punkt${score === 1 ? '' : 'e'}</strong> erreicht. Damit dein Score in die
         Wochen-Wertung kommt, klick einmal auf den Button — gleichzeitig trägst du dich für unsere
         Wochen-Mail ein (Highscore, neue Kreationen, Specials).</p>
      <p style="margin:32px 0">
        <a href="${verifyUrl}"
           style="background:#E94F0E;color:#F5F0E1;text-decoration:none;padding:14px 26px;
                  font-family:'Impact',Arial,sans-serif;letter-spacing:1.5px;text-transform:uppercase">
          Score bestätigen →
        </a>
      </p>
      <p style="font-size:13px;color:#666">
        Der Top-1 der Woche kriegt am Sonntag-Abend einen
        <strong>${env.VOUCHER_VALUE_EUR ?? 20} € Gutschein</strong> per Mail, einlösbar im Truck,
        gültig ${env.VOUCHER_VALID_DAYS ?? 30} Tage.
        Du kannst dich jederzeit aus dem Verteiler austragen — Link in jeder Mail.</p>
      <p style="font-size:11px;color:#888;border-top:1px solid #eee;padding-top:12px">
        Falls der Button nicht klickbar ist:<br/>
        <span style="word-break:break-all">${verifyUrl}</span></p>
      <p style="font-size:11px;color:#888">
        Wenn du dich nicht für dieses Spiel angemeldet hast, kannst du diese Mail ignorieren —
        ohne Klick passiert nichts.</p>
    </div>
  `;

  await sendMail(env, {
    to: email,
    subject: `Highscore bestätigen · ${score} Punkte · Pilot Flight`,
    html: mailHtml,
  });

  return json({ ok: true, verify_required: true, masked_email: maskEmail(email) }, 200, origin);
}

async function verify(request, env) {
  const url = new URL(request.url);
  const token = String(url.searchParams.get('t') ?? '').trim();
  const publicBase = env.PUBLIC_BASE ?? 'https://fryhigh.de';

  if (!token) return html(verifyPage('Ungültiger Bestätigungs-Link.', false, publicBase), 400);

  const row = await env.DB.prepare(
    'SELECT id, email, score, verified, week_key FROM scores WHERE verify_token = ?'
  ).bind(token).first();
  if (!row) return html(verifyPage('Bestätigungs-Link unbekannt oder abgelaufen.', false, publicBase), 404);
  if (row.verified) return html(verifyPage('Score war schon bestätigt — alles gut. Viel Glück bei der Wochen-Wertung.', true, publicBase, row.score), 200);

  await env.DB.prepare(
    'UPDATE scores SET verified = 1, verified_at = ? WHERE id = ?'
  ).bind(now(), row.id).run();

  // Mailerlite-Opt-In (fire-and-forget — Score-Verify ist Vorrang)
  try { await subscribeMailerlite(env, row.email); } catch (e) { console.error('ml subscribe error', e); }

  return html(verifyPage('Score bestätigt. Du bist in der Wochen-Wertung.', true, publicBase, row.score), 200);
}

function verifyPage(message, success, publicBase, score) {
  const color = success ? '#1B7E4B' : '#E4326D';
  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pilot Flight · Bestätigung</title>
<style>
  body { font-family: Georgia, serif; background: #F5F0E1; color: #1A1A1A;
         margin: 0; padding: 64px 24px; text-align: center; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border: 2px solid #1A2A4E;
          padding: 40px 28px; }
  h1 { font-family: 'Impact', Arial, sans-serif; letter-spacing: 1px; color: ${color};
       margin: 0 0 16px; font-size: 1.5rem; text-transform: uppercase; }
  .score { font-family: 'Impact', Arial, sans-serif; font-size: 3rem; color: #1A2A4E;
           margin: 12px 0; }
  p { line-height: 1.5; }
  a.btn { display: inline-block; margin-top: 20px; background: #E94F0E; color: #F5F0E1;
          padding: 12px 22px; text-decoration: none; font-family: 'Impact', Arial, sans-serif;
          letter-spacing: 1.2px; text-transform: uppercase; }
</style></head>
<body><div class="card">
  <h1>${escape(success ? 'Bestätigt' : 'Hm.')}</h1>
  ${score ? `<div class="score">${score}</div>` : ''}
  <p>${escape(message)}</p>
  <a class="btn" href="${publicBase}/spiel?verified=${success ? 1 : 0}">Zum Spiel</a>
</div></body></html>`;
}

async function leaderboard(request, env, origin) {
  const url = new URL(request.url);
  const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
  const wk = weekKey();

  const query = period === 'all'
    ? `SELECT email, display_name, MAX(score) AS score FROM scores
       WHERE verified = 1
       GROUP BY email
       ORDER BY score DESC
       LIMIT 10`
    : `SELECT email, display_name, score FROM scores
       WHERE week_key = ? AND verified = 1
       ORDER BY score DESC, created_at ASC
       LIMIT 10`;

  const stmt = env.DB.prepare(query);
  const { results } = period === 'all' ? await stmt.all() : await stmt.bind(wk).all();

  const top = (results ?? []).map((r, i) => ({
    rank: i + 1,
    name: r.display_name || maskEmail(r.email),
    score: r.score,
  }));

  return json({ period, week_key: period === 'week' ? wk : null, top }, 200, origin);
}

async function voucherCheck(request, env, origin) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') ?? '').trim().toUpperCase();
  if (!code) return json({ ok: false, error: 'no code' }, 400, origin);

  const row = await env.DB.prepare(
    'SELECT code, score, week_key, issued_at, expires_at, redeemed_at FROM vouchers WHERE code = ?'
  ).bind(code).first();

  if (!row) return json({ ok: false, valid: false, reason: 'unknown' }, 200, origin);
  if (row.redeemed_at) return json({ ok: false, valid: false, reason: 'redeemed', redeemed_at: row.redeemed_at }, 200, origin);
  if (row.expires_at < now()) return json({ ok: false, valid: false, reason: 'expired' }, 200, origin);

  return json({ ok: true, valid: true, score: row.score, week_key: row.week_key, expires_at: row.expires_at }, 200, origin);
}

async function voucherRedeem(request, env, origin) {
  if (!env.CREW_PIN) {
    return json({ ok: false, error: 'crew pin not configured' }, 503, origin);
  }
  let data;
  try { data = await request.json(); } catch {
    return json({ ok: false, error: 'invalid json' }, 400, origin);
  }
  const pin = String(data.pin ?? '').trim();
  const code = String(data.code ?? '').trim().toUpperCase();
  const note = String(data.note ?? '').trim().slice(0, 120);

  if (pin !== env.CREW_PIN) return json({ ok: false, error: 'wrong pin' }, 401, origin);
  if (!code) return json({ ok: false, error: 'no code' }, 400, origin);

  const row = await env.DB.prepare(
    'SELECT code, expires_at, redeemed_at FROM vouchers WHERE code = ?'
  ).bind(code).first();
  if (!row) return json({ ok: false, error: 'unknown code' }, 404, origin);
  if (row.redeemed_at) return json({ ok: false, error: 'already redeemed', redeemed_at: row.redeemed_at }, 409, origin);
  if (row.expires_at < now()) return json({ ok: false, error: 'expired' }, 410, origin);

  const ts = now();
  await env.DB.prepare(
    'UPDATE vouchers SET redeemed_at = ?, redeemed_by_note = ? WHERE code = ?'
  ).bind(ts, note || null, code).run();

  return json({ ok: true, redeemed_at: ts }, 200, origin);
}

// ─── Scheduled (Cron) ─────────────────────────────────────────────────────

async function runWeeklyVoucher(env) {
  const wk = weekKey();
  const winner = await env.DB.prepare(
    `SELECT id, email, display_name, score FROM scores
     WHERE week_key = ? AND verified = 1
     ORDER BY score DESC, created_at ASC
     LIMIT 1`
  ).bind(wk).first();

  if (!winner) {
    console.log('weekly-voucher: no winner this week', wk);
    return;
  }

  // Doppel-Voucher-Schutz: pro Woche nur einen Voucher ausstellen
  const existing = await env.DB.prepare(
    'SELECT code FROM vouchers WHERE week_key = ? LIMIT 1'
  ).bind(wk).first();
  if (existing) {
    console.log('weekly-voucher: voucher already exists for', wk, existing.code);
    return;
  }

  const code = voucherCode();
  const issuedAt = now();
  const validDays = Number(env.VOUCHER_VALID_DAYS ?? 30);
  const expiresAt = issuedAt + validDays * 24 * 60 * 60 * 1000;
  const value = env.VOUCHER_VALUE_EUR ?? '20';

  await env.DB.prepare(
    `INSERT INTO vouchers (code, email, score_id, score, week_key, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(code, winner.email, winner.id, winner.score, wk, issuedAt, expiresAt).run();

  const winnerName = winner.display_name || 'Pilotin · Pilot';
  const winnerHtml = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1A1A1A">
      <h2 style="font-family:'Impact',Arial,sans-serif;letter-spacing:1px;color:#1A2A4E">
        Du hast die Woche gewonnen.</h2>
      <p>Hi ${escape(winnerName)},</p>
      <p>Dein Score von <strong>${winner.score} Punkten</strong> bei Pilot Flight ist diese Woche
         die Nummer eins. Glückwunsch.</p>
      <p>Hier ist dein Gutschein:</p>
      <div style="background:#1A2A4E;color:#F5F0E1;padding:24px;text-align:center;margin:24px 0">
        <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;opacity:0.7">Voucher · ${value} €</div>
        <div style="font-family:'Impact',Arial,sans-serif;font-size:2.2rem;letter-spacing:4px;margin:8px 0">${code}</div>
        <div style="font-family:Arial,sans-serif;font-size:12px;opacity:0.7">Gültig ${validDays} Tage · einlösbar im Truck oder Zoo am Meer</div>
      </div>
      <p>Einfach im Truck zeigen — Crew checkt den Code und du kriegst <strong>${value} €</strong> rabattiert.
         Nicht kombinierbar mit anderen Aktionen, nicht in bar auszahlbar.</p>
      <p>Nächste Woche läuft das Spiel weiter — also: dranbleiben.</p>
      <p style="font-size:11px;color:#888;border-top:1px solid #eee;padding-top:12px;margin-top:24px">
        Fragen? Schreib uns an <a href="mailto:${escape(env.TO_EMAIL_OPS ?? 'info@fryhigh.de')}">${escape(env.TO_EMAIL_OPS ?? 'info@fryhigh.de')}</a>.</p>
    </div>
  `;

  await sendMail(env, {
    to: winner.email,
    subject: `Du hast gewonnen · ${value} € Gutschein · ${code}`,
    html: winnerHtml,
  });

  // Crew-Notification
  await sendMail(env, {
    to: env.TO_EMAIL_OPS ?? 'info@fryhigh.de',
    subject: `[Pilot Flight] Wochen-Gewinner ${wk} · ${winner.score} Pkt · ${code}`,
    html: `
      <p>Wochen-Sieger <strong>${wk}</strong>:</p>
      <ul>
        <li>E-Mail: ${escape(winner.email)}</li>
        <li>Display-Name: ${escape(winnerName)}</li>
        <li>Score: ${winner.score}</li>
        <li>Voucher: <strong>${code}</strong> (gültig ${validDays} Tage, ${value} €)</li>
      </ul>
      <p>Voucher-Mail wurde gerade an Gewinner versendet.</p>
    `,
  });

  console.log('weekly-voucher issued', { wk, code, score: winner.score });
}

// ─── Main ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN ?? 'https://fryhigh.de';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS(origin) });
    }

    try {
      if (path === '/session/start' && request.method === 'POST') return sessionStart(request, env, origin);
      if (path === '/score/submit' && request.method === 'POST')  return scoreSubmit(request, env, origin);
      if (path === '/verify' && request.method === 'GET')         return verify(request, env);
      if (path === '/leaderboard' && request.method === 'GET')    return leaderboard(request, env, origin);
      if (path === '/vouchers/check' && request.method === 'GET') return voucherCheck(request, env, origin);
      if (path === '/vouchers/redeem' && request.method === 'POST') return voucherRedeem(request, env, origin);
    } catch (err) {
      console.error('handler error', path, err);
      return json({ error: 'internal' }, 500, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWeeklyVoucher(env));
  },
};
