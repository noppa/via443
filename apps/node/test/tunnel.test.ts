import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { Accounts, createApp, logMailer } from '@via443/server';
import { migrate, sqliteDb } from '@via443/server/node';
import {
  cleanup,
  describeRelay,
  json,
  listen,
  type RelayHarness,
  runCleanups,
  startApp,
  startTunnel,
  visit,
} from '@via443/relay-tests';
import { openTunnel } from 'via443';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRelay, TunnelRegistry } from '../src/index.ts';

/** A fresh relay with an in-memory accounts DB and one admin user. */
async function startRelay(scheme: 'http' | 'https' = 'http'): Promise<RelayHarness> {
  const sqlite = new DatabaseSync(':memory:');
  migrate(sqlite);
  const accounts = new Accounts(sqliteDb(sqlite));
  const admin = await accounts.createFirstAdmin('admin@example.com');
  const registry = new TunnelRegistry();
  const relay = createRelay({
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
  cleanup(() => sqlite.close());
  return {
    port,
    async createToken() {
      const { token, info } = await accounts.createApiToken(admin.id, 'test');
      return {
        token,
        async revoke() {
          const session = await accounts.createSession(admin.id);
          const reply = await visit(port, `${scheme}://localhost`, `/tokens/${info.id}/revoke`, {
            method: 'POST',
            headers: { cookie: `via443_session=${session}`, origin: `${scheme}://localhost`, 'content-type': 'application/x-www-form-urlencoded' },
            body: '',
          });
          if (reply.status !== 303) throw new Error(`revoking the token failed with HTTP ${reply.status}`);
        },
      };
    },
  };
}

describeRelay('Node relay', () => startRelay());

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
  afterEach(runCleanups);

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
    const { token } = await relay.createToken();
    const frontPort = await startTlsFront(relay.port);
    const proxy = await startProxy();
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };

    const tunnel = await startTunnel({ port: appPort, host: '127.0.0.1', server: `https://localhost:${frontPort}`, token, env, ca: [cert] });
    expect(proxy.connects).toEqual([`localhost:${frontPort}`]);
    expect(tunnel.url).toMatch(/^https:\/\/[a-z0-9]{16}\.localhost$/);

    const reply = await visit(relay.port, tunnel.url, '/via-proxy', { method: 'POST', body: 'through the proxy' });
    expect(json(reply)).toMatchObject({ url: '/via-proxy', body: 'through the proxy' });
  });

  it('refuses a relay certificate it does not trust', async () => {
    const relay = await startRelay('https');
    const { token } = await relay.createToken();
    const frontPort = await startTlsFront(relay.port);
    const proxy = await startProxy();
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    await expect(openTunnel({ port: 1, server: `https://localhost:${frontPort}`, token, env })).rejects.toThrow(
      /self-signed certificate/,
    );
  });
});
