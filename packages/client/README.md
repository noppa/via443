# via443

Share a local dev server at a public `https://` URL, from anywhere that can reach port 443.

```sh
npx via443 --port 3000 --token v443_...
# → https://k3x9m2qa.via443.com
```

Unlike ngrok, cloudflared or localtunnel, the client only makes an outbound WebSocket connection over HTTPS on port 443. It goes through an HTTP `CONNECT` proxy when `HTTPS_PROXY` is set, and trusts the CA bundle the environment provides (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`) without ever turning TLS verification off. So it works in cloud dev containers, coding-agent sandboxes and corporate networks where other tunnels can't connect.

Requests and responses are streamed in both directions, and WebSockets pass through, so dev-server hot reload (Vite, webpack) works.

## Getting a token

via443.com is invite-only for now: ask for access at [via443.com](https://via443.com), then create an API token in the dashboard. You can also [run your own relay](https://github.com/noppa/via443) on Cloudflare or any Node host, and point the client at it with `--server`.

## CLI

```
via443 --port <port> [options]

  -p, --port <port>      local port to expose (required)
      --host <host>      local host to forward to (default: localhost)
      --server <server>  relay domain or URL (default: via443.com, env: VIA443_SERVER)
      --token <token>    API token (env: VIA443_TOKEN)
  -q, --quiet            don't log requests
  -v, --version          show the version
  -h, --help             show this help
```

The URL stays the same if the connection drops and the client reconnects within a few minutes.

## Library

```js
import { openTunnel } from 'via443';

const tunnel = await openTunnel({ port: 3000, token: process.env.VIA443_TOKEN });
console.log(tunnel.url);
tunnel.on('request', (entry) => console.log(entry.method, entry.path, entry.status));
// …
await tunnel.close();
```

## Be careful what you expose

Anyone with the URL can reach your local server. Some managed environments (agent sandboxes, corporate machines) isolate the network on purpose and may not allow exposing a port; check before you use it there.
