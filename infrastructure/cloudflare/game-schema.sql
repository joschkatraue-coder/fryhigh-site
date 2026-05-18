-- Fry High — Pilot-Flight Game · D1-Schema
-- Setup (einmalig):
--   wrangler d1 create fryhigh-game
--   (ID aus Output in wrangler-game.toml eintragen)
--   wrangler d1 execute fryhigh-game --file=./game-schema.sql --remote
--
-- 3 Tables · caveman, keine Migrations-Framework.

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT
);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  score INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT UNIQUE,
  verify_expires_at INTEGER,  -- P1 fix 2026-05-18: 7d expiry for magic-link
  mail_status TEXT DEFAULT 'pending',  -- P1 fix Run-12: 'pending' | 'sent' | 'failed' for sendMail durable-state-tracking
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  week_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_week_top ON scores(week_key, verified, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_verify ON scores(verify_token);
CREATE INDEX IF NOT EXISTS idx_scores_email_week ON scores(email, week_key);

CREATE TABLE IF NOT EXISTS vouchers (
  code TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  score_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  week_key TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redeemed_by_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_vouchers_week ON vouchers(week_key);
-- P1 fix 2026-05-18: UNIQUE constraint ensures idempotent weekly voucher issuance under cron-retry
CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_week_unique ON vouchers(week_key);

-- Migration (apply manually if upgrading from earlier schema):
--   ALTER TABLE scores ADD COLUMN verify_expires_at INTEGER;
--   UPDATE scores SET verify_expires_at = created_at + (7 * 24 * 60 * 60 * 1000) WHERE verify_expires_at IS NULL;
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_week_unique ON vouchers(week_key);
-- Migration Run-12 (apply manually if upgrading):
--   ALTER TABLE scores ADD COLUMN mail_status TEXT DEFAULT 'pending';
--   UPDATE scores SET mail_status = 'sent' WHERE mail_status IS NULL;  -- assume legacy rows had successful mails
