import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { ConnectRefusedError, openTunnel, type Tunnel } from 'via443';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { Accounts, createApp, logMailer } from '@via443/server';
import { migrate, sqliteDb } from '@via443/server/node';
import { createRelay, type Relay, TunnelRegistry } from '../src/index.ts';
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        (server as http.Server).closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** A local app that echoes what it received. */
async function startApp(): Promise<number> {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/big') {
      const size = Number(req.headers['x-size']);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(256 * 1024, 7);
      for (let sent = 0; sent < size; sent += chunk.length) {
        if (!res.write(chunk.subarray(0, Math.min(chunk.length, size - sent)))) await once(res, 'drain');
      }
      res.end();
      return;
    }
    let bytes = 0;
    let body = '';
    for await (const chunk of req) {
      bytes += (chunk as Buffer).length;
      if (body.length < 1024) body += chunk;
    }
    if (req.url === '/no-content') {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('set-cookie', ['a=1', 'b=2']);
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        forwardedHost: req.headers['x-forwarded-host'],
        forwardedFor: req.headers['x-forwarded-for'],
        bytes,
        body: body.slice(0, 100),
      }),
    );
  });
  return listen(server);
}

/**
 * A relay for domain `localhost` with an in-memory accounts DB and one user
 * holding an API token. Visitors' Host headers carry no port, so the listening
 * port doesn't matter.
 */
async function startRelay(scheme: 'http' | 'https' = 'http') {
  const sqlite = new DatabaseSync(':memory:');
  migrate(sqlite);
  const accounts = new Accounts(sqliteDb(sqlite));
  const admin = await accounts.createFirstAdmin('admin@example.com');
  const { token, info } = await accounts.createApiToken(admin.id, 'test');
  const registry = new TunnelRegistry();
  const relay: Relay = createRelay({
    domain: 'localhost',
    scheme,
    trustProxy: false,
    authenticate: (t) => accounts.authenticateApiToken(t),
    app: createApp({
      accounts,
      mailer: logMailer(() => {}),
      publicOrigin: `${scheme}://localhost`,
      onAccessRevoked: (match) => void registry.revoke(match),
    }),
    registry,
  });
  const port = await listen(relay.server);
  cleanups.push(() => sqlite.close());
  return { port, registry, accounts, token, tokenId: info.id, userId: admin.id };
}

