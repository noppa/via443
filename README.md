# via443

Simple development reverse proxy &amp; tunneling tool that works anywhere where port 443 does.

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
