import { staticTokens } from './auth.ts';
import { createRelay } from './server.ts';

const env = process.env;
const port = Number(env.VIA443_PORT ?? env.PORT ?? 8080);
const listenHost = env.VIA443_LISTEN_HOST ?? '0.0.0.0';
const domain = env.VIA443_DOMAIN ?? `localhost:${port}`;
const scheme = env.VIA443_SCHEME ?? (env.VIA443_DOMAIN ? 'https' : 'http');
if (scheme !== 'http' && scheme !== 'https') throw new Error('VIA443_SCHEME must be http or https');
if (!env.VIA443_TOKENS) {
  console.error('via443: set VIA443_TOKENS to a comma-separated list of user:token pairs');
  process.exit(1);
}

const relay = createRelay({
  domain,
  scheme,
  trustProxy: env.VIA443_TRUST_PROXY === 'true' || env.VIA443_TRUST_PROXY === '1',
  authenticate: await staticTokens(env.VIA443_TOKENS),
});
relay.server.listen(port, listenHost, () => {
  console.log(`via443 relay listening on ${listenHost}:${port}, serving ${scheme}://*.${domain}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void relay.close().then(() => process.exit(0)));
}
