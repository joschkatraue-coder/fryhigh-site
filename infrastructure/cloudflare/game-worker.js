// Fry High Pommespilot — Cloudflare Worker + D1, 2026-09-16.
// Player API: POST /auth/start, /auth/verify, /auth/logout; GET /auth/me.
// 20-minute one-use magic links; 30-day bearer sessions. Only token hashes are stored.
// Runs: POST /session/start -> token/expires_at, then authenticated POST /score/submit.
// One best score per normalized email/week; exact run retries are idempotent.
// Public: GET /leaderboard[?week_key=YYYY-Www|period=all], GET /rank?score=N.
// Crew: GET /admin/scores; POST /admin/hide-score, /admin/retry-winner-mail.
// Crew credentials use X-Crew-Pin; legacy POST pin remains supported. Never put a PIN in URLs.
// Vouchers: GET /vouchers/check?code=..., POST /vouchers/redeem. Existing voucher codes remain valid.
// Legacy GET /verify?t=... only verifies old score links; new logins use SITE_BASE/spiel#login=... .
// Hourly scheduled(): close only past Berlin weeks, issue the highest eligible score (crypto draw for ties),
// maintain a twelve-calendar-month winner exclusion, safely retry pending mail, then clean up expired data.
// CONTEST_LIVE stays false until deployment, mail and crew readiness have been accepted.
// Secrets: RESEND_API_KEY and CREW_PIN. Optional MAILERLITE_API_KEY is only used by legacy opt-in.
// Tests and rollout preconditions: 50_threads/2026-09-16_fh-minigame-bestenliste/backend/.

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MS = 60 * 60 * 1000;               // 60 min: lange, ehrliche Läufe dürfen einreichen
const EMAIL_RETENTION_MS = 120 * DAY_MS;         // bestätigte Scores: 30 Tage Gutschein + 90 Tage Rückfragen, dann E-Mail anonymisieren
const VOUCHER_EMAIL_RETENTION_MS = 90 * DAY_MS;  // Gutschein-E-Mail 90 Tage nach Ablauf anonymisieren
const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Crew-Pin, Idempotency-Key',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

