# via443 architecture

_Status: proposal. This builds on `proxy-friendly-tunnel-initial-plan.md` and records the decisions made since._

## Decisions

- **Package manager:** pnpm workspaces. TypeScript everywhere.
- **Two deployment targets, one codebase:**
  - **Cloudflare:** a Worker, one Durable Object per tunnel, and D1 for the account database.
  - **Self-hosted:** one Node process that runs the relay and the account app together, backed by a SQLite file. A reverse proxy such as Caddy sits in front of it and handles the wildcard TLS certificate.
- **Miniflare is for local development and tests of the Cloudflare target only.** We use it through `wrangler dev` and `@cloudflare/vitest-pool-workers`. It is not the self-hosting story: Miniflare is a dev simulator and not meant for production. Running raw `workerd` in production is possible, but it would still need TLS, process supervision and persistence wired up around it, and it would make self-hosters learn Cloudflare's tooling. A plain Node server is simpler to run and to debug.
- **Self-hosting works because the code is host-agnostic.** All real logic lives in packages that depend only on web-standard APIs (`Request`, `Response`, `ReadableStream`, `WebSocket`-like interfaces, `crypto.subtle`). Each target gets a thin adapter.

## Domain

- The hosted service runs at **via443.com**. Tunnels are served at `https://<id>.via443.com`, and the dashboard and the client endpoint (`wss://via443.com/connect`) live on the apex domain.
- Nothing hard-codes the domain on the server side. It is one setting, `VIA443_DOMAIN` (an env var on Node, a `wrangler.toml` var on Cloudflare), and every URL the server prints, links to or routes on is derived from it.
- The client defaults to `via443.com`. Self-hosters point it elsewhere with `--server <domain>` or `VIA443_SERVER`, and `via443 login` can save that choice in the client's config file.
- Tunnel hostnames stay **one level deep** (`<id>.<domain>`, and `<id>-<name>.<domain>` for multi-port), so a single `*.<domain>` wildcard certificate covers all of them. Cloudflare's free Universal SSL covers exactly that; a self-hosted Caddy can get one through a DNS challenge.
- A list of reserved names (`www`, `app`, `api`, `admin`, `mail`, …) can never be used as tunnel IDs or custom subdomains.

## Packages

```
packages/
  protocol/     frame codec, frame types, handshake/versioning, flow-control accounting. No I/O.
  relay-core/   tunnel session logic: multiplexing streams over one socket, turning a public
                Request into frames and frames back into a Response, WS pass-through.
                Talks to a small `TunnelSocket` interface, not to any runtime.
  server/       the "supporting infra": a Hono app with the account API and dashboard
                (users, invites, access requests, API tokens; later the request log /
                inspector). Owns the DB schema and migrations. Uses web-standard APIs only.
  client/       the `via443` CLI and a library API (`await tunnel({ port })`). Node only.
apps/
  cloudflare/   Worker + TunnelDO entry points, wrangler.toml, D1 binding. Thin adapter.
  node/         self-host entry point: node:http + ws + SQLite. Thin adapter. Docker image.
```

Hono runs unchanged on Workers and on Node through `@hono/node-server`, which is the main reason to pick it.

## Database

- **Account DB (users, invites, access requests, tokens):** D1 on Cloudflare and a SQLite file on Node. Both speak SQLite, so one set of SQL migrations covers both. Use a query layer with both drivers, e.g. Drizzle (D1 + better-sqlite3) or Kysely. Access goes through a small repository interface, so the server package doesn't care which driver is behind it.
- **Request log / inspector (later):** high-write and per-tunnel, so it stays out of the account DB. On Cloudflare it goes into the tunnel's Durable Object storage, which is SQLite-backed. On Node it goes into a separate SQLite file (`logs.db`, WAL mode), apart from the account DB, so heavy log writes never contend with auth lookups and the file can be deleted at any time. Both targets use the same schema and the same SQL.
  - Everything goes in the logs DB, bodies included, to keep things simple for now. Size is handled later with retention (`DELETE ... WHERE ts < ?`) or by partitioning the DB (e.g. one file per day) if needed.
  - Logged bodies are capped (start with 1 MB per body, configurable) and marked as truncated when cut. This keeps rows small and fits Durable Object SQLite's 2 MB per-row limit. The cap affects only the log: the tunnel itself always streams the full body.
  - A plain-files log (JSONL plus body files) was considered and rejected: the inspector needs filtering, paging and per-tunnel views, which SQLite gives for free and which would share code with the Durable Object implementation.

## Accounts and tokens

- **Roles:** `admin` and `user`.
- **Getting in:** an admin creates an invite, which produces a single-use link. People without an invite can submit an access request, and an admin approves or rejects it. Approval produces an invite.
- **Signing in to the dashboard:** magic links, without sending any email at first.
  - A login link is a single-use URL with a random token (stored hashed) that expires after 15 minutes. Opening it creates a session cookie that lasts 30 days and is extended on use.
  - Links are produced through a `Mailer` interface. The first implementation sends nothing: the admin dashboard shows the link and the admin copies it to the person by hand. The same link is also written to the server log. An SMTP mailer (self-hosted) and an email API mailer (Cloudflare) can be added later without changing the flow.
  - Accepting an invite signs the person in directly. After that they rarely need the dashboard, since the CLI uses long-lived API tokens. When a session expires, the admin generates a fresh login link for them.
  - **Bootstrapping the first admin:** a `SETUP_TOKEN` secret (an env var on Node, a Wrangler secret on Cloudflare). While there are no users, `/setup?token=…` creates the admin account and signs them in. This works the same on both targets and needs no CLI access to the server.
  - GitHub OAuth was rejected for now: every deployment would have to register its own GitHub OAuth app and manage its client secret.
- **API tokens:** users create and revoke named tokens in the dashboard. A token is shown once, and only its hash (SHA-256) is stored, together with a short visible prefix so users can recognize it. The CLI sends the token in the `/connect` handshake. The relay checks it against the account DB and caches the result briefly.
- **No anonymous tunnels, ever.** Every tunnel requires a valid API token, so every tunnel traces back to an invited user whose tokens can be revoked. The relay rejects `/connect` without one.
- **Tunnel ownership:** a tunnel belongs to the token's user. Reserved custom subdomains are a per-user feature added later.

## Local development

- `pnpm dev:node`: the self-host server. This is the fastest loop and the one used for end-to-end tests behind a `CONNECT` proxy.
- `pnpm dev:cf`: `wrangler dev`, which runs the Worker and DO in Miniflare/workerd with a local D1.
- The integration suite runs against both targets, so the two adapters can't drift apart.
