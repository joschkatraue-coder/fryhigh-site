// Fry High — Pommespilot Game Worker (Cloudflare Worker + D1)
//
// Routes (kompatibel zum deployten Stand vom Mai 2026; nur additive Felder):
//   POST /session/start                  → { token, expires_at }
//   POST /score/submit                   → { ok, verify_required, mail_sent, masked_email, rank, total, week_key, display_name_dropped }
//   GET  /verify?t=<token>               → HTML-Bestätigung, Link zurück auf SITE_BASE/spiel?verified=1
//   GET  /leaderboard[?period=all]       → { period, week_key, top: [{ rank, name, score }] }
//   GET  /rank?score=N                   → { rank, total, week_key }   (vorläufiger Platz: bestätigte Scores der Woche > N, plus 1)
//   GET  /vouchers/check?code=…[&pin=…]  → { ok, valid, reason? }; mit Crew-PIN zusätzlich score, week_key, expires_at, label, redeem_location
//   POST /vouchers/redeem                → { ok, redeemed_at }         (PIN)
//   POST /admin/hide-score               → { ok, hidden, changes }     (PIN; { id } oder { name[, week_key] }, optional hidden:false)
//   POST /admin/retry-winner-mail        → { ok, code, masked_email }  (PIN; { wk })
//
// Cron ('0 23 * * SUN' = Montag 01:00 MESZ / 00:00 MEZ):
//   1. Woche einfrieren, Top-1 ermitteln, Gutschein-Code anlegen, Gewinner- und Crew-Mail.
//   2. Aufräumen: Sessions älter als 1 Tag, unbestätigte Scores nach Token-Ablauf, E-Mails alter Einträge anonymisieren.
//
// Env-Vars: siehe wrangler-game.toml. Secrets: RESEND_API_KEY, CREW_PIN, optional MAILERLITE_API_KEY.
// Caveman: ein File, keine Routing-Library. if(path) reicht.

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MS = 60 * 60 * 1000;               // 60 min: lange, ehrliche Läufe dürfen einreichen
const VERIFY_TOKEN_MS = 7 * DAY_MS;              // Magic-Link 7 Tage gültig
const EMAIL_RETENTION_MS = 120 * DAY_MS;         // bestätigte Scores: 30 Tage Gutschein + 90 Tage Rückfragen, dann E-Mail anonymisieren
const VOUCHER_EMAIL_RETENTION_MS = 90 * DAY_MS;  // Gutschein-E-Mail 90 Tage nach Ablauf anonymisieren
// Cron läuft Sonntag 23:00 UTC = Montag 01:00 MESZ / 00:00 MEZ. Vier Stunden zurück liegt in beiden Fällen
// noch am Sonntag (Berlin), auch wenn Cloudflare den Trigger bis zu zwei Stunden verspätet feuert.
const CRON_WEEK_OFFSET_MS = 4 * 60 * 60 * 1000;

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

async function sendMail(env, { to, subject, html: body, reply_to }) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — mail not sent', { to: maskEmail(to), subject });
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