async function startTunnel(options: Parameters<typeof openTunnel>[0]): Promise<Tunnel> {
  const tunnel = await openTunnel({ env: {}, ...options });
  cleanups.push(() => tunnel.close());
  return tunnel;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Sends a request to the relay as a visitor of `publicUrl`. */
function visit(relayPort: number, publicUrl: string, path: string, init: { method?: string; body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: relayPort, path, method: init.method ?? 'GET', headers: { ...init.headers, host: new URL(publicUrl).host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

const json = (reply: Reply) => JSON.parse(reply.body.toString()) as Record<string, unknown>;

describe('tunnel over plain HTTP relay', () => {
  it('forwards requests and responses', async () => {
    const appPort = await startApp();
    const relay = await startRelay();
    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });
    expect(tunnel.url).toMatch(/^http:\/\/[a-z0-9]{8}\.localhost$/);

    const reply = await visit(relay.port, tunnel.url, '/echo?x=1', { method: 'POST', body: 'hello' });
    expect(reply.status).toBe(200);
    expect(reply.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(json(reply)).toMatchObject({
      method: 'POST',
      url: '/echo?x=1',
      host: `127.0.0.1:${appPort}`,
      forwardedHost: new URL(tunnel.url).host,
      forwardedFor: '127.0.0.1',
      body: 'hello',
    });

    const noContent = await visit(relay.port, tunnel.url, '/no-content');
    expect(noContent.status).toBe(204);
  });

  it('streams large bodies in both directions', async () => {
    const appPort = await startApp();
    const relay = await startRelay();
    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });

    const upload = await visit(relay.port, tunnel.url, '/upload', { method: 'POST', body: Buffer.alloc(8 * 1024 * 1024, 1) });
    expect(json(upload).bytes).toBe(8 * 1024 * 1024);

    const download = await visit(relay.port, tunnel.url, '/big', { headers: { 'x-size': String(8 * 1024 * 1024) } });
    expect(download.status).toBe(200);
    expect(download.body.length).toBe(8 * 1024 * 1024);
    expect(download.body.every((b) => b === 7)).toBe(true);
  });

  it('slows the local server down to the pace of a slow visitor', async () => {
    const size = 64 * 1024 * 1024;
    let written = 0;
    const app = http.createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 3);
      while (written < size) {
        written += chunk.length;
        if (!res.write(chunk)) await once(res, 'drain');
      }
      res.end();
    });
    const appPort = await listen(app);
    const relay = await startRelay();
    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });

    const req = http.get({ host: '127.0.0.1', port: relay.port, path: '/', headers: { host: new URL(tunnel.url).host } });
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    res.pause();
    await new Promise((r) => setTimeout(r, 500));
    expect(written).toBeLessThan(size / 4);

    let received = 0;
    res.on('data', (c: Buffer) => (received += c.length));
    res.resume();
    await once(res, 'end');
    expect(received).toBe(size);
  });

  it('slows a visitor upload down to the pace of a slow local server', async () => {
    const size = 64 * 1024 * 1024;
    let readable!: http.IncomingMessage;
    let response!: http.ServerResponse;
    const app = http.createServer((req, res) => {
      req.pause();
      readable = req;
      response = res;
    });
    const appPort = await listen(app);
    const relay = await startRelay();
    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });

    let sent = 0;
    const req = http.request({ host: '127.0.0.1', port: relay.port, path: '/', method: 'POST', headers: { host: new URL(tunnel.url).host } });
    const chunk = Buffer.alloc(64 * 1024, 5);
    const uploading = (async () => {
      while (sent < size) {
        sent += chunk.length;
        if (!req.write(chunk)) await once(req, 'drain');
      }
      req.end();
    })();
    await new Promise((r) => setTimeout(r, 500));
    expect(sent).toBeLessThan(size / 4);

    let received = 0;
    readable.on('data', (c: Buffer) => (received += c.length));
    readable.resume();
    await once(readable, 'end');
    await uploading;
    response.end('ok');
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    expect(res.statusCode).toBe(200);
    expect(received).toBe(size);
  });

  it('handles many concurrent requests', async () => {
    const appPort = await startApp();
    const relay = await startRelay();
    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });
    const replies = await Promise.all(
      Array.from({ length: 100 }, (_, i) => visit(relay.port, tunnel.url, `/n/${i}`, { method: 'POST', body: `body-${i}` })),
    );
    replies.forEach((reply, i) => {
      expect(json(reply)).toMatchObject({ url: `/n/${i}`, body: `body-${i}` });
    });
  });

  it('answers 502 when the local server is down', async () => {
    const relay = await startRelay();
    const closed = http.createServer();
    const deadPort = await listen(closed);
    await new Promise<void>((r) => closed.close(() => r()));
    const tunnel = await startTunnel({ port: deadPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });
    const reply = await visit(relay.port, tunnel.url, '/');
    expect(reply.status).toBe(502);
    expect(reply.body.toString()).toContain('ECONNREFUSED');
  });

  it('answers 404 for unknown tunnels and rejects bad tokens', async () => {
    const relay = await startRelay();
    expect((await visit(relay.port, 'http://abcd1234.localhost', '/')).status).toBe(404);

    const error = await openTunnel({ port: 1, server: `http://localhost:${relay.port}`, token: 'wrong', env: {} }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConnectRefusedError);
    expect((error as ConnectRefusedError).status).toBe(401);
    expect((error as ConnectRefusedError).fatal).toBe(true);
  });

  it('reconnects and keeps the same URL', async () => {
    const appPort = await startApp();
    const relay = await startRelay();
    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });
    const url = tunnel.url;

    const reconnected = once(tunnel, 'reconnected');
    relay.registry.get(tunnel.tunnelId)!.close(1001, 'test restart');
    await reconnected;

    expect(tunnel.url).toBe(url);
    expect((await visit(relay.port, url, '/after')).status).toBe(200);
  });
});

/**
 * A local app with a WebSocket endpoint that greets with the upgrade request's
 * details, then echoes. `/ws/refuse` answers 403 instead of upgrading, and a
 * `close:<code>` message makes the server close with that code.
 */
