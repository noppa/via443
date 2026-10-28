-- Accounts, invites, access requests, sign-in and API tokens.
-- Times are Unix milliseconds. Secrets (tokens, links) are stored only as SHA-256 hex hashes.
-- No BEGIN/COMMIT here: the runners wrap each migration in a transaction (D1 forbids explicit ones).

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  -- Optional: when set, the invite can only be accepted with this email.
  email       TEXT COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_by  TEXT REFERENCES users (id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  used_by     TEXT REFERENCES users (id)
);

CREATE TABLE access_requests (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL COLLATE NOCASE,
  message     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  INTEGER NOT NULL,
  decided_by  TEXT REFERENCES users (id),
  decided_at  INTEGER
);

CREATE INDEX access_requests_status ON access_requests (status, created_at);

CREATE TABLE login_links (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- The first characters of the token, shown in the dashboard so users can tell tokens apart.
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX api_tokens_user ON api_tokens (user_id);
