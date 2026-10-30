#!/usr/bin/env node
import { renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parsePorts, type PortSpec } from './ports.ts';
import { ConnectRefusedError, DEFAULT_SERVER, openTunnel, type Tunnel } from './tunnel.ts';

/** Set by the build; absent when running from source. */
declare const VIA443_VERSION: string | undefined;
const VERSION = typeof VIA443_VERSION === 'string' ? VIA443_VERSION : 'dev';

const USAGE = `Usage: via443 --port <port> [--port <name>=<port> ...] [options]

Exposes local servers at public https URLs. Only needs outbound HTTPS on
port 443, and works through an HTTP CONNECT proxy (HTTPS_PROXY).

Each --port gets its own URL. With several ports, the URLs are printed as
<name>=<url> lines; a port's name defaults to its number.

Options:
  -p, --port [<name>=]<port>
                         local port to expose (required, repeatable)
      --urls-file <path> write {"<name>": "<url>"} JSON here, and keep it
                         up to date if a URL changes after a reconnect
      --host <host>      local host to forward to (default: localhost)
      --server <server>  relay domain or URL (default: ${DEFAULT_SERVER}, env: VIA443_SERVER)
      --token <token>    API token (env: VIA443_TOKEN)
  -q, --quiet            don't log requests
  -v, --version          show the version
  -h, --help             show this help
`;

function fail(message: string): never {
  process.stderr.write(`via443: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: 'string', short: 'p', multiple: true },
        'urls-file': { type: 'string' },
        host: { type: 'string', default: 'localhost' },
        server: { type: 'string' },
        token: { type: 'string' },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`);
  }

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (!values.port?.length) fail(`--port is required\n\n${USAGE}`);
  let ports: PortSpec[];
  try {
    ports = parsePorts(values.port);
  } catch (err) {
    fail((err as Error).message);
  }
  const token = values.token ?? process.env.VIA443_TOKEN;
  if (!token) fail('an API token is required: pass --token or set VIA443_TOKEN');
  const server = values.server ?? process.env.VIA443_SERVER ?? DEFAULT_SERVER;
  const host = values.host;
  const urlsFile = values['urls-file'];

  const opened = await Promise.allSettled(ports.map(({ port }) => openTunnel({ port, host, server, token })));
  const failure = opened.find((r) => r.status === 'rejected');
  if (failure) {
    await Promise.all(opened.map((r) => (r.status === 'fulfilled' ? r.value.close() : undefined)));
    const err = failure.reason as Error;
    if (err instanceof ConnectRefusedError) fail(`${server} refused the tunnel: ${err.message}`);
    fail(`could not connect to ${server}: ${err.message}`);
  }
  const tunnels = opened.map((r) => (r as PromiseFulfilledResult<Tunnel>).value);

  const multi = tunnels.length > 1;
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const printUrl = (name: string, url: string) => process.stdout.write(multi ? `${name}=${url}\n` : `${url}\n`);
  const writeUrls = () => {
    if (!urlsFile) return;
    const urls = Object.fromEntries(ports.map(({ name }, i) => [name, tunnels[i]!.url]));
    // Write and rename, so a reader never sees a half-written file.
    const tmp = `${urlsFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(urls, null, 2)}\n`);
      renameSync(tmp, urlsFile);
    } catch (err) {
      log(`via443: could not write ${urlsFile}: ${(err as Error).message}`);
    }
  };

  const locals = ports.map(({ port }) => `http://${host}:${port}`).join(', ');
  log(`via443: ${locals} ${multi ? 'are' : 'is'} now public. Anyone with ${multi ? 'these URLs' : 'this URL'} can reach ${multi ? 'them' : 'it'}:`);
  ports.forEach(({ name }, i) => printUrl(name, tunnels[i]!.url));
  writeUrls();
  log('Press Ctrl+C to stop.');

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log(`via443: closing ${multi ? 'tunnels' : 'tunnel'}`);
    void Promise.all(tunnels.map((t) => t.close())).then(() => process.exit(process.exitCode ?? 0));
  };

  ports.forEach(({ name }, i) => {
    const tunnel = tunnels[i]!;
    const prefix = multi ? `via443 [${name}]` : 'via443';
    tunnel.on('url', (url) => {
      log(`${prefix}: could not keep the old URL after reconnecting. The tunnel is now at:`);
      printUrl(name, url);
      writeUrls();
    });
    tunnel.on('disconnected', (reason) => log(`${prefix}: disconnected (${reason})`));
    tunnel.on('reconnecting', (attempt, delayMs) =>
      log(`${prefix}: reconnecting in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt})`),
    );
    tunnel.on('reconnected', () => log(`${prefix}: reconnected, ${tunnel.url} is live again`));
    tunnel.on('error', (err) => {
      log(`${prefix}: ${err.message}`);
      process.exitCode = 1;
    });
    // One tunnel closing for good (e.g. its token was revoked) takes the others down with it.
    tunnel.on('close', shutdown);
    if (!values.quiet) {
      tunnel.on('request', (entry) => {
        const status = entry.status ?? 'ERR';
        const suffix = entry.error ? `  ${entry.error}` : '';
        log(`${multi ? `[${name}] ` : ''}${entry.method} ${entry.path} ${status} ${Math.round(entry.durationMs)}ms${suffix}`);
      });
    }
  });

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main();