function confirmMailHtml({ name, score, verifyUrl, newsletterOptIn, cfg }) {
  const termsUrl = `${cfg.siteBase}/spiel/teilnahmebedingungen`;
  return `${MAIL_WRAP_OPEN}
    <h2 style="${MAIL_H2}">Score bestätigen</h2>
    <p>Moin${name ? ' ' + escape(name) : ''},</p>
    <p>${score} Punkt${score === 1 ? '' : 'e'}. Nicht schlecht. Damit der Score in die Wochenwertung kommt, klick einmal hier:</p>
    <p style="margin:28px 0">
      <a href="${verifyUrl}"
         style="background:#E94F0E;color:#F5F0E1;text-decoration:none;padding:14px 26px;display:inline-block;
                font-family:Impact,Arial,sans-serif;letter-spacing:1.5px;text-transform:uppercase">
        Score bestätigen →
      </a>
    </p>
    <p>Sonntag 23:59 Uhr ist Schluss. Wer dann oben steht, bekommt ${escape(cfg.label)}, einlösbar ${escape(cfg.redeemLocation)}.
       Die Teilnahmebedingungen stehen hier: <a href="${termsUrl}" style="color:#E94F0E">${termsUrl}</a></p>
    ${newsletterOptIn ? `<p>Du hast den Newsletter angehakt. Mit dem Klick bestätigst du auch den: Karte, Specials, Abende.
       Kann sein, dass unser Newsletter-Tool dich danach noch einmal um ein Ja bittet. Austragen jederzeit per Link.</p>` : ''}
    <p style="font-size:13px;color:#666">Nicht du gewesen? Dann Mail ignorieren, ohne Klick passiert nichts.</p>
    <p style="font-size:11px;color:#888">Falls der Button nicht klickbar ist:<br/><span style="word-break:break-all">${verifyUrl}</span></p>
    ${MAIL_FOOT}
  ${MAIL_WRAP_CLOSE}`;
}

// Gewinner-Mail, genutzt von runWeeklyVoucher und retryWinnerMail.
function winnerMailHtml({ name, score, code, expiresAt, label, valueEur, redeemLocation, opsEmail, siteBase }) {
  const termsUrl = `${siteBase}/spiel/teilnahmebedingungen`;
  return `${MAIL_WRAP_OPEN}
    <h2 style="${MAIL_H2}">Du hast die Woche gewonnen.</h2>
    <p>Moin ${escape(name)},</p>
    <p>${score} Punkte. Diese Woche fliegt keiner höher. Glückwunsch.</p>
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
    <p>Nächste Woche zählt der Zähler wieder von null. Also: weiterfliegen.</p>
    <p>Fragen an <a href="mailto:${escape(opsEmail)}" style="color:#E94F0E">${escape(opsEmail)}</a>.</p>
    ${MAIL_FOOT}
  ${MAIL_WRAP_CLOSE}`;
}

function crewMailHtml({ wk, name, email, score, code, expiresAt, label, valueEur, redeemLocation, winnerMailOk }) {
  return `
    <p>Wochensieger <strong>${escape(wk)}</strong>: ${escape(name)}, ${escape(email)}, ${score} Punkte.</p>
    <p>Code <strong>${code}</strong>, gültig bis ${berlinDate(expiresAt)}.<br/>
       Gewinn: ${escape(label)} (Warenwert bis ${valueEur} €), Einlösung: ${escape(redeemLocation)}.</p>
    <p>Gewinner-Mail: <strong>${winnerMailOk ? 'gesendet' : 'FEHLGESCHLAGEN, bitte manuell anschreiben'}</strong>.</p>
    <p style="font-size:12px;color:#888">Prüfen und einlösen im Crew-Tool unter /crew/vouchers. Retry der Gewinner-Mail: POST /admin/retry-winner-mail mit PIN und wk.</p>
  `;
}

// ─── Route-Handlers ───────────────────────────────────────────────────────

async function sessionStart(request, env, origin) {
  const token = uuid();
  const created = now();
  const expires = created + SESSION_MS;

  await env.DB.prepare(
    'INSERT INTO sessions (token, created_at, expires_at, used) VALUES (?, ?, ?, 0)'
  ).bind(token, created, expires).run();

  return json({ token, expires_at: expires }, 200, origin);
}

async function rankFor(env, wk, score) {
  const row = await env.DB.prepare(
    // P2-12: Bei Gleichstand gewinnt der frueher eingereichte Score, die Rangliste sortiert
    // entsprechend. Mit '>' bekaeme ein neuer Gleichstand Platz N, stuende aber auf N+1.
    `SELECT SUM(CASE WHEN score >= ? THEN 1 ELSE 0 END) AS above, COUNT(*) AS total
     FROM scores WHERE week_key = ? AND verified = 1 AND hidden = 0`
  ).bind(score, wk).first();
  return { rank: Number(row?.above ?? 0) + 1, total: Number(row?.total ?? 0) };
}

