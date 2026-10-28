import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Accounts, createApp, logMailer } from '@via443/server';
import { migrate, openSqlite, sqliteDb } from '@via443/server/node';
import { TunnelRegistry } from './registry.ts';
import { createRelay } from './server.ts';

const env = process.env;
const port = Number(env.VIA443_PORT ?? env.PORT ?? 8080);
const listenHost = env.VIA443_LISTEN_HOST ?? '0.0.0.0';
const domain = env.VIA443_DOMAIN ?? `localhost:${port}`;
const scheme = env.VIA443_SCHEME ?? (env.VIA443_DOMAIN ? 'https' : 'http');
if (scheme !== 'http' && scheme !== 'https') throw new Error('VIA443_SCHEME must be http or https');
const publicOrigin = `${scheme}://${domain}`;

const dataDir = resolve(env.VIA443_DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });
const sqlite = openSqlite(join(dataDir, 'accounts.db'));
for (const name of migrate(sqlite)) console.log(`via443: applied migration ${name}`);
const accounts = new Accounts(sqliteDb(sqlite));

const registry = new TunnelRegistry();
const app = createApp({
  accounts,
  mailer: logMailer(),
  publicOrigin,
  setupToken: env.VIA443_SETUP_TOKEN,
  onAccessRevoked: (match) => {
    registry.revoke(match);
  },
});

const relay = createRelay({
  domain,
  scheme,
  trustProxy: env.VIA443_TRUST_PROXY === 'true' || env.VIA443_TRUST_PROXY === '1',
  authenticate: (token) => accounts.authenticateApiToken(token),
  app,
  registry,
});

relay.server.listen(port, listenHost, async () => {
  console.log(`via443 relay listening on ${listenHost}:${port}, serving ${publicOrigin} and ${scheme}://*.${domain}`);
  if (!(await accounts.hasUsers())) {
    if (env.VIA443_SETUP_TOKEN) {
      console.log(`via443: no accounts yet. Create the admin account at ${publicOrigin}/setup?token=${env.VIA443_SETUP_TOKEN}`);
    } else {
      console.log('via443: no accounts yet. Set VIA443_SETUP_TOKEN to a secret and restart to create the admin account.');
    }
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () =>
    void relay.close().then(() => {
      sqlite.close();
      process.exit(0);
    }),
  );
}
