# via443

Simple development reverse proxy &amp; tunneling tool that works anywhere where port 443 does.

So, pretty much like ngrok, cloudflare tunnel, localtunnel and many others, but this one is specifically
tested to work inside Claude app's sandbox.

Create a token in the web dashboard, make sure it has access to the via433.com server (or your own self-hosted server)
is allowed in network config, pass the `npx via443 ... --token xxx` command to Claude (or whatever agent harness & sandbox you use),
and it'll expose your development server to the internet, so you can see what the agent is actually doing.

Easily self-hostable in Cloudflare or on any cheap server with Node.js on it.  
Access to the hosted via443.com version is currently invite-only.

The client only makes an outbound WebSocket connection over HTTPS on port 443. It goes through an HTTP `CONNECT` proxy (`HTTPS_PROXY`) when one is set and trusts the CA bundle the environment provides (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`). So it works in cloud dev containers, coding-agent sandboxes and corporate networks where ngrok, cloudflared and localtunnel can't connect.

**Status:** early development. See [docs/architecture.md](docs/architecture.md) for the design and progress.

## Development

Requires Node ≥ 22.18 and pnpm.

```sh
pnpm install
pnpm test        # unit and integration tests
pnpm typecheck
```

Run the whole thing locally:

```sh
# 1. The relay. Data goes to ./data (SQLite).
VIA443_SETUP_TOKEN=some-secret pnpm relay

# 2. Open the setup link it prints (http://localhost:8080/setup?token=some-secret),
#    create your admin account, then create an API token in the dashboard.

# 3. Some local app, e.g. on port 3000, then the client:
pnpm via443 --port 3000 --server http://localhost:8080 --token v443_...
# → prints http://<id>.localhost:8080, which curl and browsers resolve locally
```

Sign-in links and invites aren't emailed yet: the admin dashboard shows the link for you to send by hand, and links from the sign-in form are written to the relay's log.

### Publishing the client

The `via443` npm package is built from `packages/client` (esbuild bundles the private protocol package into it; `ws` stays a dependency):

```sh
pnpm smoke:pack                        # pack, install the tarball with npm, run its CLI and library through a tunnel
cd packages/client && pnpm publish     # bump "version" first; pnpm swaps in the dist/ entry points
```

Publish with pnpm, not npm: the `dist/` entry points come from `publishConfig`, which only pnpm applies to `bin` and `exports`.

### Relay settings (self-hosted)

| Variable | Default | Meaning |
| --- | --- | --- |
| `VIA443_DOMAIN` | `localhost:<port>` | Public domain. Tunnels are served at `<id>.<domain>`. |
| `VIA443_SCHEME` | `https` if `VIA443_DOMAIN` is set, else `http` | Scheme of public URLs. |
| `VIA443_PORT` | `8080` | Listening port. |
| `VIA443_LISTEN_HOST` | `0.0.0.0` | Listening address. |
| `VIA443_TRUST_PROXY` | off | Take the visitor IP from `X-Forwarded-For`. Only behind your own reverse proxy. |
| `VIA443_DATA_DIR` | `./data` | Where the SQLite databases live. |
| `VIA443_SETUP_TOKEN` | — | Secret that enables `/setup?token=…` to create the first admin. Only works while there are no accounts. |

In production, put a TLS-terminating reverse proxy such as Caddy in front, with a wildcard certificate for `*.<domain>`.

### Cloudflare (Workers + Durable Objects + D1)

The same relay runs on Cloudflare, in `apps/cloudflare`. Locally:

```sh
pnpm dev:cf      # applies D1 migrations locally, then wrangler dev on http://localhost:8787
```

Put `VIA443_SETUP_TOKEN=some-secret` in `apps/cloudflare/.dev.vars`, then open `http://localhost:8787/setup?token=some-secret`. Sign-in links from the sign-in form appear in the `wrangler dev` output (or `wrangler tail` when deployed).

To deploy on your own domain (a zone on Cloudflare; the Free plan works):

1. `cd apps/cloudflare && pnpm exec wrangler d1 create via443-accounts` and put the database ID into `env.production` in `wrangler.jsonc`.
2. In `env.production`, set `VIA443_DOMAIN` and the two routes (the `<domain>` custom domain and `*.<domain>/*`) to your domain.
3. Add a proxied DNS record for `*` (e.g. AAAA `*` → `100::`). Universal SSL covers `*.<domain>`. The apex is a Workers custom domain, so deploying creates its record.
4. `pnpm exec wrangler secret put VIA443_SETUP_TOKEN --env production`
5. `pnpm run deploy` (applies migrations to the remote D1, then deploys), and open `https://<domain>/setup?token=…`.
