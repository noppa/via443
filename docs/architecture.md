# via443 architecture

_Status: in progress. This builds on `proxy-friendly-tunnel-initial-plan.md` and records the decisions made since. Where the two disagree, this document wins._

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
- Tunnel hostnames are always `<id>.<domain>`, **one level deep**, so a single `*.<domain>` wildcard certificate covers all of them. Cloudflare's free Universal SSL covers exactly that; a self-hosted Caddy can get one through a DNS challenge.
- **Tunnel IDs are always random**, issued by the relay. There are no self-chosen IDs or custom subdomains until someone actually asks for them. IDs have a fixed length and alphabet, so they can never collide with names like `www` or `api`, and no reserved-names list is needed.
- **ID format, first version:** 8 random lowercase alphanumeric characters (about 41 bits). The relay rate-limits requests to unknown tunnel hosts per client IP, so scanning for live tunnels is impractically slow.
- **ID format, later: wormhole-style names.** Short, readable IDs (e.g. `7-purple-sausage`) with protection against guessing, in the spirit of magic-wormhole: an ID has a public part that identifies the tunnel and a secret part that must also match. A request with the right public part but a wrong secret part is evidence that someone is guessing, and the relay shuts the tunnel down (or rotates its ID and tells the client). One thing to solve first: the public part is easy to enumerate, so an attacker could kill everyone's tunnels on purpose. Possible fixes are a small budget of wrong guesses before shutdown, rotating instead of killing, and per-IP blocking.
- The protocol and the client treat tunnel IDs as **opaque strings** issued by the relay, so changing the ID scheme later is a relay-only change.
- **Multi-port:** each exposed port gets its own random ID (`--port 8080 --port sandbox=8081` gives two unrelated hostnames). The client prints the name → URL mapping and can write it to a file or env var so the app can find its sibling origins. All IDs stay the same across reconnects through the resume token.
- **One WebSocket per tunnel.** A multi-port client opens one connection per port instead of multiplexing several tunnels over one socket. On Cloudflare that maps each connection to exactly one Durable Object (named by its tunnel ID), with no lookup table in between.

## Connection handshake

- The client opens `wss://<domain>/connect` with `Authorization: Bearer <token>`, `Via443-Protocol: <version>` and, when reconnecting, `Via443-Resume: <tunnelId>:<resumeToken>`.
- The relay validates all of this **before** accepting the WebSocket and answers errors as plain HTTP (`401`, `426`) with a JSON `{code, message}` body. On Cloudflare this lets the Worker authenticate against D1 and pick the tunnel's Durable Object before handing over the upgrade.
- After the upgrade, the relay's first frame is `WELCOME` with the tunnel ID, public URL and a fresh resume token. Everything after that is the binary frame protocol in `packages/protocol`.
- A resume succeeds when the tunnel ID is still reserved (10 minutes after a disconnect), belongs to the same user and the resume token matches. Otherwise the client simply gets a new ID and says so loudly.

## Flow control

- Credit-based and per stream, like HTTP/2. Each direction of a stream starts with a 256 KiB window, which is how many body bytes the sender may have in flight that the receiver's consumer hasn't taken yet. Only body payload bytes count.
- The receiver returns credit with `WINDOW` frames (a 4-byte increment) once its consumer has taken the data: on the relay when the visitor side reads the response body, on the client when the chunk has been written to the local server's socket. Credit goes back in batches of at least half a window.
- A sender that overruns its window is a protocol error and the connection closes (1002).
- There is no connection-level window: per-stream windows already bound what any one connection can buffer, and the WebSocket itself runs over TCP.
- The window caps one stream's throughput at about window / round-trip time (256 KiB at 50 ms ≈ 5 MB/s). If that turns out to be too low, raise `INITIAL_WINDOW` or grow windows for streams that are being drained quickly.

## WebSocket pass-through

