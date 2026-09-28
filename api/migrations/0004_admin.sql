-- Admin flag on accounts, and an audit trail of every admin action.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE admin_log (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_id   TEXT,
  target_email TEXT,
  detail      TEXT
);
CREATE INDEX admin_log_at ON admin_log(at);