async function rank(request, env, origin) {
  const url = new URL(request.url);
  const score = Math.floor(Number(url.searchParams.get('score')));
  if (!Number.isFinite(score) || score < 0) return json({ error: 'invalid score' }, 422, origin);
  const wk = weekKey();
  const r = await rankFor(env, wk, score);
  return json({ ...r, week_key: wk }, 200, origin);
}

async function scoreSubmit(request, env, origin) {
  let data;
  try { data = await request.json(); } catch {
    return json({ error: 'invalid json' }, 400, origin);
  }
  const cfg = prizeConfig(env);

  const token = String(data.token ?? '').trim();
  const email = String(data.email ?? '').trim().toLowerCase().slice(0, 120);
  let displayName = String(data.display_name ?? '').trim().slice(0, 32);
  const score = Math.floor(Number(data.score));
  const durationMs = Math.floor(Number(data.duration_ms));
  const consent = data.consent === true;
  const newsletterOptIn = data.newsletter_opt_in === true;
  // Teilnahme ab 18: Die Bestätigung muss auch bei direkten API-Aufrufen vorliegen.
  const ageConfirmed = data.age_confirmed === true;
  const termsVersion = String(data.terms_version ?? '').trim().slice(0, 32) || cfg.termsVersion;

  if (!token) return json({ error: 'missing session token' }, 422, origin);
  if (!isEmail(email)) return json({ error: 'invalid email' }, 422, origin);
  if (!consent) return json({ error: 'consent required (score-storage)' }, 422, origin);
  if (!ageConfirmed) return json({ error: 'age confirmation required (18+)' }, 422, origin);
  if (!Number.isFinite(score) || score < 0) return json({ error: 'invalid score' }, 422, origin);
  if (!Number.isFinite(durationMs) || durationMs < 0) return json({ error: 'invalid duration' }, 422, origin);

  const hardCap = Number(env.SCORE_HARD_CAP ?? 20000);
  const minDuration = Number(env.MIN_DURATION_MS ?? 5000);
  const maxRate = Number(env.SCORE_PER_SECOND_MAX ?? 40);

  if (score > hardCap) return json({ error: 'score impossible' }, 422, origin);
  if (durationMs < minDuration) return json({ error: 'session too short' }, 422, origin);
  if (score / (durationMs / 1000) > maxRate) {
    return json({ error: 'score/duration implausible' }, 422, origin);
  }

  let displayNameDropped = false;
  if (displayName && !nameAllowed(displayName)) {
    displayName = '';
    displayNameDropped = true;
  }

  const session = await env.DB.prepare(
    'SELECT token, expires_at, used FROM sessions WHERE token = ?'
  ).bind(token).first();
  if (!session) return json({ error: 'invalid session' }, 410, origin);
  if (session.used) return json({ error: 'session already used' }, 410, origin);
  if (session.expires_at < now()) return json({ error: 'session expired' }, 410, origin);

  // P0 fix: atomic conditional UPDATE (was: read-then-update race-window allowing duplicate scores)
  const updateResult = await env.DB.prepare(
    'UPDATE sessions SET used = 1 WHERE token = ? AND used = 0 AND expires_at >= ?'
  ).bind(token, now()).run();

  if (!updateResult.meta || updateResult.meta.changes !== 1) {
    return json({ error: 'session already used or expired' }, 410, origin);
  }

  const id = uuid();
  const verifyToken = uuid();
  const wk = weekKey();
  const created = now();
  const verifyExpiresAt = created + VERIFY_TOKEN_MS;

  await env.DB.prepare(
    `INSERT INTO scores (id, email, display_name, score, duration_ms, verified, verify_token, verify_expires_at,
                         newsletter_opt_in, created_at, week_key, terms_version, terms_accepted_at, age_confirmed, hidden)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, email, displayName || null, score, durationMs, verifyToken, verifyExpiresAt,
         newsletterOptIn ? 1 : 0, created, wk, termsVersion, created, ageConfirmed ? 1 : 0).run();

  // Magic-Link zeigt auf den Worker selbst (VERIFY_BASE), nicht auf die Site: dort gibt es keine /verify-Route.
  const verifyUrl = `${cfg.verifyBase}/verify?t=${verifyToken}`;
  const mailResult = await sendMail(env, {
    to: email,
    subject: `Dein Score beim Pommespilot · ${score} Punkte · bestätigen`,
    html: confirmMailHtml({ name: displayName, score, verifyUrl, newsletterOptIn, cfg }),
  });
  // P1 fix Run-12: persist mail-status; failure visible for crew + retry-eligibility
  await env.DB.prepare('UPDATE scores SET mail_status = ? WHERE id = ?')
    .bind(mailResult.ok ? 'sent' : 'failed', id)
    .run();
  if (!mailResult.ok) {
    console.error('scoreSubmit: verify-mail failed for', maskEmail(email), 'score-id', id, mailResult);
  }

  const provisional = await rankFor(env, wk, score);

  return json({
    ok: true,
    verify_required: true,
    mail_sent: mailResult.ok,
    masked_email: maskEmail(email),
    rank: provisional.rank,
    total: provisional.total,
    week_key: wk,
    display_name_dropped: displayNameDropped,
  }, 200, origin);
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
  const wk = weekKey();

  // period=all: SQLite liefert bei MAX() die übrigen Spalten aus der Zeile mit dem Maximum.
  const query = period === 'all'
    ? `SELECT id, display_name, MAX(score) AS score FROM scores
       WHERE verified = 1 AND hidden = 0
       GROUP BY email
       ORDER BY score DESC
       LIMIT 10`
    : `SELECT id, display_name, score FROM scores
       WHERE week_key = ? AND verified = 1 AND hidden = 0
       ORDER BY score DESC, created_at ASC, id ASC
       LIMIT 10`;

  const stmt = env.DB.prepare(query);
  const { results } = period === 'all' ? await stmt.all() : await stmt.bind(wk).all();

  const top = (results ?? []).map((r, i) => ({
    rank: i + 1,
    name: r.display_name || pilotName(r.id),
    score: r.score,
  }));

  return json({ period, week_key: period === 'week' ? wk : null, top }, 200, origin);
}

async function voucherCheck(request, env, origin) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') ?? '').trim().toUpperCase();
  // P0 fix: crew-PIN required for detailed reasons; unauthenticated gets generic invalid (prevents enumeration-oracle)
  const crewPin = String(url.searchParams.get('pin') ?? '').trim();
  const isCrew = Boolean(crewPin && env.CREW_PIN && crewPin === env.CREW_PIN);
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

  if (pin !== env.CREW_PIN) return json({ ok: false, error: 'wrong pin' }, 401, origin);
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
  const pin = String(data.pin ?? '').trim();
  if (pin !== env.CREW_PIN) return json({ ok: false, error: 'wrong pin' }, 401, origin);

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
  if (!env.CREW_PIN) {
    return json({ ok: false, error: 'crew pin not configured' }, 503, origin);
  }
  let data;
  try { data = await request.json(); } catch {
    return json({ ok: false, error: 'invalid json' }, 400, origin);
  }
  const pin = String(data.pin ?? '').trim();
  const wk = String(data.wk ?? '').trim();

  if (pin !== env.CREW_PIN) return json({ ok: false, error: 'wrong pin' }, 401, origin);
  if (!wk) return json({ ok: false, error: 'no wk' }, 400, origin);

  const voucher = await env.DB.prepare(
    'SELECT code, email, score_id, score, expires_at, label, value_eur, redeem_location FROM vouchers WHERE week_key = ?'
  ).bind(wk).first();
  if (!voucher) return json({ ok: false, error: 'no voucher for week' }, 404, origin);
  if (String(voucher.email).startsWith('anon:')) return json({ ok: false, error: 'email already anonymised' }, 410, origin);

  const scoreRow = await env.DB.prepare(
    'SELECT display_name FROM scores WHERE id = ?'
  ).bind(voucher.score_id).first();

  const cfg = prizeConfig(env);
  const winnerName = (scoreRow && scoreRow.display_name) || pilotName(voucher.score_id);
  const label = voucher.label ?? cfg.label;
  const valueEur = voucher.value_eur ?? cfg.valueEur;
  const redeemLocation = voucher.redeem_location ?? cfg.redeemLocation;

  const mailResult = await sendMail(env, {
    to: voucher.email,
    subject: 'Du hast die Woche gewonnen · Pommespilot',
    html: winnerMailHtml({
      name: winnerName, score: voucher.score, code: voucher.code, expiresAt: voucher.expires_at,
      label, valueEur, redeemLocation, opsEmail: cfg.opsEmail, siteBase: cfg.siteBase,
    }),
  });

  return json({
    ok: mailResult.ok,
    code: voucher.code,
    masked_email: maskEmail(voucher.email),
    mail_result: mailResult,
  }, mailResult.ok ? 200 : 502, origin);
}

// ─── Scheduled (Cron) ─────────────────────────────────────────────────────

async function runWeeklyVoucher(env) {
  if (!contestReady(env)) return;
  // Zielwoche = die Berliner Woche, die gerade zu Ende ging (Offset siehe CRON_WEEK_OFFSET_MS).
  // Achtung bei manuellem Trigger unter der Woche: friert die laufende Woche ein.
  const wk = weekKey(new Date(Date.now() - CRON_WEEK_OFFSET_MS));
  const cfg = prizeConfig(env);

  // P0 fix Run-13: atomic week-freeze BEFORE selecting winner — eliminates cron-vs-verify TOCTOU
  await env.DB.prepare(
    "INSERT INTO weeks (week_key, status) VALUES (?, 'open') ON CONFLICT(week_key) DO NOTHING"
  ).bind(wk).run();
  const freezeResult = await env.DB.prepare(
    "UPDATE weeks SET status = 'frozen', frozen_at = ? WHERE week_key = ? AND status = 'open'"
  ).bind(now(), wk).run();
  if (!freezeResult.meta || freezeResult.meta.changes !== 1) {
    console.log('weekly-voucher: week already frozen/closed, skip', wk);
    return;
  }
  // Ab hier ist die Woche 'frozen'. 'closed' erst nach erfolgreicher Gutschein-Ausgabe; Wochen ohne Gewinner
  // bleiben 'frozen' (für /verify gleichbedeutend mit geschlossen).
  const winner = await env.DB.prepare(
    `SELECT id, email, display_name, score FROM scores
     WHERE week_key = ? AND verified = 1 AND hidden = 0
     ORDER BY score DESC, created_at ASC, id ASC
     LIMIT 1`
  ).bind(wk).first();

  if (!winner) {
    console.log('weekly-voucher: no winner this week', wk);
    return;
  }

  const code = voucherCode();
  const issuedAt = now();
  const expiresAt = issuedAt + cfg.validDays * DAY_MS;

  // P1 fix: idempotent INSERT via UNIQUE(week_key) + ON CONFLICT (was: read-then-insert race)
  const insertResult = await env.DB.prepare(
    `INSERT INTO vouchers (code, email, score_id, score, week_key, issued_at, expires_at, kind, label, value_eur, redeem_location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(week_key) DO NOTHING`
  ).bind(code, winner.email, winner.id, winner.score, wk, issuedAt, expiresAt,
         cfg.kind, cfg.label, cfg.valueEur, cfg.redeemLocation).run();

  if (!insertResult.meta || insertResult.meta.changes !== 1) {
    console.log('weekly-voucher: already issued for', wk, '(conflict on week_key)');
    return;
  }

  const winnerName = winner.display_name || pilotName(winner.id);

  const winnerMailResult = await sendMail(env, {
    to: winner.email,
    subject: 'Du hast die Woche gewonnen · Pommespilot',
    html: winnerMailHtml({
      name: winnerName, score: winner.score, code, expiresAt,
      label: cfg.label, valueEur: cfg.valueEur, redeemLocation: cfg.redeemLocation,
      opsEmail: cfg.opsEmail, siteBase: cfg.siteBase,
    }),
  });
  if (!winnerMailResult.ok) {
    console.error('weekly-voucher: WINNER MAIL FAILED', { wk, code, email: maskEmail(winner.email), result: winnerMailResult });
  }

  const crewMailResult = await sendMail(env, {
    to: cfg.opsEmail,
    subject: `[Pommespilot] Gewinner ${wk} · ${winner.score} Punkte · ${code}${winnerMailResult.ok ? '' : ' · GEWINNER-MAIL FEHLGESCHLAGEN'}`,
    html: crewMailHtml({
      wk, name: winnerName, email: winner.email, score: winner.score, code, expiresAt,
      label: cfg.label, valueEur: cfg.valueEur, redeemLocation: cfg.redeemLocation, winnerMailOk: winnerMailResult.ok,
    }),
  });
  if (!crewMailResult.ok) {
    console.error('weekly-voucher: CREW MAIL FAILED', { wk, code, result: crewMailResult });
  }

  // P0 fix Run-13: mark week as closed after voucher issuance + mails sent
  await env.DB.prepare(
    "UPDATE weeks SET status = 'closed', closed_at = ? WHERE week_key = ?"
  ).bind(now(), wk).run();

  console.log('weekly-voucher issued', { wk, code, score: winner.score });
}

// Aufräum-Job (Datensparsamkeit). Fristen stehen in der Datenschutzerklärung, Abschnitt Mini-Spiel.
async function runCleanup(env) {
  const t = now();
  const sessions = await env.DB.prepare('DELETE FROM sessions WHERE created_at < ?').bind(t - DAY_MS).run();
  const unverified = await env.DB.prepare(
    'DELETE FROM scores WHERE verified = 0 AND verify_expires_at IS NOT NULL AND verify_expires_at < ?'
  ).bind(t).run();
  const scoresAnon = await env.DB.prepare(
    "UPDATE scores SET email = 'anon:' || id WHERE verified = 1 AND created_at < ? AND email NOT LIKE 'anon:%'"
  ).bind(t - EMAIL_RETENTION_MS).run();
  const vouchersAnon = await env.DB.prepare(
    "UPDATE vouchers SET email = 'anon:' || score_id WHERE expires_at < ? AND email NOT LIKE 'anon:%'"
  ).bind(t - VOUCHER_EMAIL_RETENTION_MS).run();
  console.log('cleanup', {
    sessions: sessions.meta?.changes ?? 0,
    unverified: unverified.meta?.changes ?? 0,
    scores_anonymised: scoresAnon.meta?.changes ?? 0,
    vouchers_anonymised: vouchersAnon.meta?.changes ?? 0,
  });
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
      if (!contestReady(env) && (
        (path === '/session/start' && request.method === 'POST') ||
        (path === '/score/submit' && request.method === 'POST') ||
        (path === '/verify' && request.method === 'GET')
      )) {
        if (path === '/verify') return html(verifyPage('Die Wochenwertung ist noch nicht gestartet. Du kannst schon ohne Gewinnwertung spielen.', false, prizeConfig(env).siteBase), 503);
        return json({ ok: false, error: 'contest unavailable' }, 503, origin);
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
      console.error('handler error', path, err);
      return json({ error: 'internal' }, 500, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await runWeeklyVoucher(env); } catch (e) { console.error('weekly-voucher error', e); }
      try { await runCleanup(env); } catch (e) { console.error('cleanup error', e); }
    })());
  },
};
