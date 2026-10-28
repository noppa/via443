import { isTunnelId } from './ids.ts';

export type HostMatch = { kind: 'apex' } | { kind: 'tunnel'; tunnelId: string } | { kind: 'unknown' };

/**
 * Classifies a request's Host header against the relay's domain, e.g. `via443.com`
 * or `localhost:8080`. A port in the Host header is ignored when the domain has none.
 */
export function matchHost(host: string | null | undefined, domain: string): HostMatch {
  if (!host) return { kind: 'unknown' };
  let name = host.toLowerCase();
  const base = domain.toLowerCase();
  if (!base.includes(':')) name = name.replace(/:\d+$/, '');
  if (name === base) return { kind: 'apex' };
  if (name.endsWith(`.${base}`)) {
    const label = name.slice(0, -(base.length + 1));
    if (isTunnelId(label)) return { kind: 'tunnel', tunnelId: label };
  }
  return { kind: 'unknown' };
}
