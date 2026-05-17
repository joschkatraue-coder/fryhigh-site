# Deployment — Cloudflare Pages + Worker + DNS

> Stand: 2026-05-17 · Status: Plan, noch nicht ausgeführt.

Diese Site läuft als Single-Page-Astro-App + ein Cloudflare-Worker für die Catering-Form. Newsletter geht über ein Mailerlite-Embed direkt (kein Worker nötig).

## 1. Cloudflare-Account-Setup (einmalig)

1. cloudflare.com → Sign up (kostenfrei für Pages + 100k Worker-Requests/Tag).
2. Im Dashboard **Add a Site** → `fryhigh.de` → Free-Plan auswählen.
3. CF zeigt **Nameserver-Pair** an, z. B.:
   ```
   ns-1234.cloudflare.com
   ns-5678.cloudflare.com
   ```
4. Bei Domain-Registrar von fryhigh.de (TBD: wo liegt's? Strato? IONOS? Joschka prüfen) **Nameserver-Einträge ändern** auf die beiden CF-Nameserver. Propagation 2-48h.
5. Im CF-Dashboard **Active** abwarten (E-Mail-Bestätigung kommt).

## 2. Pages-Project anlegen

1. CF-Dashboard → **Workers & Pages → Pages → Connect to Git**.
2. GitHub-Account verbinden, Repo `joschkatraue-coder/fryhigh-site` auswählen.
3. Build-Settings:
   - **Framework preset:** Astro
   - **Build command:** `npm run build`
   - **Build output:** `dist`
   - **Root directory:** `/` (Repo-Root)
   - **Node version:** `22` (Environment-Variable `NODE_VERSION=22`)
4. Deploy starten. Erste Build dauert ~2 Min. URL: `fryhigh-site.pages.dev`.

## 3. Custom Domain

1. Pages-Project → **Custom Domains → Set up a custom domain**.
2. `fryhigh.de` eintragen (und `www.fryhigh.de` separat als zweiten Eintrag).
3. CF setzt CNAME automatisch (DNS-Zone ist ja schon bei CF).
4. SSL-Zertifikat wird automatisch ausgestellt (~1 Min).

## 4. Catering-Worker deployen

```bash
cd 10_businesses/fry-high/code/fryhigh-site/infrastructure/cloudflare
npm i -g wrangler
wrangler login                                  # OAuth-Browser-Flow
wrangler deploy catering-form-worker.js         # Liest wrangler.toml
```

Worker läuft danach unter `https://catering-form.fryhigh.workers.dev`.

**Secrets setzen (einmalig):**

```bash
wrangler secret put RESEND_API_KEY              # Eintippen, Enter
```

**Resend-Account aufsetzen (vor Secret-Setzen):**

1. resend.com → Sign up (kostenfrei: 100 Mails/Tag, 3000/Monat).
2. **Domains → Add Domain** → `fryhigh.de`.
3. CF-DNS-Records einsetzen (TXT für SPF/DKIM/DMARC). Resend zeigt sie an, einfach in CF-Dashboard → DNS einfügen.
4. **Verify** klicken (1-5 Min).
5. **API Keys → Create API Key** → kopieren → `wrangler secret put RESEND_API_KEY`.

**Worker-URL in Frontend einsetzen:**

Aktuell hardcoded in `src/content/catering.md`:

```yaml
form:
  submit_endpoint: "https://catering-form.fryhigh.workers.dev"
```

Bleibt so — die `workers.dev`-Subdomain ist stabil und CORS ist im Worker freigeschaltet (`ALLOW_ORIGIN=https://fryhigh.de`).

## 5. Mailerlite-Embed

1. mailerlite.com → Sign up (kostenfrei bis 1000 Subs + 12k Mails/Monat).
2. **Audience → Create Group** → "fryhigh.de Newsletter".
3. **Forms → Embedded Form → Create new** → Single-Field-Email-Variante.
4. Mailerlite zeigt **Account-ID + Form-ID** in der Embed-URL:
   ```
   https://assets.mailerlite.com/jsonp/<ACCOUNT-ID>/forms/<FORM-ID>/subscribe
   ```
5. In `src/components/NewsletterCTA.astro` Konstante `MAILERLITE_ACTION` ersetzen:
   ```ts
   const MAILERLITE_ACTION = "https://assets.mailerlite.com/jsonp/12345/forms/67890/subscribe";
   ```
6. Double-Opt-In ist in Mailerlite default ON. Bestätigungs-Mail-Text + Welcome-Mail im Mailerlite-UI customizen (deutsche Voice).

## 6. Sitemap + Robots

`sitemap-index.xml` wird automatisch von `@astrojs/sitemap` generiert. Nach Deploy einmalig in **Google Search Console** einreichen.

`robots.txt` (TBD anlegen in `public/robots.txt`):

```
User-agent: *
Allow: /
Disallow: /impressum
Disallow: /datenschutz

Sitemap: https://fryhigh.de/sitemap-index.xml
```

## 7. Analytics (DSGVO-konform, cookie-frei)

**Plausible** (~9 €/Monat) ODER **Cloudflare Web Analytics** (free, läuft im CF-Dashboard).

Empfehlung: **CF Web Analytics** für Phase 1 (free, automatisch verfügbar nach Pages-Deploy, kein Script-Tag nötig). Wenn Detail-Insights gebraucht: später auf Plausible umsteigen.

## 8. Smoke-Test-Checkliste nach Deploy

- [ ] https://fryhigh.de lädt
- [ ] http://fryhigh.de → 301 → https
- [ ] https://www.fryhigh.de → 301 → https://fryhigh.de
- [ ] /impressum + /datenschutz erreichbar
- [ ] /unknown-route → 404-Page (nicht CF-Default)
- [ ] Catering-Form senden → E-Mail kommt an info@fryhigh.de
- [ ] Newsletter-Submit → Mailerlite-Confirmation-Mail kommt
- [ ] Lighthouse-Mobile-Score > 90
- [ ] Schema-Validator: https://search.google.com/test/rich-results — JSON-LD valide
- [ ] OG-Preview: https://www.opengraph.xyz/?url=https%3A%2F%2Ffryhigh.de — Bild + Titel korrekt
- [ ] IG/FB-Preview-Test mit echtem Post

## 9. Kosten-Übersicht

| Service | Kosten |
|---|---|
| Cloudflare Pages | 0 € (Free-Tier) |
| Cloudflare Worker | 0 € (Free-Tier: 100k req/Tag) |
| Cloudflare DNS | 0 € (Free-Tier) |
| Resend | 0 € (bis 3k Mails/Monat) |
| Mailerlite | 0 € (bis 1k Subscribers) |
| Domain fryhigh.de | ~12 €/Jahr (bei aktuellem Registrar) |
| **Total Phase 1** | **~12 €/Jahr** |

Skaliert ohne Sorge bis ~10k MAU.

## 10. Rollback-Plan

CF-Pages versioniert jeden Build. Bei Problemen: **Pages → Deployments → Rollback to previous**. Worker hat eigene Versionen via `wrangler rollback`. DNS-Wechsel ist via Registrar reversibel (Nameserver zurückstellen, 24-48h Propagation).
