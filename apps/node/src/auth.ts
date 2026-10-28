import { sha256Hex } from '@via443/relay-core';

export interface AuthenticatedUser {
  userId: string;
}

export type Authenticate = (token: string) => Promise<AuthenticatedUser | null>;

/**
 * Stopgap until the accounts database exists: API tokens from a
 * `user:token,user:token` list, e.g. the VIA443_TOKENS env var.
 */
export async function staticTokens(spec: string): Promise<Authenticate> {
  const byHash = new Map<string, AuthenticatedUser>();
  for (const item of spec.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0 || sep === trimmed.length - 1) throw new Error(`invalid token entry "${trimmed}", expected user:token`);
    byHash.set(await sha256Hex(trimmed.slice(sep + 1)), { userId: trimmed.slice(0, sep) });
  }
  return async (token) => byHash.get(await sha256Hex(token)) ?? null;
}
