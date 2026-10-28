import { once } from 'node:events';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { CONNECT_PATH, MAX_WS_MESSAGE, PROTOCOL_VERSION } from '@via443/protocol';
import {
  connectErrorResponse,
  matchHost,
  parseConnectRequest,
  TunnelSession,
  tunnelErrorResponse,
} from '@via443/relay-core';
import { type WebSocket, WebSocketServer } from 'ws';
import { RateLimiter } from './rate-limit.ts';
import { type TunnelOwner, TunnelRegistry } from './registry.ts';

/** Checks a client's API token. Null rejects the connection. */
export type Authenticate = (token: string) => Promise<TunnelOwner | null>;

/** Anything with a fetch handler, e.g. the Hono dashboard app from @via443/server. */
export interface FetchHandler {
  fetch(request: Request): Response | Promise<Response>;
}

export interface RelayConfig {
  /** Public domain, e.g. `via443.com`, or `localhost:8080` for local development. */
  domain: string;
  /** Scheme of public URLs. `https` behind a TLS-terminating proxy such as Caddy. */
  scheme: 'http' | 'https';
  /** Use the last X-Forwarded-For entry as the visitor's IP. Only behind a trusted reverse proxy. */
  trustProxy: boolean;
  authenticate: Authenticate;
  /** Serves everything on the apex domain except `/connect`. */
  app?: FetchHandler;
  /** Pass one in to reach it before the relay exists, e.g. to drop tunnels on revocation. */
  registry?: TunnelRegistry;
  /** How long a disconnected tunnel keeps its ID for a resume. Ignored when `registry` is given. */
  resumeGraceMs?: number;
}

/** A client that sent nothing (not even a PING) for this long is considered gone. */
const CLIENT_IDLE_TIMEOUT_MS = 75_000;

export interface Relay {
  server: http.Server;
  registry: TunnelRegistry;
  close(): Promise<void>;
}

