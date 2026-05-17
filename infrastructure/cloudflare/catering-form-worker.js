// Fry High — Catering-Form Worker
// Empfängt POST von fryhigh.de Catering-Form, sendet Mail via Resend an info@fryhigh.de.
//
// Deploy:  wrangler deploy
// Secrets: wrangler secret put RESEND_API_KEY   (TBD: Resend-Account anlegen, API-Key generieren)
//
// Env-Vars (in wrangler.toml [vars]):
//   FROM_EMAIL   = "catering-form@fryhigh.de"   (TBD: DNS-Verify in Resend)
//   TO_EMAIL     = "info@fryhigh.de"
//   ALLOW_ORIGIN = "https://fryhigh.de"
//
// Caveman: ein File, eine Function. Keine Routing-Library, kein Framework.

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

    // honeypot — wenn anti-bot-feld gefüllt, einfach 200 zurück, nix tun
    if (data._honey) return json({ ok: true }, 200, origin);

    const name = String(data.name ?? '').trim().slice(0, 120);
    const email = String(data.email ?? '').trim().slice(0, 120);
    const eventDate = String(data.event_date ?? '').trim().slice(0, 32);
    const pax = String(data.pax ?? '').trim().slice(0, 8);
    const gate = String(data.gate ?? '').trim().slice(0, 32);
    const cargo = String(data.cargo ?? '').trim().slice(0, 4000);

    if (!name || !isEmail(email) || !eventDate) {
      return json({ error: 'missing required fields (name, email, event_date)' }, 422, origin);
    }

    const subject = `Catering-Anfrage · ${gate || 'Event'} · ${pax || '?'} Pax · ${eventDate}`;
    const html = `
      <h2>Neue Catering-Anfrage</h2>
      <p><strong>Name:</strong> ${escape(name)}<br/>
         <strong>E-Mail:</strong> <a href="mailto:${escape(email)}">${escape(email)}</a><br/>
         <strong>Event-Datum:</strong> ${escape(eventDate)}<br/>
         <strong>Gäste:</strong> ${escape(pax)}<br/>
         <strong>Event-Typ:</strong> ${escape(gate)}</p>
      <h3>Cargo Manifest</h3>
      <pre style="white-space:pre-wrap;font-family:inherit">${escape(cargo)}</pre>
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
        from: env.FROM_EMAIL ?? 'catering-form@fryhigh.de',
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
