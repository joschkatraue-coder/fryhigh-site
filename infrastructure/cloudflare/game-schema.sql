-- Fry High — Pommespilot Game · D1-Schema
-- Erst-Setup (leere DB):
--   wrangler d1 create fryhigh-game
--   (ID aus Output in wrangler-game.toml eintragen)
--   wrangler d1 execute fryhigh-game --file=./game-schema.sql --remote
--
-- Bestehende DB (Stand Mai 2026) auf den Stand 2026-09-11 heben: NUR den Block "Migration 2026-09-11"
-- unten ausführen (per --command), nicht diese Datei; ALTER TABLE ADD COLUMN bricht bei schon vorhandener Spalte ab.
--
-- 4 Tables · caveman, kein Migrations-Framework.

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- 60 min nach created_at (Worker SESSION_MS)
  used INTEGER NOT NULL DEFAULT 0
  -- ip_hash entfernt 2026-09-11 (wurde nie gelesen, statischer Salt)
);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,                 -- wird 120 Tage nach created_at zu 'anon:<id>' (Cron-Cleanup)
  display_name TEXT,                   -- öffentlich; NULL → Anzeige "Pilot #XXXX"
  score INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT UNIQUE,
  verify_expires_at INTEGER,           -- P1 fix 2026-05-18: 7d expiry for magic-link; unbestätigte Zeilen werden danach gelöscht
  mail_status TEXT DEFAULT 'pending',  -- P1 fix Run-12: 'pending' | 'sent' | 'failed'
  newsletter_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  week_key TEXT NOT NULL,              -- ISO-Woche nach Europe/Berlin, z. B. '2026-W37'
  -- Migration 2026-09-11:
  terms_version TEXT,                  -- Version der Teilnahmebedingungen, die der Spieler bestätigt hat
  terms_accepted_at INTEGER,           -- Zeitstempel des Consent-Hakens (Nachweis)
  age_confirmed INTEGER NOT NULL DEFAULT 0,   -- Haken "mindestens 16"
  newsletter_confirmed_at INTEGER,     -- Klick auf den Magic-Link bei gesetztem Opt-in
  hidden INTEGER NOT NULL DEFAULT 0    -- Crew blendet Eintrag aus Rangliste und Gewinnermittlung aus (/admin/hide-score)
);

CREATE INDEX IF NOT EXISTS idx_scores_week_top ON scores(week_key, verified, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_verify ON scores(verify_token);
CREATE INDEX IF NOT EXISTS idx_scores_email_week ON scores(email, week_key);

CREATE TABLE IF NOT EXISTS vouchers (
  code TEXT PRIMARY KEY,               -- 'FLY-' + 16 Zeichen
  email TEXT NOT NULL,                 -- wird 90 Tage nach expires_at zu 'anon:<score_id>'
  score_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  week_key TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,         -- issued_at + VOUCHER_VALID_DAYS
  redeemed_at INTEGER,
  redeemed_by_note TEXT,
  -- Migration 2026-09-11:
  kind TEXT,                           -- 'meal' (Gericht nach Wahl) | 'eur'
  label TEXT,                          -- Anzeige-Text, z. B. 'Ein Gericht nach Wahl, aufs Haus'
  value_eur INTEGER,                   -- Warenwert-Deckel (bei kind='meal'), kein Rabattbetrag
  redeem_location TEXT                 -- z. B. 'Fry High im Zoo am Meer'
);

CREATE INDEX IF NOT EXISTS idx_vouchers_week ON vouchers(week_key);
-- P1 fix 2026-05-18: UNIQUE constraint ensures idempotent weekly voucher issuance under cron-retry
CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_week_unique ON vouchers(week_key);

-- P0 fix Run-13: weeks-metadata for cron-verify TOCTOU elimination
CREATE TABLE IF NOT EXISTS weeks (
  week_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'frozen' | 'closed'
  frozen_at INTEGER,
  closed_at INTEGER
);

-- ─── Migrationen (nur bei bestehender DB, von Hand) ───────────────────────
-- Migration 2026-05-18:
--   ALTER TABLE scores ADD COLUMN verify_expires_at INTEGER;
--   UPDATE scores SET verify_expires_at = created_at + (7 * 24 * 60 * 60 * 1000) WHERE verify_expires_at IS NULL;
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_week_unique ON vouchers(week_key);
-- Migration Run-12:
--   ALTER TABLE scores ADD COLUMN mail_status TEXT DEFAULT 'pending';
--   UPDATE scores SET mail_status = 'sent' WHERE mail_status IS NULL;
-- Migration Run-13:
--   CREATE TABLE IF NOT EXISTS weeks (week_key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open', frozen_at INTEGER, closed_at INTEGER);
--   INSERT OR IGNORE INTO weeks (week_key, status, closed_at) SELECT DISTINCT week_key, 'closed', issued_at FROM vouchers;
-- Migration newsletter opt-in:
--   ALTER TABLE scores ADD COLUMN newsletter_opt_in INTEGER NOT NULL DEFAULT 0;
--
-- Migration 2026-09-11 (Pflicht VOR dem Deploy des Workers vom 2026-09-11; der Worker liest scores.hidden und vouchers.label):
--   wrangler d1 execute fryhigh-game --remote --command "ALTER TABLE scores ADD COLUMN terms_version TEXT; ALTER TABLE scores ADD COLUMN terms_accepted_at INTEGER; ALTER TABLE scores ADD COLUMN age_confirmed INTEGER NOT NULL DEFAULT 0; ALTER TABLE scores ADD COLUMN newsletter_confirmed_at INTEGER; ALTER TABLE scores ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0; ALTER TABLE vouchers ADD COLUMN kind TEXT; ALTER TABLE vouchers ADD COLUMN label TEXT; ALTER TABLE vouchers ADD COLUMN value_eur INTEGER; ALTER TABLE vouchers ADD COLUMN redeem_location TEXT;"
--   Einzeln lesbar:
--   ALTER TABLE scores ADD COLUMN terms_version TEXT;
--   ALTER TABLE scores ADD COLUMN terms_accepted_at INTEGER;
--   ALTER TABLE scores ADD COLUMN age_confirmed INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE scores ADD COLUMN newsletter_confirmed_at INTEGER;
--   ALTER TABLE scores ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE vouchers ADD COLUMN kind TEXT;
--   ALTER TABLE vouchers ADD COLUMN label TEXT;
--   ALTER TABLE vouchers ADD COLUMN value_eur INTEGER;
--   ALTER TABLE vouchers ADD COLUMN redeem_location TEXT;
--   Optional (Datensparsamkeit; SQLite >= 3.35, D1 unterstützt DROP COLUMN):
--   ALTER TABLE sessions DROP COLUMN ip_hash;
--   Prüfen: wrangler d1 execute fryhigh-game --remote --command "PRAGMA table_info(scores);"
