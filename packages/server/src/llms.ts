/**
 * `/llms.txt`: a plain-text guide for coding agents that were pointed at this relay,
 * explaining what via443 is and how to get a tunnel running.
 */
export function llmsTxt(options: { publicOrigin: string; serverFlag: string }): string {
  const { publicOrigin, serverFlag } = options;
  const cmd = (args: string) => `npx via443 ${args}${serverFlag}`;
  return `# via443

> via443 shares a local dev server at a public https:// URL, like ngrok or cloudflared. The client only makes an outbound WebSocket connection over HTTPS on port 443, honours HTTPS_PROXY and the environment's CA bundle (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE), so it works inside coding-agent sandboxes, cloud dev containers and corporate networks where other tunnels can't connect.

This relay is ${publicOrigin}. Typical use: a coding agent starts a dev server, runs the via443 client next to it, and gives the user the public URL so they can see what the agent is building.

## 1. Get access (a human has to do this)

The client needs an API token, and only a person with an account can create one. An agent can't sign up on its own; if you don't have a token, ask the user for one.

- This relay: access is invite-only. The user requests an invite at ${publicOrigin}/request-access, or signs in at ${publicOrigin}/login if they already have an account.
- Self-hosted: anyone can run their own relay on Cloudflare (Workers + Durable Objects + D1) or any Node.js host. See https://github.com/noppa/via443 and pass its domain with --server.

## 2. Create a token

Signed in at ${publicOrigin}, the user creates an API token in the dashboard (tokens look like v443_...). The dashboard then shows a ready-to-paste command.

Pass the token with --token, or set the VIA443_TOKEN environment variable. Treat it as a secret: don't commit it or print it in logs.

## 3. Run the client

Requires Node.js 22 or newer. Start your dev server first, then:

\`\`\`sh
${cmd('--port 3000 --token v443_...')}
# prints https://<id>.<relay domain>
\`\`\`

The client keeps running while the tunnel is open, so start it in the background (or a separate terminal) and leave it running. With one port it prints just the URL on stdout; request logs follow unless you pass --quiet.

Several local servers, each at its own URL, with the URLs written to a JSON file that's easy to read back:

\`\`\`sh
${cmd('--port 3000 --port api=3001 --urls-file urls.json --token v443_...')}
# 3000=https://<id>.<relay domain>
# api=https://<id2>.<relay domain>
# urls.json: {"3000": "https://...", "api": "https://..."}
\`\`\`

Options:

- -p, --port [<name>=]<port>: local port to expose (required, repeatable). A port's name defaults to its number.
- --urls-file <path>: write {"<name>": "<url>"} JSON here, kept up to date if a URL changes after a reconnect.
- --host <host>: local host to forward to (default: localhost).
- --server <server>: relay domain or URL (default: via443.com, env: VIA443_SERVER).
- --token <token>: API token (env: VIA443_TOKEN).
- -q, --quiet: don't log requests.

Notes:

- The Host header is rewritten to the local target and the public host is sent in X-Forwarded-Host, so dev servers with host checks (Vite, webpack) work without config changes. WebSockets pass through, so hot reload works.
- If the connection drops and the client reconnects within a few minutes, the URL stays the same.
- In a sandbox with a network allowlist, the relay's domain and its subdomains must be allowed.
- Anyone with the URL can reach the local server. Don't expose anything the user wouldn't want public, and check that the environment allows exposing ports before you do.

## Library

\`\`\`js
import { openTunnel } from 'via443';
const tunnel = await openTunnel({ port: 3000, token: process.env.VIA443_TOKEN });
console.log(tunnel.url);
await tunnel.close();
\`\`\`

## Links

- npm package: https://www.npmjs.com/package/via443
- Source and self-hosting guide: https://github.com/noppa/via443
`;
}
