const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const TUNNEL_ID_LENGTH = 8;

/** A random tunnel ID: 8 characters of [a-z0-9], about 41 bits. */
export function generateTunnelId(): string {
  let id = '';
  // 252 is the largest multiple of 36 below 256; rejecting bytes above it avoids modulo bias.
  while (id.length < TUNNEL_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 252 && id.length < TUNNEL_ID_LENGTH) id += ID_ALPHABET[byte % 36];
    }
  }
  return id;
}

export function isTunnelId(value: string): boolean {
  return value.length === TUNNEL_ID_LENGTH && [...value].every((c) => ID_ALPHABET.includes(c));
}

/** A random secret for resuming a tunnel after a reconnect: 256 bits, base64url. */
export function generateResumeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