- A visitor's `Upgrade: websocket` request becomes a stream that starts with `WS_OPEN` (a request head). The client opens its own WebSocket to the local server, offering the visitor's subprotocols, and answers `RES_HEAD`:
  - `101` with the chosen `sec-websocket-protocol`: the relay completes the visitor's upgrade with that subprotocol, and messages flow as `WS_MSG` frames.
  - Any other status: the local server refused the upgrade. The stream continues as a plain HTTP response, which the relay passes on (e.g. a 403 from a dev server's token check).
- Each hop negotiates its own WebSocket details (key, extensions such as compression, pings). Only messages and the close code and reason cross the tunnel.
- Messages are split into `WS_MSG` fragments (`END` on the last, `BINARY` for binary messages) that count against the stream's flow-control windows. Credit for a message's last fragment comes back once the receiving side has handed the message to its socket. When messages queue up because there's no credit, the sending side pauses reading from its socket.
- Messages are capped at 16 MiB. `WS_CLOSE` from either side ends the stream; the sender sends it after all the messages queued before it.

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
  client/       the `via443` CLI and a library API (`await openTunnel({ port, token })`). Node only.
                Does its own HTTP CONNECT through HTTPS_PROXY and trusts NODE_EXTRA_CA_CERTS
                and SSL_CERT_FILE, never disabling TLS verification.
apps/
  cloudflare/   Worker + TunnelDO entry points, wrangler.toml, D1 binding. Thin adapter.
  node/         self-host entry point: node:http + ws + SQLite. Thin adapter. Docker image.
```

Hono runs unchanged on Workers and on Node through `@hono/node-server`, which is the main reason to pick it.

## Cloudflare adapter

- The Worker routes by host. `<id>.<domain>` goes to the Durable Object named by the tunnel ID. On the apex, `/connect` checks the API token against D1 and hands the upgrade to a tunnel's Durable Object; everything else is the dashboard.
- **Tunnel IDs are reserved in D1** (`tunnels` table) before a Durable Object takes the connection, since each tunnel lives in its own object and nothing else can see them all. The same table finds a user's or token's tunnels on revocation; the Worker then calls each object's `revoke()`.
- **Resume:** the client's resume request goes to the old tunnel's object, which checks owner and resume token. If it refuses (expired, someone else's), the Worker falls back to a fresh ID, like the Node relay.
- **The client socket uses the hibernation API**, so an idle tunnel isn't billed for wall time between the client's pings. The session is rebuilt when the object wakes; this is safe because the object only hibernates when no request or visitor WebSocket is in flight. Each client socket is tagged with a connection ID so a replaced socket's late events are ignored.
- **Visitor WebSockets are ordinary (non-hibernating) sockets.** They keep the object in memory while open. Workers can't pause reading a WebSocket or report when a message has left, so visitor-side WebSocket backpressure is weaker than on Node; tunnel-side flow control still applies.
- After a client disconnects, an alarm releases the tunnel ID (Durable Object storage and the D1 row) once the resume grace period has passed.
- Gaps compared with the Node relay:
  - No rate limit on requests to unknown tunnel IDs yet. Workers' rate-limiting binding can only count, not check, so a limit that also blocks the guesser's hits needs a different design (e.g. a per-IP Durable Object or a WAF rule).
  - No idle timeout for clients that vanish without closing their socket; a resume replaces such a socket.
  - Request bodies are limited by the Cloudflare plan (100 MB on Free and Pro).

## Database

- **Account DB (users, invites, access requests, tokens):** D1 on Cloudflare and a SQLite file on Node (`accounts.db`, through the built-in `node:sqlite`, so no native dependency). Both speak SQLite.
- **No ORM.** The app isn't CRUD-heavy and the schema will change rarely, so queries are hand-written SQL behind a four-method `Db` interface (`all`, `first`, `run`, `batch`) with one adapter for D1 and one for `node:sqlite`. Drizzle was considered and judged more than we need.
- **Migrations are plain SQL files** in `packages/server/migrations/NNNN_name.sql`, applied in order, never edited once released.
  - On Cloudflare, `wrangler d1 migrations apply` runs them at deploy time (`migrations_dir` points at that folder).
  - On Node, the relay applies pending ones at startup, each in its own transaction, recording them in the same `d1_migrations` table wrangler uses.
  - Migration files must not contain `BEGIN`/`COMMIT`, because D1 rejects explicit transactions.
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
- **API tokens:** users create and revoke named tokens in the dashboard. Tokens look like `v443_<43 random chars>`. A token is shown once, and only its hash (SHA-256) is stored, together with the first 11 characters so users can recognize it. The CLI sends the token in the `/connect` handshake and the relay checks it against the account DB.
- **Revocation is immediate.** Revoking a token or disabling a user also closes their live tunnels (close code 4001), and those tunnels can't be resumed. Disabling a user also ends their dashboard sessions.
- **Dashboard security:** server-rendered HTML forms, no client-side JavaScript. The session cookie is `__Host-` prefixed (HttpOnly, Secure, SameSite=Lax, no `Domain`), so tunnel subdomains never receive it. Every POST must carry a same-origin `Origin` header (CSRF). Opening a sign-in link shows a button and doesn't sign in by itself, because mail scanners follow links and would otherwise use them up.
- **No anonymous tunnels, ever.** Every tunnel requires a valid API token, so every tunnel traces back to an invited user whose tokens can be revoked. The relay rejects `/connect` without one.
- **Tunnel ownership:** a tunnel belongs to the token's user.

## Local development

- Packages export their TypeScript source directly. Node (≥ 22.18) strips types natively, so there is no build step while developing; the published client will get one.
- `pnpm relay`: the self-host server on `localhost:8080`. Tunnels appear at `http://<id>.localhost:8080`, which browsers and curl resolve to 127.0.0.1 without any DNS setup. This is the fastest loop.
- `pnpm via443 --port 3000 --server http://localhost:8080`: the client against the local relay.
- `pnpm dev:cf`: `wrangler dev`, which runs the Worker and its Durable Objects in workerd with a local D1, at `http://localhost:8787`.
- The integration suite (`packages/relay-tests`) runs the real client against a running relay. Both adapters run it: `apps/node/test` against the Node relay (plus a TLS relay behind a local `CONNECT` proxy), and `apps/cloudflare/test` against `wrangler dev`, so the two can't drift apart. The suite only uses what a deployment offers: tokens are created and revoked through the dashboard, and network drops are simulated by cutting the TCP connection.

## Progress

- [x] Protocol: frame codec, typed messages, connect handshake headers.
- [x] relay-core: tunnel session with streamed bodies in both directions, error mapping, X-Forwarded-* headers.
- [x] Node relay: host routing, `/connect`, in-memory tunnel registry with resume, rate limit on unknown tunnels.
- [x] Client: proxy-aware connect, request forwarding, keepalive, reconnect with resume, CLI.
- [x] Flow control: per-stream `WINDOW` credit, so a slow visitor or local server slows the other side down instead of making the relay or client buffer.
- [x] Accounts: `packages/server` with SQL migrations, setup token, invites, access requests, sign-in links (shown to the admin or logged, not emailed yet), sessions, API tokens, and the dashboard. Wired into the Node relay.
- [ ] Email delivery (SMTP / email API) for sign-in links and invites.
- [ ] Rate limits on the sign-in and access-request forms.
- [x] Cloudflare adapter: Worker, one Durable Object per tunnel, D1 accounts. Passes the shared suite under `wrangler dev`; not yet deployed.
- [x] WebSocket pass-through (HMR): verified with Vite's HMR socket.
- [ ] Multi-port, request log and inspector.
