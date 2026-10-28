import { EventEmitter } from 'node:events';
import {
  CONNECT_PATH,
  type ConnectError,
  ConnectHeader,
  decodeFrame,
  decodeGoAway,
  decodeWelcome,
  encodeFrame,
  encodeGoAway,
  type Frame,
  FrameType,
  formatResume,
  PROTOCOL_VERSION,
  ProtocolError,
  type Welcome,
} from '@via443/protocol';
import WebSocket from 'ws';
import { LocalForwarder, type RequestLogEntry } from './forward.ts';
import { openSocket, proxyFor, trustedCAs } from './network.ts';

export const DEFAULT_SERVER = 'via443.com';

export interface TunnelOptions {
  /** Local port to expose. */
  port: number;
  /** Local host to forward to. Default `localhost`. */
  host?: string;
  /** Relay domain or URL, e.g. `via443.com` or `http://localhost:8080`. Default `via443.com`. */
  server?: string;
  /** API token. */
  token: string;
  /** CA certificates to trust instead of the defaults derived from the environment. */
  ca?: string[];
  /** Environment for proxy and CA settings. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface TunnelEvents {
  /** The tunnel's public URL changed after a reconnect, because the relay could not resume it. */
  url: [url: string];
  request: [entry: RequestLogEntry];
  disconnected: [reason: string];
  reconnecting: [attempt: number, delayMs: number];
  reconnected: [];
  /** A non-recoverable error; the tunnel closes after this. */
  error: [err: Error];
  close: [];
}

/** The relay refused the connection with an HTTP error before the WebSocket opened. */
export class ConnectRefusedError extends Error {
  override name = 'ConnectRefusedError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, body: Partial<ConnectError>) {
    super(body.message ?? `relay answered HTTP ${status}`);
    this.status = status;
    this.code = body.code ?? 'http_error';
  }
  /** Authentication and version errors won't fix themselves by retrying. */
  get fatal(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 426;
  }
}

const PING_INTERVAL_MS = 25_000;
const IDLE_TIMEOUT_MS = 70_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

/** Turns `via443.com`, `https://via443.com` or `http://localhost:8080` into the /connect WebSocket URL. */
export function connectUrl(server: string): URL {
  const url = new URL(server.includes('://') ? server : `https://${server}`);
  if (url.protocol === 'https:' || url.protocol === 'wss:') url.protocol = 'wss:';
  else if (url.protocol === 'http:' || url.protocol === 'ws:') url.protocol = 'ws:';
  else throw new Error(`unsupported server URL ${server}`);
  url.pathname = CONNECT_PATH;
  url.search = '';
  url.hash = '';
  return url;
}

/** Opens a tunnel and resolves once the relay has assigned its public URL. */
export async function openTunnel(options: TunnelOptions): Promise<Tunnel> {
  const tunnel = new Tunnel(options);
  await tunnel.start();
  return tunnel;
}

