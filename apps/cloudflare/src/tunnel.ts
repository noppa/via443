import { DurableObject } from 'cloudflare:workers';
import { PROTOCOL_VERSION, parseResume } from '@via443/protocol';
import {
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  connectErrorResponse,
  generateResumeToken,
  RESUME_GRACE_MS,
  sha256Hex,
  type TunnelOwner,
  TunnelSession,
  tunnelErrorResponse,
} from '@via443/relay-core';
import { d1Db } from '@via443/server';
import { TunnelDirectory } from './directory.ts';
import { type Env, InternalHeader, relayConfig } from './env.ts';

interface TunnelState {
  tunnelId: string;
  owner: TunnelOwner;
  resumeTokenHash: string;
  /** Tags the client WebSocket that currently serves the tunnel; older ones are being replaced. */
  connection: string;
}

interface SocketAttachment {
  connection: string;
}

/**
 * One tunnel. Holds the client's WebSocket and serves visitors' requests
 * through it. The client socket uses the hibernation API, so an idle tunnel
 * costs nothing while it waits; the session is rebuilt when a message or a
 * visitor wakes the object. Visitor WebSockets are ordinary ones, which keeps
 * the object (and the session's stream state) in memory while they're open.
 *
 * After the client disconnects, the tunnel ID stays reserved for a resume
 * until an alarm releases it.
 */
export class TunnelDO extends DurableObject<Env> {
  #state: TunnelState | undefined;
  #session: TunnelSession | undefined;
  #sessionSocket: WebSocket | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#state = await ctx.storage.get<TunnelState>('state');
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get(InternalHeader.ROUTE) === 'connect') return this.#connect(request);
    return this.#visit(request);
  }

  /** Closes the tunnel for good, because its token was revoked or its user disabled. */
  async revoke(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_REVOKED, 'access revoked');
    this.#session?.closed();
    this.#session = undefined;
    this.#state = undefined;
    await this.ctx.storage.deleteAll();
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.#sessionFor(ws);
    if (!session) return;
    if (typeof message === 'string') session.close(1003, 'only binary frames are accepted');
    else session.receive(new Uint8Array(message));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    await this.#disconnected(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#disconnected(ws);
  }

  /** Releases the tunnel ID once the resume grace period is over. */
  override async alarm(): Promise<void> {
    if (!this.#state || this.#currentSocket()) return;
    const { tunnelId } = this.#state;
    this.#state = undefined;
    await this.ctx.storage.deleteAll();
    await new TunnelDirectory(d1Db(this.env.DB)).release(tunnelId);
  }

  async #connect(request: Request): Promise<Response> {
    const owner = JSON.parse(request.headers.get(InternalHeader.OWNER) ?? 'null') as TunnelOwner;
    const state = this.#state;
    let tunnelId: string;
    if (request.headers.get(InternalHeader.MODE) === 'resume') {
      const resume = parseResume(request.headers.get('via443-resume'));
      if (
        !state ||
        !resume ||
        state.owner.userId !== owner.userId ||
        state.resumeTokenHash !== (await sha256Hex(resume.resumeToken))
      ) {
        return connectErrorResponse(409, 'resume_failed', 'The tunnel can no longer be resumed.');
      }
      tunnelId = state.tunnelId;
    } else {
      if (state) return connectErrorResponse(409, 'tunnel_taken', 'The tunnel ID is taken.');
      tunnelId = request.headers.get(InternalHeader.TUNNEL_ID) ?? '';
    }

    // A resumed connection replaces the old one, which may still look open if the client's network dropped silently.
    for (const old of this.ctx.getWebSockets()) old.close(CLOSE_REPLACED, 'replaced by a resumed connection');
    this.#session?.closed();
    this.#session = undefined;

    const resumeToken = generateResumeToken();
    const connection = crypto.randomUUID();
    this.#state = { tunnelId, owner, resumeTokenHash: await sha256Hex(resumeToken), connection };
    await this.ctx.storage.put('state', this.#state);
    await this.ctx.storage.deleteAlarm();

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connection } satisfies SocketAttachment);
    const { domain, scheme } = relayConfig(this.env);
    this.#sessionFor(server)!.welcome({
      version: PROTOCOL_VERSION,
      tunnelId,
      url: `${scheme}://${tunnelId}.${domain}`,
      resumeToken,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async #visit(request: Request): Promise<Response> {
    const socket = this.#currentSocket();
    const session = socket && this.#sessionFor(socket);
    if (!session || session.isClosed) return tunnelErrorResponse(404, 'no tunnel is connected at this address.');

    const headers = new Headers(request.headers);
    for (const name of Object.values(InternalHeader)) headers.delete(name);
    const req = new Request(request, { headers });
    const ctx = { proto: relayConfig(this.env).scheme, clientIp: request.headers.get('cf-connecting-ip') ?? undefined };

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return session.handleRequest(req, ctx);

    const result = await session.openWebSocket(req, ctx);
    if (result instanceof Response) return result;
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // Binary messages would otherwise arrive as Blobs.
    server.binaryType = 'arraybuffer';
    server.accept();
    result.attach({
      // Workers' WebSockets don't report when a message has left; count it as sent right away.
      send: (data, sent) => {
        server.send(data);
        sent();
      },
      close: (code, reason) => {
        try {
          if (code === undefined) server.close();
          else server.close(code, reason);
        } catch {
          // Already closed.
        }
      },
    });
    server.addEventListener('message', (event) =>
      result.message(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer)),
    );
    server.addEventListener('close', (event) => result.closed(event.code, event.reason));
    server.addEventListener('error', () => result.closed(1006));
    const responseHeaders = result.protocol ? { 'sec-websocket-protocol': result.protocol } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
  }

  /** The client WebSocket that serves the tunnel now, if it's connected. */
  #currentSocket(): WebSocket | undefined {
    const connection = this.#state?.connection;
    if (!connection) return undefined;
    return this.ctx
      .getWebSockets()
      .find((ws) => (ws.deserializeAttachment() as SocketAttachment | null)?.connection === connection);
  }

  /** The session on a client socket, rebuilt after hibernation. Undefined for a replaced socket. */
  #sessionFor(ws: WebSocket): TunnelSession | undefined {
    if (this.#session && this.#sessionSocket === ws) return this.#session;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!this.#state || attachment?.connection !== this.#state.connection) return undefined;
    this.#session = new TunnelSession({
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    });
    this.#sessionSocket = ws;
    return this.#session;
  }

  async #disconnected(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!this.#state || attachment?.connection !== this.#state.connection) return;
    if (this.#sessionSocket === ws) {
      this.#session?.closed();
      this.#session = undefined;
      this.#sessionSocket = undefined;
    }
    await this.ctx.storage.setAlarm(Date.now() + RESUME_GRACE_MS);
  }
}
