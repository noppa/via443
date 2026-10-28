/**
 * Checks the client package as npm users get it: packs it the way `pnpm
 * publish` does, installs the tarball into an empty project with npm, and runs
 * the installed CLI and library through a real tunnel to a local Node relay.
 *
 *   pnpm smoke:pack
 *
 * Needs the npm registry, to install `ws`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '@via443/server';
import { migrate, sqliteDb } from '@via443/server/node';
import { createRelay } from '../apps/node/src/index.ts';

const repo = join(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'via443-pack-'));
const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const step = (message: string) => console.log(`• ${message}`);

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** GETs `publicUrl` through the relay, as a visitor would. */
function visit(relayPort: number, publicUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: relayPort, path: '/', headers: { host: new URL(publicUrl).host } }, async (res) => {
        let body = '';
        for await (const chunk of res) body += chunk;
        resolve({ status: res.statusCode!, body });
      })
      .on('error', reject);
  });
}

const cleanups: (() => void)[] = [() => rmSync(work, { recursive: true, force: true })];
try {
  step('packing');
  run('pnpm', ['pack', '--pack-destination', work], join(repo, 'packages/client'));
  const tarball = join(work, readdirSync(work).find((f) => f.endsWith('.tgz'))!);
  const files = run('tar', ['-tzf', tarball], work).trim().split('\n').sort();
  console.log(files.map((f) => `    ${f}`).join('\n'));
  for (const required of ['package/LICENSE', 'package/README.md', 'package/dist/cli.js', 'package/dist/index.js', 'package/dist/index.d.ts']) {
    check(files.includes(required), `${required} is missing from the package`);
  }
  check(!files.some((f) => f.startsWith('package/src/') || f.startsWith('package/scripts/')), 'sources are in the package');

  const manifest = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json'], work));
  check(manifest.bin.via443 === './dist/cli.js', `bin points at ${manifest.bin.via443}`);
  check(manifest.exports['.'].default === './dist/index.js', 'exports does not point at dist');
  check(Object.keys(manifest.dependencies).join() === 'ws', `unexpected dependencies ${Object.keys(manifest.dependencies)}`);
  check(!JSON.stringify(manifest).includes('workspace:'), 'a workspace: protocol was left in package.json');

  step('installing the tarball with npm');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], app);
  const cli = join(app, 'node_modules/.bin/via443');
  check(run(cli, ['--version'], app).trim() === manifest.version, 'via443 --version does not match the package');

  step('type-checking a consumer against the shipped declarations');
  writeFileSync(
    join(app, 'check.ts'),
    `import { openTunnel, ConnectRefusedError, type RequestLogEntry } from 'via443';
const tunnel = await openTunnel({ port: 3000, token: 'x' });
tunnel.on('request', (entry: RequestLogEntry) => entry.status satisfies number | undefined);
const url: string = tunnel.url;
new ConnectRefusedError(401, { code: 'unauthorized' }).fatal satisfies boolean;
export { url };
`,
  );
  run(
    join(repo, 'node_modules/.bin/tsc'),
    ['--noEmit', '--strict', '--module', 'nodenext', '--target', 'es2023', '--typeRoots', join(repo, 'node_modules/@types'), '--types', 'node', 'check.ts'],
    app,
  );

  step('opening tunnels with the installed CLI and library');
  const sqlite = new DatabaseSync(':memory:');
  migrate(sqlite);
  const accounts = new Accounts(sqliteDb(sqlite));
  const admin = await accounts.createFirstAdmin('smoke@example.com');
  const { token } = await accounts.createApiToken(admin.id, 'smoke');
  const relay = createRelay({ domain: 'localhost', scheme: 'http', trustProxy: false, authenticate: (t) => accounts.authenticateApiToken(t) });
  const relayPort = await listen(relay.server);
  cleanups.push(() => void relay.close());
  const local = http.createServer((_req, res) => res.end('hello from the local app'));
  const appPort = await listen(local);
  cleanups.push(() => local.close());

  const child = spawn(cli, ['--port', String(appPort), '--host', '127.0.0.1', '--server', `http://localhost:${relayPort}`, '--token', token], {
    cwd: app,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => child.kill());
  const [line] = (await once(child.stdout, 'data')) as [Buffer];
  const cliUrl = line.toString().trim();
  const viaCli = await visit(relayPort, cliUrl);
  check(viaCli.status === 200 && viaCli.body === 'hello from the local app', `CLI tunnel answered ${viaCli.status}: ${viaCli.body}`);
  console.log(`    CLI: ${cliUrl} → ${viaCli.status}`);

  writeFileSync(
    join(app, 'lib.js'),
    `import { openTunnel } from 'via443';
const tunnel = await openTunnel({ port: ${appPort}, host: '127.0.0.1', server: 'http://localhost:${relayPort}', token: process.argv[2], env: {} });
console.log(tunnel.url);
await new Promise((r) => process.stdin.once('data', r));
await tunnel.close();
`,
  );
  const lib = spawn(process.execPath, ['lib.js', token], { cwd: app, stdio: ['pipe', 'pipe', 'inherit'] });
  cleanups.push(() => lib.kill());
  const [libLine] = (await once(lib.stdout, 'data')) as [Buffer];
  const libUrl = libLine.toString().trim();
  const viaLib = await visit(relayPort, libUrl);
  check(viaLib.status === 200, `library tunnel answered ${viaLib.status}`);
  console.log(`    library: ${libUrl} → ${viaLib.status}`);
  lib.stdin.end('\n');

  console.log(`\nvia443 ${manifest.version} is ready to publish.`);
} finally {
  for (const fn of cleanups.reverse()) fn();
}
process.exit(0);
