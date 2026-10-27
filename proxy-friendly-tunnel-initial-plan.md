# Proxy-friendly localhost tunnel

_Working name: TBD. Status: idea / ready to start building._

## Problem

Developers often need to share a dev server running on `localhost` with someone else, or open it on another device. Tools like localtunnel, ngrok and cloudflared do this: a client on the developer's machine connects out to a public relay, and the relay forwards public HTTP traffic back through that connection.

These tools break in more and more environments: cloud dev containers, remote coding-agent sandboxes, corporate networks and CI runners. In those environments:

- **There is no direct outbound connection.** Raw TCP to arbitrary hosts and ports is blocked.
- **All egress goes through an HTTP `CONNECT` proxy** set in `HTTPS_PROXY`.
- **The proxy often re-terminates TLS** with its own CA. Clients have to trust a CA bundle supplied by the environment (for example via `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE`), and certificate pinning fails.
- **Only plain-HTTP proxying may be refused** (non-`CONNECT` requests get a 405).

What this does to existing tools:

- **localtunnel:** the client opens raw TCP sockets to `loca.lt:<random port>`, which never connect. It also asks for its tunnel over a plain-HTTP proxied request, which the proxy rejects. The client hangs without printing a URL.
- **ngrok and cloudflared:** they use custom protocols (TLS with pinning, QUIC or HTTP/2 to non-standard ports), so they also fail or need special configuration.

### What was verified in such an environment

- `CONNECT host:443` through the proxy works, and TLS verifies with the provided CA bundle.
- **WebSockets work end to end.** A `wss://echo.websocket.org` round trip through the `CONNECT` proxy succeeded: `101 Switching Protocols`, then a message sent and echoed back.
- **Node's built-in `WebSocket` / `fetch` do not honor `HTTPS_PROXY`.** The client has to set up the `CONNECT` tunnel itself, or use an agent such as `https-proxy-agent`.
- Raw TCP to a non-443 port failed. A `CONNECT` to a non-443 port got a `200` from the local proxy, but whether bytes actually flow upstream is unverified, so don't rely on it.
- Not tested: how long the proxy keeps idle or long-lived connections open.

## Solution

A tunnel service whose client talks only ordinary HTTPS and WebSocket on port 443, through the system proxy and the system CA bundle. If a browser could reach the relay, the tunnel works.

```
 public user ──HTTPS──▶ relay (<id>.tunnel.example) ──WebSocket frames──▶ client ──HTTP──▶ localhost:PORT
                              ▲                                              │
                              └──────── wss:// over HTTPS_PROXY (CONNECT) ───┘
```

### Components

**1. Relay server (public)**
- Serves `https://<id>.<domain>` with a wildcard certificate.
- Accepts client connections at `wss://<domain>/connect`. It assigns a tunnel ID, or accepts a requested one if it's available and authorized, and returns the public URL.
- Forwards every incoming public HTTP request to that tunnel's WebSocket as multiplexed frames, and streams the response back.
- Recommended stack: **Cloudflare Workers + Durable Objects.** Use one Durable Object per tunnel ID: it holds the client WebSocket, and the Worker routes `<id>.<domain>` to it. This gives free TLS, global edge and WebSocket hibernation. A small Node/Go server on a VPS is an acceptable alternative; keep the protocol independent of the host.

