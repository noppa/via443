import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describeRelay, type RelayHarness, visit } from '@via443/relay-tests';
import { afterAll, beforeAll, vi } from 'vitest';

/**
 * Runs the shared relay suite against the Worker, its Durable Objects and D1
 * under `wrangler dev` (workerd, the runtime Cloudflare runs in production).
 * One relay serves the whole file; the admin account is created through
 * `/setup` and tokens through the dashboard, like a real deployment.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const appDir = join(import.meta.dirname, '..');
const wrangler = join(appDir, 'node_modules', '.bin', 'wrangler');
const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
const origin = 'http://localhost';

let stateDir: string;
let dev: ChildProcess | undefined;
let port: number;
let sessionCookie: string;
let tokenCount = 0;

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

async function waitUntilUp(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let output = '';
  dev!.stdout!.on('data', (chunk) => (output += chunk));
  dev!.stderr!.on('data', (chunk) => (output += chunk));
  while (Date.now() < deadline) {
    if (dev!.exitCode !== null) throw new Error(`wrangler dev exited:\n${output}`);
    try {
      if ((await visit(port, origin, '/')).status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev did not come up:\n${output}`);
}

const form = { origin, 'content-type': 'application/x-www-form-urlencoded' };

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'via443-cf-'));
  await promisify(execFile)(wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir], {
    cwd: appDir,
    env: wranglerEnv,
  });

  port = await freePort();
  const setupToken = crypto.randomUUID();
  dev = spawn(
    wrangler,
    [
      'dev',
      '--ip', '127.0.0.1',
      '--port', String(port),
      '--persist-to', stateDir,
      '--var', 'VIA443_DOMAIN:localhost',
      '--var', 'VIA443_SCHEME:http',
      '--var', `VIA443_SETUP_TOKEN:${setupToken}`,
    ],
    { cwd: appDir, env: wranglerEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitUntilUp();

  const setup = await visit(port, origin, '/setup', {
    method: 'POST',
    headers: form,
    body: new URLSearchParams({ token: setupToken, email: 'admin@example.com' }).toString(),
  });
  if (setup.status !== 303) throw new Error(`setup failed with HTTP ${setup.status}: ${setup.body}`);
  sessionCookie = String(setup.headers['set-cookie']?.[0]).split(';')[0]!;
});

afterAll(() => {
  // wrangler runs workerd as a child; kill the whole group.
  if (dev?.pid) process.kill(-dev.pid, 'SIGTERM');
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

const relay: RelayHarness = {
  get port() {
    return port;
  },
  async createToken() {
    const created = await visit(port, origin, '/tokens', {
      method: 'POST',
      headers: { ...form, cookie: sessionCookie },
      body: `name=test-${++tokenCount}`,
    });
    const token = created.body.toString().match(/v443_[\w-]+/)?.[0];
    if (!token) throw new Error(`creating a token failed with HTTP ${created.status}`);

    // The dashboard lists tokens by their first 11 characters, next to the revoke form.
    const dashboard = (await visit(port, origin, '/', { headers: { cookie: sessionCookie } })).body.toString();
    const tokenId = dashboard.match(new RegExp(`<code>${token.slice(0, 11)}…</code>[\\s\\S]*?/tokens/([^/]+)/revoke`))?.[1];
    if (!tokenId) throw new Error('the new token is not on the dashboard');
    return {
      token,
      async revoke() {
        const reply = await visit(port, origin, `/tokens/${tokenId}/revoke`, {
          method: 'POST',
          headers: { ...form, cookie: sessionCookie },
          body: '',
        });
        if (reply.status !== 303) throw new Error(`revoking the token failed with HTTP ${reply.status}`);
      },
    };
  },
};

describeRelay('Cloudflare relay (wrangler dev)', async () => relay);