async function startWsApp() {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (offered) => (offered.has('v2') ? 'v2' : false) });
  const closes: { code: number; reason: string }[] = [];
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws/refuse') {
      socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nset-cookie: a=1\r\nset-cookie: b=2\r\ncontent-length: 7\r\n\r\nno way!');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ url: req.url, host: req.headers.host, cookie: req.headers.cookie, forwardedHost: req.headers['x-forwarded-host'] }));
      ws.on('message', (data, isBinary) => {
        const text = isBinary ? '' : data.toString();
        if (text.startsWith('close:')) ws.close(Number(text.slice(6)), 'bye');
        else ws.send(data, { binary: isBinary });
      });
      ws.on('close', (code, reason) => closes.push({ code, reason: reason.toString() }));
    });
  });
  cleanups.push(() => {
    for (const ws of wss.clients) ws.terminate();
  });
  return { port: await listen(server), closes };
}

/** Opens a visitor WebSocket to `publicUrl` through the relay. */
function visitWs(relayPort: number, publicUrl: string, path: string, protocols: string[] = [], headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${path}`, protocols, { headers: { ...headers, host: new URL(publicUrl).host } });
  const messages: (string | Buffer)[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (data: Buffer, isBinary) => {
    messages.push(isBinary ? data : data.toString());
    for (const wake of waiters.splice(0)) wake();
  });
  ws.on('error', () => {});
  cleanups.push(() => ws.terminate());
  /** Waits until `count` messages have arrived in total. */
  const received = async (count: number) => {
    while (messages.length < count) await new Promise<void>((r) => waiters.push(r));
    return messages;
  };
  return { ws, received };
}

describe('WebSockets through the tunnel', () => {
  async function setup() {
    const app = await startWsApp();
    const relay = await startRelay();
    const tunnel = await startTunnel({ port: app.port, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });
    return { app, relay, tunnel };
  }

  it('passes text and binary messages both ways, with the negotiated subprotocol', async () => {
    const { app, relay, tunnel } = await setup();
    const { ws, received } = visitWs(relay.port, tunnel.url, '/ws/hmr?token=x', ['v1', 'v2'], { cookie: 'sid=1' });
    await once(ws, 'open');
    expect(ws.protocol).toBe('v2');

    const [greeting] = await received(1);
    expect(JSON.parse(greeting as string)).toEqual({
      url: '/ws/hmr?token=x',
      host: `127.0.0.1:${app.port}`,
      cookie: 'sid=1',
      forwardedHost: new URL(tunnel.url).host,
    });

    ws.send('hello');
    ws.send(Buffer.from([1, 2, 3]));
    ws.send('');
    const messages = await received(4);
    expect(messages.slice(1)).toEqual(['hello', Buffer.from([1, 2, 3]), '']);
  });

  it('carries messages larger than the flow-control window, in order', async () => {
    const { relay, tunnel } = await setup();
    const { ws, received } = visitWs(relay.port, tunnel.url, '/ws');
    await once(ws, 'open');
    const big = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    ws.send(big);
    for (let i = 0; i < 200; i++) ws.send(`m${i}`);
    const messages = await received(202);
    expect(Buffer.compare(messages[1] as Buffer, big)).toBe(0);
    expect(messages.slice(2)).toEqual(Array.from({ length: 200 }, (_, i) => `m${i}`));
  });

  it('passes close codes and reasons in both directions', async () => {
    const { app, relay, tunnel } = await setup();
    const fromServer = visitWs(relay.port, tunnel.url, '/ws');
    await once(fromServer.ws, 'open');
    fromServer.ws.send('close:4000');
    const [code, reason] = (await once(fromServer.ws, 'close')) as [number, Buffer];
    expect([code, reason.toString()]).toEqual([4000, 'bye']);

    const fromVisitor = visitWs(relay.port, tunnel.url, '/ws');
    await once(fromVisitor.ws, 'open');
    fromVisitor.ws.close(4001, 'see you');
    await once(fromVisitor.ws, 'close');
    while (app.closes.length < 2) await new Promise((r) => setTimeout(r, 10));
    expect(app.closes).toContainEqual({ code: 4001, reason: 'see you' });
  });

  it("passes on the local server's refusal to upgrade", async () => {
    const { relay, tunnel } = await setup();
    const { ws } = visitWs(relay.port, tunnel.url, '/ws/refuse');
    const [, res] = (await once(ws, 'unexpected-response')) as [unknown, http.IncomingMessage];
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    let body = '';
    for await (const chunk of res) body += chunk;
    expect(body).toBe('no way!');
  });

  it('answers 502 when the local server is down, and closes sockets when the tunnel goes away', async () => {
    const relay = await startRelay();
    const closed = http.createServer();
    const deadPort = await listen(closed);
    await new Promise<void>((r) => closed.close(() => r()));
    const dead = await startTunnel({ port: deadPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });
    const refused = visitWs(relay.port, dead.url, '/ws');
    const [, res] = (await once(refused.ws, 'unexpected-response')) as [unknown, http.IncomingMessage];
    expect(res.statusCode).toBe(502);

    const app = await startWsApp();
    const tunnel = await startTunnel({ port: app.port, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });
    const { ws } = visitWs(relay.port, tunnel.url, '/ws');
    await once(ws, 'open');
    await tunnel.close();
    const [code] = (await once(ws, 'close')) as [number];
    expect(code).toBe(1001);
  });
});

describe('accounts on the relay', () => {
  it('serves the dashboard on the apex domain', async () => {
    const relay = await startRelay();
    const reply = await visit(relay.port, 'http://localhost', '/');
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toContain('invite-only');
  });

  it('drops a live tunnel as soon as its token is revoked in the dashboard', async () => {
    const appPort = await startApp();
    const relay = await startRelay();
    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `http://localhost:${relay.port}`, token: relay.token });
    expect((await visit(relay.port, tunnel.url, '/')).status).toBe(200);

    const failed = once(tunnel, 'error');
    const session = await relay.accounts.createSession(relay.userId);
    const revoke = await visit(relay.port, 'http://localhost', `/tokens/${relay.tokenId}/revoke`, {
      method: 'POST',
      headers: { cookie: `via443_session=${session}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(revoke.status).toBe(303);

    const [error] = await failed;
    expect(error).toBeInstanceOf(ConnectRefusedError);
    expect((error as ConnectRefusedError).status).toBe(401);
    expect((await visit(relay.port, tunnel.url, '/')).status).toBe(404);
  });
});

describe('tunnel over TLS through a CONNECT proxy', () => {
  let dir: string;
  let cert: string;
  let key: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'via443-test-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    key = readFileSync(join(dir, 'key.pem'), 'utf8');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** TLS in front of the relay, like Caddy in a self-hosted setup. */
  async function startTlsFront(relayPort: number): Promise<number> {
    const front = tls.createServer({ cert, key }, (socket) => {
      const upstream = net.connect(relayPort, '127.0.0.1');
      socket.pipe(upstream).pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    });
    return listen(front);
  }

  /** A CONNECT-only proxy that records which targets were requested. */
  async function startProxy(): Promise<{ port: number; connects: string[] }> {
    const connects: string[] = [];
    const proxy = http.createServer((_req, res) => res.writeHead(405).end());
    proxy.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      connects.push(req.url!);
      const [host, port] = req.url!.split(':');
      const upstream = net.connect(Number(port), host === 'localhost' ? '127.0.0.1' : host);
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    return { port: await listen(proxy), connects };
  }

  it('connects through the proxy, verifying TLS against the provided CA', async () => {
    const appPort = await startApp();
    const relay = await startRelay('https');
    const frontPort = await startTlsFront(relay.port);
    const proxy = await startProxy();
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };

    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `https://localhost:${frontPort}`, token: relay.token, env, ca: [cert] });
    expect(proxy.connects).toEqual([`localhost:${frontPort}`]);
    expect(tunnel.url).toMatch(/^https:\/\/[a-z0-9]{8}\.localhost$/);

    const reply = await visit(relay.port, tunnel.url, '/via-proxy', { method: 'POST', body: 'through the proxy' });
    expect(json(reply)).toMatchObject({ url: '/via-proxy', body: 'through the proxy' });
  });

  it('refuses a relay certificate it does not trust', async () => {
    const relay = await startRelay('https');
    const frontPort = await startTlsFront(relay.port);
    const proxy = await startProxy();
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    await expect(openTunnel({ port: 1, server: `https://localhost:${frontPort}`, token: relay.token, env })).rejects.toThrow(
      /self-signed certificate/,
    );
  });
});