// ALLOW_ORIGIN ist eine kommagetrennte Liste. Origin-Echo nur bei Treffer, sonst erster Eintrag
// (der Browser blockt die Antwort dann korrekt).
function allowedOrigins(env) {
  return String(env.ALLOW_ORIGIN ?? 'https://fryhigh.de')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveOrigin(request, env) {
  const list = allowedOrigins(env);
  const reqOrigin = request.headers.get('Origin');
  return reqOrigin && list.includes(reqOrigin) ? reqOrigin : list[0];
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS(origin) },
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
const LOGIN_MS = 30 * DAY_MS;
const AUTH_LINK_MS = 20 * 60 * 1000;
const errorJson = (code, status, origin) => json({ ok: false, error: code }, status, origin);
const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
const opaqueToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
const emailKey = (email) => digest(`pommespilot-email-v1:${normalizeEmail(email)}`);

async function limited(env, scope, identity, limit, interval) {
  const start = Math.floor(now() / interval) * interval;
  const key = await digest(`${scope}:${identity}:${start}`);
  const row = await env.DB.prepare(`INSERT INTO request_limits (bucket_key, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET hits = hits + 1 RETURNING hits`).bind(key, start + interval).first();
  return Number(row.hits) > limit;
}
function rateError(origin) {
  const response = errorJson('rate_limited', 429, origin);
  response.headers.set('Retry-After', '900');
  return response;
}
async function playerAuth(request, env) {
  const token = (request.headers.get('Authorization') ?? '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return null;
  const tokenHash = await digest(token);
  const player = await env.DB.prepare(`SELECT p.*, s.expires_at FROM player_sessions s
    JOIN players p ON p.email_key = s.email_key WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(tokenHash, now()).first();
  return player ? { ...player, token_hash: tokenHash } : null;
}
async function publicPlayer(player, env) {
  const history = player.email_key ? await env.DB.prepare('SELECT eligible_after FROM winner_history WHERE email_key = ? AND eligible_after > ?')
    .bind(player.email_key, now()).first() : null;
  return { display_name: player.display_name, masked_email: maskEmail(player.email), eligible_to_win: !history, eligible_after: history?.eligible_after ?? null };
}
async function authStart(request, env, origin) {
  const data = await request.json();
  const email = normalizeEmail(data.email);
  const name = String(data.display_name ?? '').trim();
  if (email.length > 254 || !isEmail(email)) return errorJson('invalid_email', 422, origin);
  if (!/^[\p{L}\p{N} ._'’-]{2,32}$/u.test(name) || !nameAllowed(name)) return errorJson('invalid_name', 422, origin);
  if (data.consent !== true) return errorJson('consent_required', 422, origin);
  if (data.age_confirmed !== true) return errorJson('age_required', 422, origin);
  const cfg = prizeConfig(env);
  if (String(data.terms_version ?? '') !== cfg.termsVersion) return errorJson('terms_changed', 422, origin);
  const key = await emailKey(email);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (await limited(env, 'auth-ip', ip, 30, 60 * 60 * 1000) ||
      await limited(env, 'auth-email', key, 3, 15 * 60 * 1000)) return rateError(origin);
  const token = opaqueToken();
  const tokenHash = await digest(token);
  await env.DB.prepare(`INSERT INTO auth_links (token_hash, email_key, email, display_name, created_at, expires_at, terms_version)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(tokenHash, key, email, name, now(), now() + AUTH_LINK_MS, cfg.termsVersion).run();
  const link = `${cfg.siteBase}/spiel#login=${token}`;
  let result;
  try { result = await sendMail(env, { to: email, subject: 'Beim Pommespilot anmelden · E-Mail bestätigen',
    html: `${MAIL_WRAP_OPEN}<h2 style="${MAIL_H2}">Einmal bestätigen. Dann losfliegen.</h2>
      <p>Moin ${escape(name)},</p><p>Bestätige deine E-Mail-Adresse. Danach bleibt deine Anmeldung auf diesem Gerät 30 Tage gültig.</p>
      <p><a href="${link}">Beim Pommespilot anmelden</a></p>
      <p>Der Link gilt 20 Minuten und nur einmal. Wenn du das nicht angefordert hast, ignoriere diese Mail.</p>${MAIL_FOOT}${MAIL_WRAP_CLOSE}` });
  } catch { result = { ok: false }; }
  await env.DB.prepare('UPDATE auth_links SET mail_status = ? WHERE token_hash = ?').bind(result.ok ? 'sent' : 'failed', tokenHash).run();
  if (!result.ok) return errorJson('mail_unavailable', 503, origin);
  return json({ ok: true, mail_sent: true, masked_email: maskEmail(email) }, 202, origin);
}
async function authVerify(request, env, origin) {
  const data = await request.json();
  const tokenHash = await digest(String(data.token ?? ''));
  const row = await env.DB.prepare('SELECT * FROM auth_links WHERE token_hash = ?').bind(tokenHash).first();
  if (!row || row.expires_at <= now()) return errorJson('auth_link_expired', 410, origin);
  if (row.used_at) return errorJson('auth_link_used', 410, origin);
  if (row.mail_status !== 'sent') return errorJson('auth_link_expired', 410, origin);
  const loginToken = opaqueToken();
  const loginHash = await digest(loginToken);
  const ts = now(); const expires = ts + LOGIN_MS;
  // D1 batch is transactional. Only the first redemption can create a session.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO players (email_key, email, display_name, verified_at, last_login_at, terms_version, terms_accepted_at, age_confirmed)
      SELECT email_key, email, display_name, ?, ?, terms_version, created_at, 1 FROM auth_links
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND mail_status = 'sent'
      ON CONFLICT(email_key) DO UPDATE SET email = excluded.email, display_name = excluded.display_name,
        last_login_at = excluded.last_login_at, terms_version = excluded.terms_version, terms_accepted_at = excluded.terms_accepted_at`)
      .bind(ts, ts, tokenHash, ts),
    env.DB.prepare(`INSERT INTO player_sessions (token_hash, email_key, created_at, expires_at)
      SELECT ?, email_key, ?, ? FROM auth_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND mail_status = 'sent'`)
      .bind(loginHash, ts, expires, tokenHash, ts),
    env.DB.prepare(`UPDATE auth_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL
      AND EXISTS (SELECT 1 FROM player_sessions WHERE token_hash = ?)`).bind(ts, tokenHash, loginHash),
  ]);
  if (results[1].meta?.changes !== 1) return errorJson('auth_link_used', 410, origin);
  const player = await env.DB.prepare('SELECT * FROM players WHERE email_key = ?').bind(row.email_key).first();
  return json({ ok: true, token: loginToken, expires_at: expires, player: await publicPlayer(player, env) }, 200, origin);
}
async function authMe(request, env, origin) {
  const player = await playerAuth(request, env);
  if (!player) return errorJson('auth_invalid', 401, origin);
  return json({ ok: true, expires_at: player.expires_at, player: await publicPlayer(player, env) }, 200, origin);
}
async function authLogout(request, env, origin) {
  const player = await playerAuth(request, env);
  if (player) await env.DB.prepare('DELETE FROM player_sessions WHERE token_hash = ?').bind(player.token_hash).run();
  return json({ ok: true }, 200, origin);
}

async function crewCheck(request, env, origin, legacyPin = '') {
  if (!env.CREW_PIN) return errorJson('crew_unavailable', 503, origin);
  if (await limited(env, 'crew-attempts', request.headers.get('CF-Connecting-IP') ?? 'unknown', 60, 15 * 60 * 1000)) return rateError(origin);
  const supplied = request.headers.get('X-Crew-Pin') ?? String(legacyPin);
  const a = new TextEncoder().encode(supplied); const b = new TextEncoder().encode(String(env.CREW_PIN));
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (diff === 0) return null;
  return errorJson('wrong_pin', 401, origin);
}
async function adminScores(request, env, origin) {
  const denied = await crewCheck(request, env, origin); if (denied) return denied;
  const url = new URL(request.url);
  const wk = url.searchParams.get('week_key') || weekKey(new Date(now()));
  if (!/^\d{4}-W\d{2}$/.test(wk)) return errorJson('invalid_week', 422, origin);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '100') || 100));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0') || 0);
  const { results: rows } = await env.DB.prepare(`SELECT id, email, email_key, display_name, score, created_at, hidden, verified
    FROM scores WHERE week_key = ? ORDER BY score DESC, created_at ASC, id ASC LIMIT ? OFFSET ?`).bind(wk, limit, offset).all();
  const entries = await Promise.all((rows ?? []).map(async r => {
    const eligibility = await publicPlayer(r, env);
    return { id: r.id, email: r.email.startsWith('anon:') ? null : r.email, display_name: r.display_name || pilotName(r.id),
      score: r.score, created_at: r.created_at, hidden: r.hidden, verified: r.verified,
      eligible_to_win: eligibility.eligible_to_win && r.verified === 1 && r.hidden === 0, eligible_after: eligibility.eligible_after };
  }));
  const total = await env.DB.prepare('SELECT COUNT(*) AS total FROM scores WHERE week_key = ?').bind(wk).first();
  const { results: weeks } = await env.DB.prepare(`SELECT week_key, status, frozen_at, closed_at FROM weeks
    UNION SELECT DISTINCT week_key, 'open', NULL, NULL FROM scores WHERE week_key NOT IN (SELECT week_key FROM weeks)
    ORDER BY week_key DESC LIMIT 26`).all();
  const { results: vouchers } = await env.DB.prepare(`SELECT code, score, week_key, issued_at, expires_at, redeemed_at,
    label, value_eur, redeem_location, winner_name, email, winner_mail_status, crew_mail_status,
    winner_mail_first_at, winner_mail_attempt_at FROM vouchers ORDER BY week_key DESC LIMIT 26`).all();
  const visibleVouchers = (vouchers ?? []).map(({email, winner_mail_first_at, winner_mail_attempt_at, ...v}) => ({ ...v,
    winner_email: email.startsWith('anon:') ? null : email,
    winner_mail_retry_safe: !email.startsWith('anon:') && v.expires_at >= now() &&
      (['pending', 'failed'].includes(v.winner_mail_status) ||
       (['uncertain', 'sending'].includes(v.winner_mail_status) && winner_mail_attempt_at <= now() - 60000 && winner_mail_first_at > now() - 23 * 60 * 60 * 1000)) }));
  return json({ ok: true, week_key: wk, total: total.total, entries, weeks, vouchers: visibleVouchers }, 200, origin);
}
// Erst nach vollständiger Mail-/Gutschein-Abnahme aktivieren; der Frontend-Schalter allein schützt die API nicht.
const contestReady = (env) => env.CONTEST_LIVE === 'true' && Boolean(env.RESEND_API_KEY) && Boolean(env.CREW_PIN);

// ─── Zeit: Europe/Berlin ──────────────────────────────────────────────────

const BERLIN_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
});
const BERLIN_DATE = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
});

function berlinYMD(date) {
  const p = {};
  for (const part of BERLIN_YMD.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return p; // { year, month, day }
}

// ISO-Wochenschlüssel "2026-W37" auf Basis des Berliner Kalendertags.
// Wochenrunde = Montag 00:00 bis Sonntag 23:59 Europe/Berlin, in submit, leaderboard, rank und cron identisch.
function weekKey(date = new Date()) {
  const { year, month, day } = berlinYMD(date);
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / DAY_MS) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const berlinDate = (ms) => BERLIN_DATE.format(new Date(ms));

// ─── Namen, Codes ─────────────────────────────────────────────────────────

function maskEmail(email) {
  const [user, dom] = String(email).split('@');
  if (!user || !dom) return '***';
  const head = user.slice(0, Math.min(2, user.length));
  return `${head}${user.length > 2 ? '***' : ''}@${dom}`;
}

// Öffentlicher Fallback-Name ohne Personenbezug: "Pilot #4A2F" aus der Score-ID.
const pilotName = (id) => `Pilot #${String(id).replace(/-/g, '').slice(0, 4).toUpperCase()}`;

// Kurze Blockliste für öffentliche Spitznamen. Treffer: Name wird verworfen, Anzeige "Pilot #XXXX".
// Ceiling: wortgrenzenbasiert, Leetspeak-Umgehung möglich; die Crew zieht per /admin/hide-score nach.
const NAME_BLOCK_RE = /\b(hitler|nazis?|sieg ?heil|hurensohn|hure|fotze|wichser|schwuchtel|nigger|neger|kanake|arschloch|ficke?n?|penis|vagina|pedo|nutte|missgeburt|spasti?|vergewaltig\w*)\b/i;
function nameAllowed(name) {
  // NFKD + \p{M}: Akzente abstreifen (Jörg → jorg), damit Umlaut-Tarnung nicht durchrutscht.
  const n = String(name).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9 ]+/g, ' ');
  return !NAME_BLOCK_RE.test(n);
}

function voucherCode() {
  // FLY-XXXXXXXXXXXXXXXX (16 alphanumerisch, ohne 0/O/1/I-Verwechslung)
  // P0 fix: 16 chars * 32 alphabet = ~80 bits entropy (was 4 chars = ~20 bits, brute-forceable)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'FLY-';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

// Gewinn-Semantik aus Env (Gericht statt Euro-Betrag; VOUCHER_VALUE_EUR ist nur der Warenwert-Deckel).
function prizeConfig(env) {
  return {
    kind: env.VOUCHER_KIND ?? 'meal',
    label: env.VOUCHER_LABEL ?? '15-€-Gutschein für Fry High',
    valueEur: Number.parseInt(env.VOUCHER_VALUE_EUR ?? '15', 10) || 15,
    redeemLocation: env.REDEEM_LOCATION ?? 'Fry High im Zoo am Meer',
    validDays: (() => { const d = Number.parseInt(env.VOUCHER_VALID_DAYS, 10); return Number.isFinite(d) && d > 0 ? d : 30; })(),
    siteBase: env.SITE_BASE ?? env.PUBLIC_BASE ?? 'https://fryhigh.de',
    verifyBase: env.VERIFY_BASE ?? 'https://fryhigh-game.fryhigh-bhv.workers.dev',
    opsEmail: env.TO_EMAIL_OPS ?? 'info@fryhigh.de',
    termsVersion: env.TERMS_VERSION ?? '2026-09-11',
  };
}

// ─── Mail-Helpers ─────────────────────────────────────────────────────────

async function sendMail(env, { to, subject, html: body, reply_to, idempotencyKey }) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — mail not sent', { to: maskEmail(to), subject });
    return { ok: false, mode: 'no-key' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
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
    console.error('resend failed', res.status);
    return { ok: false, status: res.status, uncertain: res.status >= 500 };
  }
  return { ok: true };
}

// Legt den Kontakt bei MailerLite als 'unconfirmed' an, damit MailerLite selbst die Double-Opt-in-Mail schickt.
// Feld laut MailerLite-API "Create/upsert subscriber": status = active | unsubscribed | unconfirmed | bounced | junk.
// Nicht live getestet. Ob MailerLite die Bestätigungsmail für API-Kontakte verschickt, hängt von der Einstellung
// "Double opt-in für API und Integrationen" im MailerLite-Konto ab: <offen: Joschka>.
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
    body: JSON.stringify({ email, groups: [env.MAILERLITE_GROUP_ID], status: 'unconfirmed' }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('mailerlite subscribe failed', res.status, detail);
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

const MAIL_WRAP_OPEN = '<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1A1A1A;line-height:1.5">';
const MAIL_WRAP_CLOSE = '</div>';
const MAIL_H2 = 'font-family:Impact,Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;color:#1A2A4E';
const MAIL_FOOT = `
  <p style="font-size:11px;color:#888;border-top:1px solid #eee;padding-top:12px;margin-top:24px">
    Fry High GbR · H.-H.-Meier-Straße 7 · 27568 Bremerhaven · <a href="mailto:info@fryhigh.de" style="color:#888">info@fryhigh.de</a></p>`;

// Gewinner-Mail, genutzt von runWeeklyVoucher und retryWinnerMail.
function winnerMailHtml({ name, score, code, expiresAt, label, valueEur, redeemLocation, opsEmail, siteBase }) {
  const termsUrl = `${siteBase}/spiel/teilnahmebedingungen`;
  return `${MAIL_WRAP_OPEN}
    <h2 style="${MAIL_H2}">Du hast die Woche gewonnen.</h2>
    <p>Moin ${escape(name)},</p>
    <p>${score} Punkte. Dein Score hat die berechtigte Wochenwertung gewonnen. Bei Punktgleichheit entscheidet das Los. Glückwunsch.</p>
    <p>Dein Gewinn: ${escape(label)}.</p>
    <div style="background:#1A2A4E;color:#F5F0E1;padding:24px;text-align:center;margin:24px 0">
      <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;opacity:0.75">Gutschein-Code</div>
      <div style="font-family:Impact,Arial,sans-serif;font-size:2rem;letter-spacing:3px;margin:8px 0;word-break:break-all">${code}</div>
      <div style="font-family:Arial,sans-serif;font-size:12px;opacity:0.75">Gültig bis ${berlinDate(expiresAt)} · ${escape(redeemLocation)}</div>
    </div>
    <p>Zeig den Code an der Kasse ${escape(redeemLocation)}. Die Crew checkt ihn, du bestellst.
       Gilt einmal, nicht in bar, nicht kombinierbar. Zoo-Eintritt ist nicht dabei.
       Gutscheinwert ${valueEur} €. Alles darüber zahlst du normal, Restbeträge zahlen wir nicht aus.
       Details in den <a href="${termsUrl}" style="color:#E94F0E">Teilnahmebedingungen</a>.</p>
    <p>Du kannst weiterfliegen und in der Bestenliste stehen. Ein weiterer Gewinn mit dieser E-Mail-Adresse ist erst nach zwölf Kalendermonaten möglich.</p>
    <p>Fragen an <a href="mailto:${escape(opsEmail)}" style="color:#E94F0E">${escape(opsEmail)}</a>.</p>
    ${MAIL_FOOT}
  ${MAIL_WRAP_CLOSE}`;
}

function crewMailHtml({ wk, name, email, score, code, expiresAt, label, valueEur, redeemLocation, siteBase }) {
  return `
    <p>Wochensieger <strong>${escape(wk)}</strong>: ${escape(name)}, ${escape(email)}, ${score} Punkte.</p>
    <p>Code <strong>${code}</strong>, gültig bis ${berlinDate(expiresAt)}.<br/>
       Gewinn: ${escape(label)} (Warenwert bis ${valueEur} €), Einlösung: ${escape(redeemLocation)}.</p>
    <p>Den aktuellen Versandstatus der Gewinner-Mail findest du im Crew-Tool.</p>
    <p><a href="${escape(siteBase)}/crew/leaderboard">Bestenliste und Versandstatus prüfen</a> ·
       <a href="${escape(siteBase)}/crew/vouchers">Gutschein prüfen und einlösen</a></p>
  `;
}

// ─── Route-Handlers ───────────────────────────────────────────────────────

async function sessionStart(request, env, origin) {
  const player = await playerAuth(request, env);
  if (request.headers.has('Authorization') && !player) return errorJson('auth_invalid', 401, origin);
  if (await limited(env, 'run-ip', request.headers.get('CF-Connecting-IP') ?? 'unknown', 240, 60 * 60 * 1000)) return rateError(origin);
  const token = opaqueToken(); const created = now(); const expires = created + SESSION_MS;
  await env.DB.prepare(`INSERT INTO sessions (token, created_at, expires_at, used, email_key, week_key)
    VALUES (?, ?, ?, 0, ?, ?)`).bind(await digest(token), created, expires, player?.email_key ?? null, weekKey(new Date(created))).run();
  return json({ token, expires_at: expires }, 200, origin);
}

// Rank deterministically for display. Winner ties are resolved independently by a cryptographic draw.
function rankedScores(weekly = true) {
  return `WITH per_player AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(email_key, lower(trim(email)))
      ORDER BY score DESC, created_at ASC, id ASC) AS personal_rank
    FROM scores WHERE verified = 1 AND hidden = 0 ${weekly ? 'AND week_key = ?' : ''}
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (ORDER BY score DESC, created_at ASC, id ASC) AS rank
    FROM per_player WHERE personal_rank = 1
  )`;
}
async function rankFor(env, wk, score) {
  const row = await env.DB.prepare(`${rankedScores()} SELECT COUNT(*) AS total,
    SUM(CASE WHEN score >= ? THEN 1 ELSE 0 END) AS above FROM ranked`).bind(wk, score).first();
  return { rank: Number(row?.above ?? 0) + 1, total: Number(row?.total ?? 0) };
}
async function rank(request, env, origin) {
  const score = Number(new URL(request.url).searchParams.get('score'));
  if (!Number.isInteger(score) || score < 0) return errorJson('invalid_score', 422, origin);
  const wk = weekKey(new Date(now()));
  return json({ ...await rankFor(env, wk, score), week_key: wk }, 200, origin);
}
async function scoreReceipt(env, player, wk, improved, origin) {
  const row = await env.DB.prepare(`${rankedScores()} SELECT rank, score,
    (SELECT COUNT(*) FROM ranked) AS total FROM ranked WHERE email_key = ?`).bind(wk, player.email_key).first();
  const eligibility = await publicPlayer(player, env);
  return json({ ok: true, rank: row?.rank ?? null, total: row?.total ?? 0, week_key: wk,
    best_score: row?.score ?? null, improved, eligible_to_win: eligibility.eligible_to_win,
    eligible_after: eligibility.eligible_after }, 200, origin);
}
async function scoreSubmit(request, env, origin) {
  const player = await playerAuth(request, env);
  if (!player) return errorJson('auth_required', 401, origin);
  const data = await request.json();
  const score = data.score; const duration = data.duration_ms;
  if (!Number.isInteger(score) || score < 0 || score > Number(env.SCORE_HARD_CAP ?? 20000)) return errorJson('invalid_score', 422, origin);
  if (!Number.isInteger(duration) || duration < 0 || duration > SESSION_MS) return errorJson('invalid_duration', 422, origin);
  const tokenHash = await digest(String(data.token ?? ''));
  const session = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(tokenHash).first();
  if (!session) return errorJson('session_expired', 410, origin);
  if (session.email_key && session.email_key !== player.email_key) return errorJson('run_conflict', 409, origin);
  if (session.used) {
    if (session.email_key === player.email_key && session.submitted_score === score && session.submitted_duration === duration)
      return scoreReceipt(env, player, session.week_key, false, origin);
    return errorJson('run_conflict', 409, origin);
  }
  const ts = now();
  if (session.expires_at <= ts) return errorJson('session_expired', 410, origin);
  if (session.week_key !== weekKey(new Date(ts))) return errorJson('week_closed', 409, origin);
  // 1 second clock/render tolerance; elapsed time is measured from the server-issued run.
  if (duration > ts - session.created_at + 1000 ||
      duration < Number(env.MIN_DURATION_MS ?? 5000) || score / (duration / 1000) > Number(env.SCORE_PER_SECOND_MAX ?? 40))
    return errorJson('score_implausible', 422, origin);
  if (await limited(env, 'score-player', player.email_key, 240, 60 * 60 * 1000)) return rateError(origin);
  const entryKey = `${player.email_key}:${session.week_key}`;
  const entryId = await digest(entryKey);
  const receiptId = uuid();
  // One atomic transaction claims the run, updates the best score and records the receipt.
  // The unique receipt guards the second statement against concurrent submitters.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE sessions SET used = 1, email_key = ?, receipt_id = ?, submitted_score = ?, submitted_duration = ?
      WHERE token = ? AND used = 0 AND expires_at > ? AND (email_key IS NULL OR email_key = ?)
      AND NOT EXISTS (SELECT 1 FROM weeks WHERE week_key = sessions.week_key AND status != 'open')`)
      .bind(player.email_key, receiptId, score, duration, tokenHash, ts, player.email_key),
    env.DB.prepare(`INSERT INTO scores (id, email, display_name, score, duration_ms, verified, verified_at, created_at,
      week_key, terms_version, terms_accepted_at, age_confirmed, hidden, email_key, entry_key, mail_status)
      SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, 0, ?, ?, 'not-required' FROM sessions WHERE token = ? AND receipt_id = ?
      ON CONFLICT(entry_key) DO UPDATE SET score = excluded.score, duration_ms = excluded.duration_ms,
        display_name = excluded.display_name, email = excluded.email, created_at = excluded.created_at
      WHERE excluded.score > scores.score`)
      .bind(entryId, player.email, player.display_name, score, duration, ts, ts, session.week_key,
        player.terms_version, player.terms_accepted_at, player.email_key, entryKey, tokenHash, receiptId),
  ]);
  if (results[0].meta?.changes !== 1) {
    const latest = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(tokenHash).first();
    if (latest?.used && latest.email_key === player.email_key && latest.submitted_score === score && latest.submitted_duration === duration)
      return scoreReceipt(env, player, session.week_key, false, origin);
    if (!latest?.used) return errorJson('week_closed', 409, origin);
    return errorJson('run_conflict', 409, origin);
  }
  return scoreReceipt(env, player, session.week_key, results[1].meta?.changes === 1, origin);
}

async function verify(request, env) {
  const url = new URL(request.url);
  const token = String(url.searchParams.get('t') ?? '').trim();
  const cfg = prizeConfig(env);
  const site = cfg.siteBase;

  if (!token) return html(verifyPage('Den Link kennen wir nicht.', false, site), 400);

  const row = await env.DB.prepare(
    'SELECT id, email, score, verified, week_key, verify_expires_at, newsletter_opt_in FROM scores WHERE verify_token = ?'
  ).bind(token).first();
  if (!row) return html(verifyPage('Den Link kennen wir nicht. Vielleicht ist er älter als 7 Tage. Spiel nochmal, dann kommt ein frischer.', false, site), 404);
  if (row.verified) return html(verifyPage('War schon bestätigt. Alles gut, du stehst in der Wochenwertung.', true, site, row.score), 200);
  // P1 fix: reject expired verify-tokens (7d after submit)
  if (row.verify_expires_at && row.verify_expires_at < now()) {
    return html(verifyPage('Der Link ist abgelaufen (7 Tage). Spiel nochmal, dann kommt ein frischer.', false, site), 410);
  }

  // P0 fix Run-13 (patch): atomic UPDATE only if week is still 'open' (or no weeks-row exists = fresh-week default).
  const verifyResult = await env.DB.prepare(`
    UPDATE scores SET verified = 1, verified_at = ?
    WHERE id = ?
      AND NOT EXISTS (
        SELECT 1 FROM weeks WHERE week_key = scores.week_key AND status != 'open'
      )
  `).bind(now(), row.id).run();

  if (!verifyResult.meta || verifyResult.meta.changes !== 1) {
    return html(verifyPage(
      'Diese Woche ist schon ausgewertet. Spiel nochmal, dann zählt der Score für die neue Woche.',
      false, site
    ), 410);
  }

  // Newsletter: Klick auf den Link ist die Bestätigung der angehakten Einwilligung; Zeitpunkt als Nachweis speichern.
  // MailerLite-Anlage als 'unconfirmed' (fire-and-forget, Score-Verify hat Vorrang).
  if (Number(row.newsletter_opt_in) === 1) {
    try {
      await env.DB.prepare('UPDATE scores SET newsletter_confirmed_at = ? WHERE id = ? AND newsletter_confirmed_at IS NULL')
        .bind(now(), row.id).run();
      await subscribeMailerlite(env, row.email);
    } catch (e) { console.error('newsletter confirm error', e); }
  }

  return html(verifyPage('Score bestätigt. Du stehst in der Wochenwertung.', true, site, row.score), 200);
}

function verifyPage(message, success, siteBase, score) {
  const color = success ? '#1B7E4B' : '#E4326D';
  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>Pommespilot · Bestätigung</title>
<style>
  body { font-family: Georgia, serif; background: #F5F0E1; color: #1A1A1A;
         margin: 0; padding: 64px 24px; text-align: center; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border: 2px solid #1A2A4E;
          padding: 40px 28px; }
  h1 { font-family: Impact, Arial, sans-serif; letter-spacing: 1px; color: ${color};
       margin: 0 0 16px; font-size: 1.5rem; text-transform: uppercase; }
  .score { font-family: Impact, Arial, sans-serif; font-size: 3rem; color: #1A2A4E;
           margin: 12px 0; }
  p { line-height: 1.5; }
  a.btn { display: inline-block; margin-top: 20px; background: #E94F0E; color: #F5F0E1;
          padding: 12px 22px; text-decoration: none; font-family: Impact, Arial, sans-serif;
          letter-spacing: 1.2px; text-transform: uppercase; min-height: 24px; }
  a.btn:focus-visible { outline: 3px solid #1A2A4E; outline-offset: 2px; }
</style></head>
<body><div class="card">
  <h1>${escape(success ? 'Bestätigt.' : 'Hm.')}</h1>
  ${score ? `<div class="score">${score}</div>` : ''}
  <p>${escape(message)}</p>
  <a class="btn" href="${siteBase}/spiel?verified=${success ? 1 : 0}">Zum Spiel</a>
</div></body></html>`;
}

async function leaderboard(request, env, origin) {
  const url = new URL(request.url);
  const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
  const wk = url.searchParams.get('week_key') || weekKey(new Date(now()));
  if (!/^\d{4}-W\d{2}$/.test(wk)) return errorJson('invalid_week', 422, origin);
  const query = env.DB.prepare(`${rankedScores(period !== 'all')} SELECT rank, id, display_name, score,
    (SELECT COUNT(*) FROM ranked) AS total FROM ranked ORDER BY rank LIMIT 10`);
  const { results } = period === 'all' ? await query.all() : await query.bind(wk).all();
  return json({ period, week_key: period === 'week' ? wk : null, contest_live: contestReady(env),
    total: results?.[0]?.total ?? 0,
    top: (results ?? []).map(r => ({ rank: r.rank, name: r.display_name || pilotName(r.id), score: r.score })) }, 200, origin);
}

async function voucherCheck(request, env, origin) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') ?? '').trim().toUpperCase();
  // P0 fix: crew-PIN required for detailed reasons; unauthenticated gets generic invalid (prevents enumeration-oracle)
  const crewPin = request.headers.get('X-Crew-Pin') ?? '';
  const isCrew = Boolean(crewPin);
  if (isCrew) { const denied = await crewCheck(request, env, origin, crewPin); if (denied) return denied; }
  const cfg = prizeConfig(env);

  if (!code) return json({ ok: false, error: 'no code' }, 400, origin);

  const row = await env.DB.prepare(
    'SELECT code, score, week_key, issued_at, expires_at, redeemed_at, redeemed_by_note, label, redeem_location, value_eur FROM vouchers WHERE code = ?'
  ).bind(code).first();

  if (!row) {
    return json({ ok: false, valid: false, reason: isCrew ? 'unknown' : 'invalid' }, 200, origin);
  }
  if (row.redeemed_at) {
    return json({
      ok: false, valid: false, reason: isCrew ? 'redeemed' : 'invalid',
      ...(isCrew ? { redeemed_at: row.redeemed_at, redeemed_by_note: row.redeemed_by_note ?? null } : {}),
    }, 200, origin);
  }
  if (row.expires_at < now()) {
    return json({ ok: false, valid: false, reason: isCrew ? 'expired' : 'invalid', ...(isCrew ? { expires_at: row.expires_at } : {}) }, 200, origin);
  }

  // Crew mit PIN bekommt Details, ohne PIN nur das nackte "valid".
  return json({
    ok: true,
    valid: true,
    ...(isCrew ? {
      score: row.score,
      week_key: row.week_key,
      expires_at: row.expires_at,
      label: row.label ?? cfg.label,
      redeem_location: row.redeem_location ?? cfg.redeemLocation,
      value_eur: row.value_eur ?? cfg.valueEur,
    } : {}),
  }, 200, origin);
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

  const denied = await crewCheck(request, env, origin, pin); if (denied) return denied;
  if (!code) return json({ ok: false, error: 'no code' }, 400, origin);

  // P0 fix: atomic conditional UPDATE (was: read-then-update double-spend race)
  const ts = now();
  const updateResult = await env.DB.prepare(
    'UPDATE vouchers SET redeemed_at = ?, redeemed_by_note = ? WHERE code = ? AND redeemed_at IS NULL AND expires_at >= ?'
  ).bind(ts, note || null, code, ts).run();

  if (!updateResult.meta || updateResult.meta.changes !== 1) {
    const check = await env.DB.prepare('SELECT redeemed_at, expires_at FROM vouchers WHERE code = ?').bind(code).first();
    if (!check) return json({ ok: false, error: 'unknown code' }, 404, origin);
    if (check.redeemed_at) return json({ ok: false, error: 'already redeemed', redeemed_at: check.redeemed_at }, 409, origin);
    if (check.expires_at < now()) return json({ ok: false, error: 'expired' }, 410, origin);
    return json({ ok: false, error: 'redemption failed' }, 500, origin);
  }

  return json({ ok: true, redeemed_at: ts }, 200, origin);
}

// Crew blendet einen Score aus der öffentlichen Rangliste aus (oder wieder ein): { pin, id } oder { pin, name[, week_key] }.
async function hideScore(request, env, origin) {
  if (!env.CREW_PIN) {
    return json({ ok: false, error: 'crew pin not configured' }, 503, origin);
  }
  let data;
  try { data = await request.json(); } catch {
    return json({ ok: false, error: 'invalid json' }, 400, origin);
  }
  const denied = await crewCheck(request, env, origin, data.pin ?? ''); if (denied) return denied;

  const hidden = data.hidden === false ? 0 : 1;
  const id = String(data.id ?? '').trim();
  const name = String(data.name ?? '').trim().slice(0, 32);
  const wk = String(data.week_key ?? '').trim().slice(0, 12);

  let res;
  if (id) {
    res = await env.DB.prepare('UPDATE scores SET hidden = ? WHERE id = ?').bind(hidden, id).run();
  } else if (name && wk) {
    res = await env.DB.prepare('UPDATE scores SET hidden = ? WHERE display_name = ? COLLATE NOCASE AND week_key = ?').bind(hidden, name, wk).run();
  } else if (name) {
    res = await env.DB.prepare('UPDATE scores SET hidden = ? WHERE display_name = ? COLLATE NOCASE').bind(hidden, name).run();
  } else {
    return json({ ok: false, error: 'id or name required' }, 400, origin);
  }
  return json({ ok: true, hidden, changes: res.meta?.changes ?? 0 }, 200, origin);
}

async function retryWinnerMail(request, env, origin) {
  const data = await request.json();
  const denied = await crewCheck(request, env, origin, data.pin ?? ''); if (denied) return denied;
  if (!contestReady(env)) return errorJson('contest_unavailable', 503, origin);
  const wk = String(data.wk ?? '');
  if (!/^\d{4}-W\d{2}$/.test(wk)) return errorJson('invalid_week', 422, origin);
  const voucher = await env.DB.prepare('SELECT * FROM vouchers WHERE week_key = ?').bind(wk).first();
  if (!voucher) return errorJson('voucher_not_found', 404, origin);
  if (voucher.email.startsWith('anon:')) return errorJson('email_anonymised', 410, origin);
  if (voucher.winner_mail_status !== 'sent') await deliverVoucher(env, voucher, 'winner');
  const row = await env.DB.prepare('SELECT winner_mail_status FROM vouchers WHERE code = ?').bind(voucher.code).first();
  const sent = row.winner_mail_status === 'sent';
  return json({ ok: sent, code: voucher.code, masked_email: maskEmail(voucher.email), mail_status: row.winner_mail_status,
    ...(sent ? {} : { error: row.winner_mail_status === 'failed' ? 'mail_unavailable' : 'delivery_uncertain' }) },
    sent ? 200 : row.winner_mail_status === 'failed' ? 503 : 409, origin);
}

// ─── Scheduled (Cron) ─────────────────────────────────────────────────────

const BERLIN_CLOCK = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function berlinParts(ms) {
  return Object.fromEntries(BERLIN_CLOCK.formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
function wallTime(p, millis = 0) { return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, millis); }
function twelveCalendarMonths(ms) {
  const p = berlinParts(ms); p.year += 1;
  p.day = Math.min(p.day, new Date(Date.UTC(p.year, p.month, 0)).getUTCDate());
  const desired = wallTime(p, ms % 1000);
  const offsets = [...new Set([-2 * DAY_MS, 0, 2 * DAY_MS].map(delta => {
    const sample = desired + delta;
    return wallTime(berlinParts(sample), sample % 1000) - sample;
  }))];
  const candidates = offsets.map(offset => desired - offset);
  const exact = candidates.filter(t => wallTime(berlinParts(t), t % 1000) === desired);
  // Calendar arithmetic: Feb 29 clamps to Feb 28; a DST gap moves forward, a fold uses the earlier instant.
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}
function randomIndex(length) {
  const ceiling = 0x100000000 - (0x100000000 % length);
  const values = new Uint32Array(1);
  do { crypto.getRandomValues(values); } while (values[0] >= ceiling);
  return values[0] % length;
}
async function issueWeek(env, wk) {
  if (wk >= weekKey(new Date(now()))) return;
  await env.DB.prepare("INSERT INTO weeks (week_key, status) VALUES (?, 'open') ON CONFLICT DO NOTHING").bind(wk).run();
  await env.DB.prepare("UPDATE weeks SET status = 'frozen', frozen_at = ? WHERE week_key = ? AND status = 'open'").bind(now(), wk).run();
  // A frozen week is recoverable after a crash. The voucher and history are committed together.
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await env.DB.prepare('SELECT code FROM vouchers WHERE week_key = ?').bind(wk).first();
    if (existing) return;
    const ts = now();
    const { results } = await env.DB.prepare(`${rankedScores()} SELECT * FROM ranked
      WHERE email_key IS NOT NULL AND email NOT LIKE 'anon:%'
      AND NOT EXISTS (SELECT 1 FROM winner_history h WHERE h.email_key = ranked.email_key AND h.eligible_after > ?)
      ORDER BY score DESC`).bind(wk, ts).all();
    if (!results?.length) {
      await env.DB.prepare("UPDATE weeks SET status = 'closed', closed_at = ? WHERE week_key = ? AND status = 'frozen'").bind(ts, wk).run();
      return;
    }
    const ties = results.filter(r => r.score === results[0].score);
    const winner = ties[ties.length === 1 ? 0 : randomIndex(ties.length)];
    const code = voucherCode(); const cfg = prizeConfig(env);
    const eligibleAfter = twelveCalendarMonths(ts);
    const batch = await env.DB.batch([
      env.DB.prepare(`INSERT INTO vouchers (code, email, email_key, winner_name, score_id, score, week_key, issued_at,
        expires_at, kind, label, value_eur, redeem_location)
        SELECT ?, s.email, s.email_key, COALESCE(s.display_name, ?), s.id, s.score, ?, ?, ?, ?, ?, ?, ? FROM scores s
        WHERE s.id = ? AND s.hidden = 0 AND s.verified = 1
        AND EXISTS (SELECT 1 FROM weeks WHERE week_key = ? AND status = 'frozen')
        AND NOT EXISTS (SELECT 1 FROM winner_history WHERE email_key = s.email_key AND eligible_after > ?)
        AND NOT EXISTS (SELECT 1 FROM scores higher WHERE higher.week_key = s.week_key AND higher.verified = 1 AND higher.hidden = 0
          AND higher.email_key IS NOT NULL AND higher.email NOT LIKE 'anon:%' AND higher.score > s.score
          AND NOT EXISTS (SELECT 1 FROM winner_history h WHERE h.email_key = higher.email_key AND h.eligible_after > ?))
        ON CONFLICT(week_key) DO NOTHING`)
        .bind(code, pilotName(winner.id), wk, ts, ts + cfg.validDays * DAY_MS, cfg.kind, cfg.label, cfg.valueEur, cfg.redeemLocation,
          winner.id, wk, ts, ts),
      env.DB.prepare(`INSERT INTO winner_history (email_key, week_key, won_at, eligible_after)
        SELECT email_key, week_key, issued_at, ? FROM vouchers WHERE code = ?
        ON CONFLICT(email_key) DO UPDATE SET week_key = excluded.week_key, won_at = excluded.won_at, eligible_after = excluded.eligible_after`)
        .bind(eligibleAfter, code),
      env.DB.prepare(`UPDATE weeks SET status = 'closed', closed_at = ? WHERE week_key = ?
        AND EXISTS (SELECT 1 FROM vouchers WHERE week_key = ?)`)
        .bind(ts, wk, wk),
    ]);
    if (batch[0].meta?.changes === 1) return;
    // Another week may just have won with this email, or moderation changed eligibility. Re-evaluate.
  }
  throw new Error('weekly winner changed repeatedly; frozen week retained for retry');
}
async function deliverVoucher(env, voucher, kind) {
  const prefix = kind === 'winner' ? 'winner_mail' : 'crew_mail';
  const ts = now();
  if (voucher.email.startsWith('anon:') || voucher.expires_at < ts) return;
  const claim = await env.DB.prepare(`UPDATE vouchers SET ${prefix}_status = 'sending',
    ${prefix}_first_at = COALESCE(${prefix}_first_at, ?), ${prefix}_attempt_at = ? WHERE code = ? AND (
      ${prefix}_status IN ('pending', 'failed') OR
      (${prefix}_status IN ('sending', 'uncertain') AND ${prefix}_attempt_at <= ? AND ${prefix}_first_at > ?)
    )`).bind(ts, ts, voucher.code, ts - 60000, ts - 23 * 60 * 60 * 1000).run();
  if (claim.meta?.changes !== 1) return;
  const cfg = prizeConfig(env);
  const common = { name: voucher.winner_name || pilotName(voucher.score_id), score: voucher.score, code: voucher.code,
    expiresAt: voucher.expires_at, label: voucher.label ?? cfg.label, valueEur: voucher.value_eur ?? cfg.valueEur,
    redeemLocation: voucher.redeem_location ?? cfg.redeemLocation, opsEmail: cfg.opsEmail, siteBase: cfg.siteBase };
  let result;
  try {
    result = await sendMail(env, {
      to: kind === 'winner' ? voucher.email : cfg.opsEmail,
      subject: kind === 'winner' ? 'Du hast die Woche gewonnen · Pommespilot' : `[Pommespilot] Gewinner ${voucher.week_key} · ${voucher.score} Punkte · ${voucher.code}`,
      html: kind === 'winner' ? winnerMailHtml(common) : crewMailHtml({ ...common, wk: voucher.week_key, email: voucher.email }),
      idempotencyKey: `pommespilot-${kind}-${voucher.code}`,
    });
  } catch { result = { ok: false, uncertain: true }; }
  await env.DB.prepare(`UPDATE vouchers SET ${prefix}_status = ?, ${prefix}_sent_at = ? WHERE code = ? AND ${prefix}_attempt_at = ?`)
    .bind(result.ok ? 'sent' : result.uncertain ? 'uncertain' : 'failed', result.ok ? ts : null, voucher.code, ts).run();
}
async function runWeeklyVoucher(env) {
  if (!contestReady(env)) return;
  // A crashed attempt beyond the safe provider retry window needs operator review.
  await env.DB.batch(['winner_mail', 'crew_mail'].map(prefix => env.DB.prepare(`UPDATE vouchers SET ${prefix}_status = 'uncertain'
    WHERE ${prefix}_status = 'sending' AND ${prefix}_first_at <= ? AND ${prefix}_attempt_at <= ?`)
    .bind(now() - 23 * 60 * 60 * 1000, now() - 60000)));
  const current = weekKey(new Date(now()));
  const p = berlinYMD(new Date(now()));
  const previous = weekKey(new Date(Date.UTC(p.year, p.month - 1, p.day - 7, 12)));
  await env.DB.prepare("INSERT INTO weeks (week_key, status) VALUES (?, 'open') ON CONFLICT DO NOTHING").bind(previous).run();
  const { results: weeks } = await env.DB.prepare(`SELECT week_key FROM weeks WHERE week_key < ? AND status != 'closed'
    UNION SELECT DISTINCT week_key FROM scores WHERE week_key < ? AND week_key NOT IN (SELECT week_key FROM weeks WHERE status = 'closed')
    ORDER BY week_key ASC`).bind(current, current).all();
  for (const row of weeks ?? []) await issueWeek(env, row.week_key);
  const { results: pending } = await env.DB.prepare(`SELECT * FROM vouchers WHERE expires_at >= ?
    AND (winner_mail_status != 'sent' OR crew_mail_status != 'sent')`).bind(now()).all();
  for (const voucher of pending ?? []) {
    await deliverVoucher(env, voucher, 'winner');
    await deliverVoucher(env, voucher, 'crew');
  }
}

// Cleanup remains active while prize issuance is disabled. No raw IP is stored.
async function runCleanup(env) {
  const ts = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE created_at < ?').bind(ts - DAY_MS),
    env.DB.prepare('DELETE FROM auth_links WHERE expires_at <= ? OR used_at IS NOT NULL').bind(ts),
    env.DB.prepare('DELETE FROM player_sessions WHERE expires_at <= ?').bind(ts),
    env.DB.prepare('DELETE FROM players WHERE last_login_at <= ?').bind(ts - EMAIL_RETENTION_MS),
    env.DB.prepare('DELETE FROM request_limits WHERE expires_at <= ?').bind(ts),
    env.DB.prepare('DELETE FROM winner_history WHERE eligible_after <= ?').bind(ts),
    env.DB.prepare('DELETE FROM scores WHERE verified = 0 AND verify_expires_at IS NOT NULL AND verify_expires_at < ?').bind(ts),
    env.DB.prepare("UPDATE scores SET email = 'anon:' || id WHERE verified = 1 AND created_at < ? AND email NOT LIKE 'anon:%'").bind(ts - EMAIL_RETENTION_MS),
    env.DB.prepare("UPDATE vouchers SET email = 'anon:' || score_id, email_key = NULL WHERE expires_at < ? AND email NOT LIKE 'anon:%'").bind(ts - VOUCHER_EMAIL_RETENTION_MS),
  ]);
}