export function createRelay(config: RelayConfig): Relay {
  const registry = config.registry ?? new TunnelRegistry(config.resumeGraceMs);
  const unknownTunnelHits = new RateLimiter(30, 10 * 60_000);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  /** Subprotocol the local server picked, per visitor upgrade request. */
  const visitorProtocols = new WeakMap<http.IncomingMessage, string>();
  const visitorWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_MESSAGE,
    handleProtocols: (_offered, req) => visitorProtocols.get(req) ?? false,
  });

  const clientIp = (req: http.IncomingMessage): string | undefined => {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').at(-1)?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress;
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      console.error('via443: request failed', err);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = matchHost(req.headers.host, config.domain);
    if (host.kind === 'apex') {
      const response = config.app
        ? await config.app.fetch(toRequest(req, config.scheme))
        : apexResponse(req);
      await writeResponse(res, response);
      return;
    }
    if (host.kind === 'unknown') {
      await writeResponse(res, tunnelErrorResponse(404, 'unknown host.'));
      return;
    }

    const ip = clientIp(req);
    const session = findTunnel(host.tunnelId, ip);
    if (session instanceof Response) {
      await writeResponse(res, session);
      return;
    }

    const aborted = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) aborted.abort();
    });
    const response = await session.handleRequest(toRequest(req, config.scheme, aborted.signal), {
      proto: config.scheme,
      clientIp: ip,
    });
    await writeResponse(res, response);
  }

  /** The session for a tunnel host, or the error to answer; rate-limits guessing at tunnel IDs. */
  function findTunnel(tunnelId: string, ip: string | undefined): TunnelSession | Response {
    if (ip && unknownTunnelHits.isLimited(ip)) {
      return tunnelErrorResponse(429, 'too many requests to unknown tunnels, try again later.');
    }
    const session = registry.get(tunnelId);
    if (!session) {
      if (ip) unknownTunnelHits.hit(ip);
      return tunnelErrorResponse(404, 'no tunnel is connected at this address.');
    }
    return session;
  }

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head).catch((err: unknown) => {
      console.error('via443: upgrade failed', err);
      socket.destroy();
    });
  });

  async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const host = matchHost(req.headers.host, config.domain);
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (host.kind === 'tunnel') {
      await handleVisitorUpgrade(host.tunnelId, req, socket, head);
      return;
    }
    if (host.kind !== 'apex' || path !== CONNECT_PATH) {
      writeRawResponse(socket, tunnelErrorResponse(404, 'not found.'));
      return;
    }

    const parsed = parseConnectRequest(toRequest(req, config.scheme));
    if (!parsed.ok) {
      writeRawResponse(socket, parsed.response);
      return;
    }
    const owner = await config.authenticate(parsed.token);
    if (!owner) {
      writeRawResponse(socket, connectErrorResponse(401, 'unauthorized', 'The API token is invalid or revoked.'));
      return;
    }

    const ws = await new Promise<import('ws').WebSocket>((resolve) => wss.handleUpgrade(req, socket, head, resolve));
    const session = new TunnelSession({
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    });
    let lastSeen = Date.now();
    ws.on('message', (data: Buffer, isBinary) => {
      lastSeen = Date.now();
      if (isBinary) session.receive(data);
      else session.close(1003, 'only binary frames are accepted');
    });
    const idleCheck = setInterval(() => {
      if (Date.now() - lastSeen > CLIENT_IDLE_TIMEOUT_MS) ws.terminate();
    }, 15_000);
    idleCheck.unref();

    const { tunnelId, resumeToken } = await registry.attach(owner, parsed.resume, session);
    ws.on('close', () => {
      clearInterval(idleCheck);
      session.closed();
      registry.detach(tunnelId, session);
    });
    ws.on('error', () => ws.terminate());
    session.welcome({ version: PROTOCOL_VERSION, tunnelId, url: `${config.scheme}://${tunnelId}.${config.domain}`, resumeToken });
  }

  /** Passes a visitor's WebSocket through the tunnel, once the local server has accepted it. */
  async function handleVisitorUpgrade(tunnelId: string, req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const ip = clientIp(req);
    const session = findTunnel(tunnelId, ip);
    if (session instanceof Response) {
      writeRawResponse(socket, session);
      return;
    }

    const aborted = new AbortController();
    const onSocketClose = () => aborted.abort();
    socket.once('close', onSocketClose);
    const result = await session.openWebSocket(toRequest(req, config.scheme, aborted.signal), {
      proto: config.scheme,
      clientIp: ip,
    });
    socket.off('close', onSocketClose);
    if (result instanceof Response) {
      writeRawResponse(socket, result);
      return;
    }
    if (socket.destroyed) {
      result.closed(1001, 'visitor went away');
      return;
    }

    if (result.protocol) visitorProtocols.set(req, result.protocol);
    const ws = await new Promise<WebSocket>((resolve) => visitorWss.handleUpgrade(req, socket, head, resolve));
    result.attach({
      send: (data, sent) => ws.send(data, () => sent()),
      close: (code, reason) => ws.close(code, reason),
      pause: () => ws.pause(),
      resume: () => ws.resume(),
    });
    ws.on('message', (data: Buffer, isBinary) => result.message(isBinary ? data : data.toString()));
    ws.on('close', (code, reason) => result.closed(code, reason.toString()));
    ws.on('error', () => ws.terminate());
  }

  return {
    server,
    registry,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      for (const ws of visitorWss.clients) ws.terminate();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

function apexResponse(req: http.IncomingMessage): Response {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/') {
    return new Response('via443 relay\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return tunnelErrorResponse(404, 'not found.');
}

/** Wraps a Node request as a web Request, streaming its body. */
function toRequest(req: http.IncomingMessage, scheme: string, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (!name.startsWith(':')) headers.append(name, req.rawHeaders[i + 1]!);
  }
  const hasBody = req.headers['content-length'] !== undefined
    ? req.headers['content-length'] !== '0'
    : req.headers['transfer-encoding'] !== undefined;
  return new Request(`${scheme}://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
    duplex: 'half',
    signal,
  } as RequestInit);
}

async function writeResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: string[] = [];
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') headers.push(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) headers.push('set-cookie', cookie);
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const closed = new Promise<void>((resolve) => res.once('close', resolve));
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), closed.then(() => undefined)]);
      if (!next) {
        // The visitor went away; cancelling the body resets the tunnel stream.
        await reader.cancel().catch(() => {});
        return;
      }
      if (next.done) break;
      if (!res.write(next.value)) await Promise.race([once(res, 'drain'), closed]);
    }
    res.end();
  } catch {
    // The tunnel stream failed mid-body; drop the connection so the visitor sees a truncated response.
    res.destroy();
  }
}

/**
 * Writes a complete HTTP response to a socket that was not upgraded. Buffers
 * the body: these are error pages, or a local server's refusal of an upgrade.
 */
function writeRawResponse(socket: Duplex, response: Response): void {
  void response.arrayBuffer().then(
    (body) => {
      if (socket.destroyed) return;
      const lines = [`HTTP/1.1 ${response.status} ${http.STATUS_CODES[response.status] ?? ''}`];
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie' && name !== 'content-length' && name !== 'connection') lines.push(`${name}: ${value}`);
      }
      for (const cookie of response.headers.getSetCookie()) lines.push(`set-cookie: ${cookie}`);
      lines.push(`content-length: ${body.byteLength}`, 'connection: close');
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      socket.end(Buffer.from(body));
    },
    () => socket.destroy(),
  );
}
