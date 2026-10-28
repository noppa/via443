-- Tunnel IDs in use on the Cloudflare relay, which keeps each tunnel in its own
-- Durable Object and needs one shared place to reserve IDs and to find a user's
-- tunnels when their access is revoked. The Node relay keeps this in memory and
-- doesn't use the table.

CREATE TABLE tunnels (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX tunnels_user ON tunnels (user_id);
CREATE INDEX tunnels_token ON tunnels (token_id);
