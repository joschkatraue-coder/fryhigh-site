// Fry High — Table-Reservation Worker
// Empfängt POST von fryhigh.de Tisch-Reservierungs-Form, sendet Mail via Resend an info@fryhigh.de.
//
// Deploy:  wrangler deploy --config wrangler-table.toml
// Secrets: wrangler secret put RESEND_API_KEY --config wrangler-table.toml
//
// Env-Vars (in wrangler-table.toml [vars]):
//   FROM_EMAIL   = "tisch-form@fryhigh.de"
//   TO_EMAIL     = "info@fryhigh.de"
//   ALLOW_ORIGIN = "https://fryhigh.de"
//
// Caveman: ein File, eine Function. Gleiches Muster wie catering-form-worker.js.

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS(origin) },
  });

const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

const ZONE_LABELS = {
  innen: 'Innen',
  dachterrasse: 'Dachterrasse',
  egal: 'Egal · Crew weist zu',
};

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN ?? 'https://fryhigh.de';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, origin);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400, origin);
    }

    if (data._honey) return json({ ok: true }, 200, origin);

    const name = String(data.name ?? '').trim().slice(0, 120);
    const email = String(data.email ?? '').trim().slice(0, 120);
    const phone = String(data.phone ?? '').trim().slice(0, 40);
    const date = String(data.date ?? '').trim().slice(0, 32);
    const time = String(data.time ?? '').trim().slice(0, 8);
    const pax = String(data.pax ?? '').trim().slice(0, 4);
    const zone = String(data.zone ?? 'egal').trim().slice(0, 32);
    const occasion = String(data.occasion ?? '').trim().slice(0, 80);
    const notes = String(data.notes ?? '').trim().slice(0, 2000);

    if (!name || !isEmail(email) || !date || !time || !pax) {
      return json({ error: 'missing required fields (name, email, date, time, pax)' }, 422, origin);
    }

    // Datum-Plausibilität: muss heute oder Zukunft sein, max 8 Wochen
    const requested = new Date(date + 'T' + time);
    if (Number.isNaN(requested.getTime())) {
      return json({ error: 'invalid date/time' }, 422, origin);
    }
    const now = new Date();
    const maxDate = new Date(now.getTime() + 56 * 24 * 60 * 60 * 1000);
    if (requested < new Date(now.getTime() - 60 * 60 * 1000) || requested > maxDate) {
      return json({ error: 'date out of range (heute bis +8 Wochen)' }, 422, origin);
    }

    const paxN = Number(pax);
    if (!Number.isFinite(paxN) || paxN < 1 || paxN > 12) {
      return json({ error: 'pax out of range (1–12)' }, 422, origin);
    }

    const zoneLabel = ZONE_LABELS[zone] ?? zone;
    const subject = `Tisch-Anfrage · ${date} ${time} · ${paxN} Pax · ${zoneLabel}${occasion ? ' · ' + occasion : ''}`;
    const html = `
      <h2>Neue Tisch-Reservierung</h2>
      <p><strong>Name:</strong> ${escape(name)}<br/>
         <strong>E-Mail:</strong> <a href="mailto:${escape(email)}">${escape(email)}</a><br/>
         ${phone ? `<strong>Telefon:</strong> <a href="tel:${escape(phone)}">${escape(phone)}</a><br/>` : ''}
         <strong>Datum:</strong> ${escape(date)}<br/>
         <strong>Uhrzeit:</strong> ${escape(time)}<br/>
         <strong>Personen:</strong> ${escape(String(paxN))}<br/>
         <strong>Bereich:</strong> ${escape(zoneLabel)}<br/>
         ${occasion ? `<strong>Anlass:</strong> ${escape(occasion)}<br/>` : ''}
      </p>
      ${notes ? `<h3>Notiz</h3><pre style="white-space:pre-wrap;font-family:inherit">${escape(notes)}</pre>` : ''}
      <hr/>
      <p style="color:#888;font-size:12px">Source: ${escape(data.source || '')} · Submitted: ${escape(data.ts || '')}</p>
    `;

    if (!env.RESEND_API_KEY) {
      console.warn('RESEND_API_KEY missing — echo-only mode');
      return json({ ok: true, mode: 'echo', subject }, 200, origin);
    }

    const resend = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL ?? 'tisch-form@fryhigh.de',
        to: env.TO_EMAIL ?? 'info@fryhigh.de',
        reply_to: email,
        subject,
        html,
      }),
    });

    if (!resend.ok) {
      const detail = await resend.text();
      console.error('resend failed', resend.status, detail);
      return json({ error: 'mail send failed' }, 502, origin);
    }

    return json({ ok: true }, 200, origin);
  },
};
