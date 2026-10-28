#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ConnectRefusedError, DEFAULT_SERVER, openTunnel } from './tunnel.ts';

/** Set by the build; absent when running from source. */
declare const VIA443_VERSION: string | undefined;
const VERSION = typeof VIA443_VERSION === 'string' ? VIA443_VERSION : 'dev';

const USAGE = `Usage: via443 --port <port> [options]

Exposes a local server at a public https URL. Only needs outbound HTTPS on
port 443, and works through an HTTP CONNECT proxy (HTTPS_PROXY).

Options:
  -p, --port <port>      local port to expose (required)
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
        port: { type: 'string', short: 'p' },
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

  const port = Number(values.port);
  if (!values.port || !Number.isInteger(port) || port < 1 || port > 65535) fail(`--port is required\n\n${USAGE}`);
  const token = values.token ?? process.env.VIA443_TOKEN;
  if (!token) fail('an API token is required: pass --token or set VIA443_TOKEN');
  const server = values.server ?? process.env.VIA443_SERVER ?? DEFAULT_SERVER;
  const local = `http://${values.host}:${port}`;

  let tunnel;
  try {
    tunnel = await openTunnel({ port, host: values.host, server, token });
  } catch (err) {
    if (err instanceof ConnectRefusedError) fail(`${server} refused the tunnel: ${err.message}`);
    fail(`could not connect to ${server}: ${(err as Error).message}`);
  }

  const log = (line: string) => process.stderr.write(`${line}\n`);
  log(`via443: ${local} is now public. Anyone with this URL can reach it:`);
  process.stdout.write(`${tunnel.url}\n`);
  log('Press Ctrl+C to stop.');

  tunnel.on('url', (url) => {
    log(`via443: could not keep the old URL after reconnecting. The tunnel is now at:`);
    process.stdout.write(`${url}\n`);
  });
  tunnel.on('disconnected', (reason) => log(`via443: disconnected (${reason})`));
  tunnel.on('reconnecting', (attempt, delayMs) =>
    log(`via443: reconnecting in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt})`),
  );
  tunnel.on('reconnected', () => log(`via443: reconnected, ${tunnel.url} is live again`));
  tunnel.on('error', (err) => log(`via443: ${err.message}`));
  tunnel.on('close', () => process.exit(process.exitCode ?? 0));
  if (!values.quiet) {
    tunnel.on('request', (entry) => {
      const status = entry.status ?? 'ERR';
      const suffix = entry.error ? `  ${entry.error}` : '';
      log(`${entry.method} ${entry.path} ${status} ${Math.round(entry.durationMs)}ms${suffix}`);
    });
  }

  const shutdown = () => {
    log('via443: closing tunnel');
    void tunnel.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main();