// ─── Main ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = resolveOrigin(request, env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS(origin) });
    }

    try {
      if (request.method === 'POST') {
        const requestOrigin = request.headers.get('Origin');
        if (requestOrigin && !allowedOrigins(env).includes(requestOrigin)) return errorJson('origin_not_allowed', 403, origin);
        if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return errorJson('invalid_json', 400, origin);
        if (Number(request.headers.get('Content-Length') ?? '0') > 8192) return errorJson('request_too_large', 413, origin);
        const bytes = new Uint8Array(8192); let length = 0;
        const reader = request.body?.getReader();
        if (reader) while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (length + value.length > bytes.length) { await reader.cancel(); return errorJson('request_too_large', 413, origin); }
          bytes.set(value, length); length += value.length;
        }
        const raw = new TextDecoder().decode(bytes.subarray(0, length));
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) return errorJson('invalid_json', 400, origin);
        request = new Request(request.url, { method: request.method, headers: request.headers, body: raw });
      }
      if (['/auth/start', '/auth/verify'].includes(path) && request.method === 'POST') {
        if (env.CONTEST_LIVE !== 'true' || !env.CREW_PIN) return errorJson('contest_unavailable', 503, origin);
        if (!env.RESEND_API_KEY) return errorJson('mail_unavailable', 503, origin);
      }
      if (path === '/auth/start' && request.method === 'POST') return await authStart(request, env, origin);
      if (path === '/auth/verify' && request.method === 'POST') return await authVerify(request, env, origin);
      if (path === '/auth/me' && request.method === 'GET') return await authMe(request, env, origin);
      if (path === '/auth/logout' && request.method === 'POST') return await authLogout(request, env, origin);
      if (path === '/admin/scores' && request.method === 'GET') return await adminScores(request, env, origin);
      if (!contestReady(env) && (
        (path === '/session/start' && request.method === 'POST') ||
        (path === '/score/submit' && request.method === 'POST') ||
        (path === '/verify' && request.method === 'GET')
      )) {
        if (path === '/verify') return html(verifyPage('Die Wochenwertung ist noch nicht gestartet. Du kannst schon ohne Gewinnwertung spielen.', false, prizeConfig(env).siteBase), 503);
        return errorJson('contest_unavailable', 503, origin);
      }
      if (path === '/session/start' && request.method === 'POST') return await sessionStart(request, env, origin);
      if (path === '/score/submit' && request.method === 'POST')  return await scoreSubmit(request, env, origin);
      if (path === '/verify' && request.method === 'GET')         return await verify(request, env);
      if (path === '/leaderboard' && request.method === 'GET')    return await leaderboard(request, env, origin);
      if (path === '/rank' && request.method === 'GET')           return await rank(request, env, origin);
      if (path === '/vouchers/check' && request.method === 'GET') return await voucherCheck(request, env, origin);
      if (path === '/vouchers/redeem' && request.method === 'POST') return await voucherRedeem(request, env, origin);
      if (path === '/admin/hide-score' && request.method === 'POST') return await hideScore(request, env, origin);
      if (path === '/admin/retry-winner-mail' && request.method === 'POST') return await retryWinnerMail(request, env, origin);
    } catch (err) {
      if (err instanceof SyntaxError) return errorJson('invalid_json', 400, origin);
      console.error('handler error', path, err);
      return errorJson('internal', 500, origin);
    }

    return errorJson('not_found', 404, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await runWeeklyVoucher(env); } catch (e) { console.error('weekly-voucher error', e); }
      try { await runCleanup(env); } catch (e) { console.error('cleanup error', e); }
    })());
  },
};
