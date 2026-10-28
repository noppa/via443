import type { HeaderList } from './messages.ts';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Removes hop-by-hop headers, including any named in `Connection`, which only
 * apply to a single HTTP connection and must not be forwarded.
 */
export function stripHopByHop(headers: HeaderList): HeaderList {
  const drop = new Set(HOP_BY_HOP);
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'connection') {
      for (const token of value.split(',')) drop.add(token.trim().toLowerCase());
    }
  }
  return headers.filter(([name]) => !drop.has(name.toLowerCase()));
}