**2. Client CLI (Node, published to npm)**
- `npx <name> --port 8080 [--subdomain foo] [--host 127.0.0.1]`
- Reads `HTTPS_PROXY` / `https_proxy` and `NO_PROXY`. If a proxy is set, it opens `CONNECT relay:443` itself (or uses `https-proxy-agent` with `ws`), then does TLS and the WebSocket upgrade.
- Trusts system and env-provided CAs (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`). **Never disables TLS verification.**
- Replays each forwarded request against `localhost:PORT` and streams the response back.
- Sends ping/pong keepalives every ~20–30 s. Reconnects automatically with exponential backoff and **keeps the same tunnel ID** across reconnects, using a resume token.
- Prints the public URL, and optionally a QR code.

### Wire protocol (over one WebSocket)

- Binary frames: a small header (`type`, `streamId`, `flags`) followed by the payload. Types:
  - `REQ_HEAD`: method, path, headers, as JSON
  - `REQ_BODY`: a chunk of the request body; flag `END`
  - `RES_HEAD`: status, headers
  - `RES_BODY`: a chunk of the response body; flag `END`
  - `RESET`: error or cancel
  - `WINDOW`: flow-control credit
  - `PING` / `PONG`
- Many concurrent streams share one socket. Bodies are streamed in chunks, never fully buffered, so large downloads and uploads work.
- Flow control: credit-based per stream (for example a 256 KB initial window), so a slow consumer can't make the relay buffer without limit.
- **WebSocket pass-through:** a public `Upgrade: websocket` request becomes a stream type `WS_OPEN`, followed by `WS_MSG` / `WS_CLOSE` frames. This is needed for dev-server HMR and live reload.
- Version the protocol in the first handshake message, so the client and relay can evolve independently.

### Multi-port / multi-origin

Some apps need more than one origin, for example an app plus a separate sandbox or API origin. One client connection can expose several local ports:

```
--port 8080 --port sandbox=8081   →   https://<id>.<domain>, https://<id>-sandbox.<domain>
```

The client should be able to print the mapping, or write it to a file or env var, so the app can find its sibling origins.

### Fallback transport (later)

If an environment blocks WebSocket upgrades, add an HTTP long-poll transport: `POST /poll` to send frames, and a held-open `GET /poll` to receive them, using the same frame format. This isn't needed for the first version.

## Security and abuse

- **Tunnel IDs** are random and unguessable by default (≥ 64 bits). Custom subdomains require an account or token.
- **Optional access protection:** `--auth user:pass` (basic auth enforced at the relay), or `--token` so the URL only works with `?t=…` or a cookie.
- **The relay rewrites or strips hop-by-hop headers** and adds `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`. It never forwards the client's own auth to the local server.
- **Abuse limits:** rate limits and body size limits per tunnel, a maximum tunnel lifetime for anonymous use, and a way to kill a tunnel. Optionally show a warning interstitial for anonymous tunnels, as localtunnel does, to deter phishing.
- **Respecting the host environment:** the tool exposes a local port to the internet. Some managed environments (agent sandboxes, corporate machines) deliberately isolate the network, so their policy may forbid that. Make exposure always an explicit, visible action by the user: no auto-start, and a clear banner showing what is public. Document this clearly.

## Milestones

1. **Protocol + relay skeleton:** Worker and Durable Object accept `/connect`, assign an ID, and route `<id>.<domain>` requests through the socket. Buffered request and response bodies are fine at this stage.
2. **Client MVP:** proxy-aware `wss` connect, `--port`, request replay, URL printed. Test it from behind a real `CONNECT` proxy that re-terminates TLS (for example mitmproxy in a container, with the egress firewall closed).
3. **Streaming + flow control:** chunked bodies in both directions; concurrency test with many parallel requests.
4. **Robustness:** keepalive, reconnect with resume token, graceful shutdown.
5. **WebSocket pass-through** (HMR works).
6. **Multi-port**, access protection, custom subdomains.
7. Long-poll fallback, if it turns out to be needed.

## Testing

- **Integration harness (docker compose):** a client container with egress firewalled except to a mitmproxy `CONNECT` proxy, whose CA is injected via `NODE_EXTRA_CA_CERTS`. A local relay (Wrangler dev or the Node relay). A test HTTP server.
- **Cases:**
  - GET/POST with large bodies (≥ 100 MB streamed)
  - 100 concurrent requests
  - server-sent events
  - WebSocket echo through the tunnel
  - client reconnect mid-request
  - relay restart
  - idle connection for over 10 min
- **Unit tests** for frame encoding and decoding, and for flow-control accounting.

## Open questions

- Product name and domain.
- Cloudflare Workers vs. self-hosted relay as the default. Workers fits well, but check the per-request CPU and duration limits for long streams and the cost of the Durable Object duration.
- Anonymous use vs. requiring sign-up for any tunnel.
- Whether to also ship a library API (`await tunnel({ port })`) alongside the CLI. Probably yes, cheaply.
