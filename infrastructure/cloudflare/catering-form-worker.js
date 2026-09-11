// Fry High — Catering-Form Worker
// Empfängt POST von fryhigh.de Catering-Form, sendet Mail via Resend an info@fryhigh.de.
//
// Deploy:  wrangler deploy
// Secrets: wrangler secret put RESEND_API_KEY   (TBD: Resend-Account anlegen, API-Key generieren)
//
// Env-Vars (in wrangler.toml [vars]):
//   FROM_EMAIL   = "catering-form@fryhigh.de"   (TBD: DNS-Verify in Resend)
//   TO_EMAIL     = "info@fryhigh.de"
//   ALLOW_ORIGIN = "https://fryhigh.de,https://www.fryhigh.de,https://fryhigh-site.pages.dev"  (Liste; Origin-Echo nur bei Treffer)
//
// Ohne RESEND_API_KEY antwortet der Worker 503 { ok:false, error:'mail not configured' }; kein Scheinerfolg.
// Caveman: ein File, eine Function. Keine Routing-Library, kein Framework.

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

// ALLOW_ORIGIN ist eine kommagetrennte Liste. Origin-Echo nur bei Treffer, sonst erster Eintrag
// (der Browser blockt die Antwort dann korrekt).
function resolveOrigin(request, env) {
  const list = String(env.ALLOW_ORIGIN ?? 'https://fryhigh.de').split(',').map((s) => s.trim()).filter(Boolean);
  const reqOrigin = request.headers.get('Origin');
  return reqOrigin && list.includes(reqOrigin) ? reqOrigin : list[0];
}

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
    const origin = resolveOrigin(request, env);

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
    const phone = String(data.phone ?? '').trim().slice(0, 40);
    // Formular (Stand 2026-09-11) sendet "nachricht"; "cargo" bleibt für den alten Client lesbar.
    const cargo = String(data.nachricht ?? data.cargo ?? '').trim().slice(0, 4000);

    if (!name || !isEmail(email) || !eventDate) {
      return json({ error: 'missing required fields (name, email, event_date)' }, 422, origin);
    }

    const subject = `Catering-Anfrage · ${gate || 'Event'} · ${pax || '?'} Pax · ${eventDate}`;
    const html = `
      <h2>Neue Catering-Anfrage</h2>
      <p><strong>Name:</strong> ${escape(name)}<br/>
         <strong>E-Mail:</strong> <a href="mailto:${escape(email)}">${escape(email)}</a><br/>
         <strong>Telefon:</strong> ${escape(phone || '–')}<br/>
         <strong>Event-Datum:</strong> ${escape(eventDate)}<br/>
         <strong>Gäste:</strong> ${escape(pax)}<br/>
         <strong>Anlass:</strong> ${escape(gate)}</p>
      <h3>Nachricht</h3>
      <pre style="white-space:pre-wrap;font-family:inherit">${escape(cargo)}</pre>
      <hr/>
      <p style="color:#888;font-size:12px">Source: ${escape(data.source || '')} · Submitted: ${escape(data.ts || '')}</p>
    `;

    // Ohne Resend-Key kein Scheinerfolg: 503, das Frontend zeigt den Mail-Link auf info@fryhigh.de.
    if (!env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY missing — mail not configured', { subject });
      return json({ ok: false, error: 'mail not configured' }, 503, origin);
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
