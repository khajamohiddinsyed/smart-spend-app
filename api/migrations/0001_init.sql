-- Smart Spend accounts and synced ledgers.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,               -- random, never shown
  email         TEXT NOT NULL UNIQUE,           -- lower-cased
  name          TEXT NOT NULL,
  pw_salt       TEXT NOT NULL,                  -- server salt (hex)
  pw_hash       TEXT NOT NULL,                  -- HMAC-SHA256(pw_salt, client-stretched key)
  rec_salt      TEXT NOT NULL,
  rec_hash      TEXT NOT NULL,                  -- same, over the recovery code
  currency      TEXT NOT NULL,                  -- ISO 4217, amounts are stored in this
  alt_currency  TEXT,                           -- optional second currency to show
  rate          REAL,                           -- 1 currency = rate alt_currency
  rate_updated_at INTEGER NOT NULL DEFAULT 0,
  seq           INTEGER NOT NULL DEFAULT 0,     -- last change number handed out for this user's records
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,                 -- SHA-256 of the bearer token
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  device      TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE records (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  data        TEXT,                             -- JSON of the record, NULL for a deletion
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,                 -- the editing device's clock (merge: latest wins)
  canon       TEXT NOT NULL DEFAULT '',         -- tie-break when updated_at is equal
  seq         INTEGER NOT NULL,                 -- server change number (what a device has seen)
  PRIMARY KEY (user_id, id)
);
CREATE INDEX records_seq ON records(user_id, seq);

-- Brute-force brakes for login, register and recovery.
CREATE TABLE attempts (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  INTEGER NOT NULL
);
