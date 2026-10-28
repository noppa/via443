import type { TunnelDO } from './tunnel.ts';

export interface Env {
  DB: D1Database;
  TUNNELS: DurableObjectNamespace<TunnelDO>;
  /** Public domain, e.g. `via443.com`. Tunnels are served at `<id>.<domain>`. */
  VIA443_DOMAIN: string;
  /** Scheme of public URLs: `https` in production, `http` under `wrangler dev`. */
  VIA443_SCHEME?: string;
  /** Secret (`wrangler secret put`) that enables `/setup?token=…` while there are no accounts. */
  VIA443_SETUP_TOKEN?: string;
}

export interface RelayConfig {
  domain: string;
  scheme: 'http' | 'https';
}

export function relayConfig(env: Env): RelayConfig {
  const scheme = env.VIA443_SCHEME ?? 'https';
  if (scheme !== 'http' && scheme !== 'https') throw new Error('VIA443_SCHEME must be http or https');
  return { domain: env.VIA443_DOMAIN, scheme };
}

/**
 * Headers the Worker sets on requests it passes to a tunnel's Durable Object.
 * The Worker always overwrites ROUTE, so a visitor can't pose as a connecting
 * client by sending these themselves.
 */
export const InternalHeader = {
  ROUTE: 'x-via443-route',
  OWNER: 'x-via443-owner',
  TUNNEL_ID: 'x-via443-tunnel-id',
  /** `new` for a fresh tunnel, `resume` to take over an existing one. */
  MODE: 'x-via443-mode',
} as const;