export class Tunnel extends EventEmitter<TunnelEvents> {
  readonly #options: Required<Omit<TunnelOptions, 'ca'>> & { ca: string[] | undefined };
  #welcome: Welcome | undefined;
  #ws: WebSocket | undefined;
  #closing = false;
  #closed: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: TunnelOptions) {
    super();
    const env = options.env ?? process.env;
    this.#options = {
      host: 'localhost',
      server: DEFAULT_SERVER,
      ...options,
      env,
      ca: options.ca ?? trustedCAs(env),
    };
  }

  get url(): string {
    if (!this.#welcome) throw new Error('tunnel is not connected yet');
    return this.#welcome.url;
  }

  get tunnelId(): string {
    if (!this.#welcome) throw new Error('tunnel is not connected yet');
    return this.#welcome.tunnelId;
  }

  /** @internal Use `openTunnel()`. */
  async start(): Promise<void> {
    await this.#connect();
  }

  /** Closes the tunnel. The public URL stops working immediately. */
  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#closing = true;
    this.#wake?.();
    this.#closed = new Promise<void>((resolve) => {
      const ws = this.#ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once('close', () => resolve());
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame(encodeGoAway({ code: 'client_closed', message: 'tunnel closed by the client' })));
        ws.close(1000, 'client closed');
      } else {
        ws.terminate();
      }
      setTimeout(() => ws.terminate(), 2000).unref();
    }).then(() => {
      this.emit('close');
    });
    return this.#closed;
  }

  async #connect(): Promise<void> {
    const { server, token, env, ca, host, port } = this.#options;
    const target = connectUrl(server);
    const socket = await openSocket({ target, proxy: proxyFor(target, env), ca });

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      [ConnectHeader.PROTOCOL]: String(PROTOCOL_VERSION),
    };
    if (this.#welcome) {
      headers[ConnectHeader.RESUME] = formatResume({
        tunnelId: this.#welcome.tunnelId,
        resumeToken: this.#welcome.resumeToken,
      });
    }

    const ws = new WebSocket(target, {
      createConnection: () => socket,
      headers,
      perMessageDeflate: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    ws.binaryType = 'nodebuffer';

    const welcome = await waitForWelcome(ws);
    const previousUrl = this.#welcome?.url;
    this.#welcome = welcome;
    this.#ws = ws;
    if (previousUrl && previousUrl !== welcome.url) this.emit('url', welcome.url);

    const send = (frame: Frame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame));
    };
    const forwarder = new LocalForwarder({ host, port }, send, (entry) => this.emit('request', entry));

    let lastSeen = Date.now();
    const keepalive = setInterval(() => {
      if (Date.now() - lastSeen > IDLE_TIMEOUT_MS) {
        ws.terminate();
        return;
      }
      send({ type: FrameType.PING, flags: 0, streamId: 0, payload: new Uint8Array() });
    }, PING_INTERVAL_MS);
    keepalive.unref();

    let closeReason = 'connection closed';
    ws.on('message', (data: Buffer) => {
      lastSeen = Date.now();
      try {
        const frame = decodeFrame(data);
        switch (frame.type) {
          case FrameType.PING:
            send({ type: FrameType.PONG, flags: 0, streamId: 0, payload: frame.payload });
            break;
          case FrameType.PONG:
            break;
          case FrameType.GOAWAY: {
            const goAway = decodeGoAway(frame);
            closeReason = `${goAway.code}: ${goAway.message}`;
            break;
          }
          case FrameType.WELCOME:
            throw new ProtocolError('unexpected second WELCOME');
          default:
            forwarder.handle(frame);
        }
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw err;
        closeReason = `protocol error: ${err.message}`;
        ws.close(1002, err.message.slice(0, 120));
      }
    });
    ws.on('error', (err) => {
      closeReason = err.message;
    });
    ws.on('close', (code, reason) => {
      clearInterval(keepalive);
      forwarder.abortAll();
      if (this.#closing) return;
      const detail = reason.length > 0 ? reason.toString() : closeReason;
      this.emit('disconnected', `${detail} (code ${code})`);
      void this.#reconnect();
    });
  }

  async #reconnect(): Promise<void> {
    for (let attempt = 1; !this.#closing; attempt++) {
      const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
      const delayMs = Math.round(base * (0.5 + Math.random() / 2));
      this.emit('reconnecting', attempt, delayMs);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = undefined;
      if (this.#closing) return;
      try {
        await this.#connect();
        this.emit('reconnected');
        return;
      } catch (err) {
        if (err instanceof ConnectRefusedError && err.fatal) {
          this.emit('error', err);
          await this.close();
          return;
        }
        this.emit('disconnected', (err as Error).message);
      }
    }
  }
}

function waitForWelcome(ws: WebSocket): Promise<Welcome> {
  return new Promise<Welcome>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('timed out waiting for the relay to accept the tunnel')), HANDSHAKE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
      ws.off('unexpected-response', onUnexpectedResponse);
    };
    const fail = (err: Error) => {
      cleanup();
      // Aborting a connecting socket emits 'error'; the rejection already reports the failure.
      ws.on('error', () => {});
      ws.terminate();
      reject(err);
    };
    const onMessage = (data: Buffer) => {
      try {
        const frame = decodeFrame(data);
        if (frame.type === FrameType.GOAWAY) {
          const goAway = decodeGoAway(frame);
          fail(new ConnectRefusedError(403, goAway));
          return;
        }
        const welcome = decodeWelcome(frame);
        cleanup();
        resolve(welcome);
      } catch (err) {
        fail(err as Error);
      }
    };
    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error('the relay closed the connection before accepting the tunnel'));
    const onUnexpectedResponse = (_req: unknown, res: import('node:http').IncomingMessage) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 16 * 1024) body += chunk;
      });
      res.on('end', () => {
        let parsed: Partial<ConnectError> = {};
        try {
          parsed = JSON.parse(body) as Partial<ConnectError>;
        } catch {
          // Not our relay, or a proxy error page.
        }
        fail(new ConnectRefusedError(res.statusCode ?? 0, parsed));
      });
      res.on('error', onError);
    };
    ws.on('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);
    ws.once('unexpected-response', onUnexpectedResponse);
  });
}
