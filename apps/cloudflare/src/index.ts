import { CONNECT_PATH } from '@via443/protocol';
import {
  connectErrorResponse,
  generateTunnelId,
  isTunnelId,
  matchHost,
  parseConnectRequest,
  type TunnelOwner,
  tunnelErrorResponse,
} from '@via443/relay-core';
import { Accounts, createApp, d1Db, logMailer } from '@via443/server';
import { TunnelDirectory } from './directory.ts';
import { type Env, InternalHeader, relayConfig } from './env.ts';

export { TunnelDO } from './tunnel.ts';

/**
 * Routes by host: `<id>.<domain>` goes to that tunnel's Durable Object, and the
 * apex serves `/connect` for clients and the dashboard for everyone else.
 */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { domain } = relayConfig(env);
    const host = matchHost(request.headers.get('host'), domain);
    if (host.kind === 'tunnel') {
      const headers = new Headers(request.headers);
      headers.set(InternalHeader.ROUTE, 'visit');
      return tunnelStub(env, host.tunnelId).fetch(new Request(request, { headers }));
    }
    if (host.kind === 'unknown') return tunnelErrorResponse(404, 'unknown host.');
    if (new URL(request.url).pathname === CONNECT_PATH) return connect(request, env);
    return dashboard(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

function tunnelStub(env: Env, tunnelId: string) {
  return env.TUNNELS.get(env.TUNNELS.idFromName(tunnelId));
}

function directory(env: Env): TunnelDirectory {
  return new TunnelDirectory(d1Db(env.DB));
}

/**
 * A client opens a tunnel. The token is checked against D1 here, then the
 * tunnel's Durable Object takes the WebSocket: the one being resumed if the
 * client asks for that and is allowed to, otherwise one with a fresh ID.
 */
async function connect(request: Request, env: Env): Promise<Response> {
  const parsed = parseConnectRequest(request);
  if (!parsed.ok) return parsed.response;
  const owner = await new Accounts(d1Db(env.DB)).authenticateApiToken(parsed.token);
  if (!owner) return connectErrorResponse(401, 'unauthorized', 'The API token is invalid or revoked.');

  const handOver = (tunnelId: string, mode: 'new' | 'resume') => {
    const headers = new Headers(request.headers);
    headers.set(InternalHeader.ROUTE, 'connect');
    headers.set(InternalHeader.MODE, mode);
    headers.set(InternalHeader.OWNER, JSON.stringify(owner satisfies TunnelOwner));
    headers.set(InternalHeader.TUNNEL_ID, tunnelId);
    return tunnelStub(env, tunnelId).fetch(new Request(request, { headers }));
  };

  if (parsed.resume && isTunnelId(parsed.resume.tunnelId)) {
    const response = await handOver(parsed.resume.tunnelId, 'resume');
    if (response.status === 101) {
      await directory(env).setToken(parsed.resume.tunnelId, owner.tokenId);
      return response;
    }
    if (response.status !== 409) return response;
    // Expired or not ours: fall through to a new tunnel, and the client reports the new URL.
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const tunnelId = generateTunnelId();
    if (!(await directory(env).reserve(tunnelId, owner))) continue;
    const response = await handOver(tunnelId, 'new');
    if (response.status !== 101) await directory(env).release(tunnelId);
    return response;
  }
  return connectErrorResponse(503, 'no_tunnel_id', 'Could not allocate a tunnel ID, try again.');
}

let cachedApp: { env: Env; app: ReturnType<typeof createApp> } | undefined;

/** The account dashboard, built once per isolate. */
function dashboard(env: Env) {
  if (cachedApp?.env === env) return cachedApp.app;
  const { domain, scheme } = relayConfig(env);
  const app = createApp({
    accounts: new Accounts(d1Db(env.DB)),
    mailer: logMailer(),
    publicOrigin: `${scheme}://${domain}`,
    setupToken: env.VIA443_SETUP_TOKEN,
    onAccessRevoked: async (match) => {
      const tunnels = directory(env);
      const ids = await tunnels.find(match);
      await Promise.all(
        ids.map(async (id) => {
          await tunnelStub(env, id).revoke();
          await tunnels.release(id);
        }),
      );
    },
  });
  cachedApp = { env, app };
  return app;
}
