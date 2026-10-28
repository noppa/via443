# via443 architecture

_Status: proposal. This builds on `proxy-friendly-tunnel-initial-plan.md` and records the decisions made since._

## Decisions

- **Package manager:** pnpm workspaces. TypeScript everywhere.
- **Two deployment targets, one codebase:**
  - **Cloudflare:** a Worker, one Durable Object per tunnel, and D1 for the account database.
  - **Self-hosted:** one Node process that runs the relay and the account app together, backed by a SQLite file. A reverse proxy such as Caddy sits in front of it and handles the wildcard TLS certificate.
- **Miniflare is for local development and tests of the Cloudflare target only.** We use it through `wrangler dev` and `@cloudflare/vitest-pool-workers`. It is not the self-hosting story: Miniflare is a dev simulator and not meant for production. Running raw `workerd` in production is possible, but it would still need TLS, process supervision and persistence wired up around it, and it would make self-hosters learn Cloudflare's tooling. A plain Node server is simpler to run and to debug.
- **Self-hosting works because the code is host-agnostic.** All real logic lives in packages that depend only on web-standard APIs (`Request`, `Response`, `ReadableStream`, `WebSocket`-like interfaces, `crypto.subtle`). Each target gets a thin adapter.

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
- **Request log / inspector (later):** high-write and per-tunnel, so it stays out of the account DB. On Cloudflare it goes into the tunnel's Durable Object storage, which is SQLite-backed. On Node it goes into a separate table or file with a retention cap. Large bodies are truncated or stored as blobs (R2 on Cloudflare, disk on Node).

## Accounts and tokens

- **Roles:** `admin` and `user`.
- **Getting in:** an admin creates an invite, which produces a single-use link. People without an invite can submit an access request, and an admin approves or rejects it. Approval produces an invite.
- **Signing in to the dashboard:** _open question_, see below.
- **API tokens:** users create and revoke named tokens in the dashboard. A token is shown once, and only its hash (SHA-256) is stored, together with a short visible prefix so users can recognize it. The CLI sends the token in the `/connect` handshake. The relay checks it against the account DB and caches the result briefly.
- **Tunnel ownership:** a tunnel belongs to the token's user. Reserved custom subdomains are a per-user feature added later.

## Local development

- `pnpm dev:node`: the self-host server. This is the fastest loop and the one used for end-to-end tests behind a `CONNECT` proxy.
- `pnpm dev:cf`: `wrangler dev`, which runs the Worker and DO in Miniflare/workerd with a local D1.
- The integration suite runs against both targets, so the two adapters can't drift apart.

## Open questions

- **Dashboard sign-in:** magic link by email (needs an email provider: SMTP when self-hosted, a provider API on Cloudflare), GitHub OAuth, or passkeys.
- **Anonymous tunnels:** allowed at all, or token required for every tunnel? Requiring a token is the simplest way to limit abuse.
- **Domain name.**
