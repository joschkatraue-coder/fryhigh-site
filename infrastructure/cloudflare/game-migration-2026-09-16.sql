-- Additive, ONE-SHOT migration from the complete 2026-09-11 schema.
-- Inspect PRAGMA table_info first; do not replay ALTER statements after a successful run.
-- No rows are deleted or rewritten. Existing sessions/scores/vouchers remain intact.
ALTER TABLE sessions ADD COLUMN email_key TEXT;
ALTER TABLE sessions ADD COLUMN week_key TEXT;
ALTER TABLE sessions ADD COLUMN receipt_id TEXT;
ALTER TABLE sessions ADD COLUMN submitted_score INTEGER;
ALTER TABLE sessions ADD COLUMN submitted_duration INTEGER;
ALTER TABLE scores ADD COLUMN email_key TEXT;
ALTER TABLE scores ADD COLUMN entry_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_entry_key ON scores(entry_key);
ALTER TABLE vouchers ADD COLUMN email_key TEXT;
ALTER TABLE vouchers ADD COLUMN winner_name TEXT;
ALTER TABLE vouchers ADD COLUMN winner_mail_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE vouchers ADD COLUMN winner_mail_first_at INTEGER;
ALTER TABLE vouchers ADD COLUMN winner_mail_attempt_at INTEGER;
ALTER TABLE vouchers ADD COLUMN winner_mail_sent_at INTEGER;
ALTER TABLE vouchers ADD COLUMN crew_mail_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE vouchers ADD COLUMN crew_mail_first_at INTEGER;
ALTER TABLE vouchers ADD COLUMN crew_mail_attempt_at INTEGER;
ALTER TABLE vouchers ADD COLUMN crew_mail_sent_at INTEGER;

CREATE TABLE IF NOT EXISTS players (
  email_key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  terms_accepted_at INTEGER NOT NULL,
  age_confirmed INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS auth_links (
  token_hash TEXT PRIMARY KEY,
  email_key TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  terms_version TEXT NOT NULL,
  mail_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS player_sessions (
  token_hash TEXT PRIMARY KEY,
  email_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_expiry ON player_sessions(expires_at);
CREATE TABLE IF NOT EXISTS request_limits (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS winner_history (
  email_key TEXT PRIMARY KEY,
  week_key TEXT NOT NULL,
  won_at INTEGER NOT NULL,
  eligible_after INTEGER NOT NULL
);
