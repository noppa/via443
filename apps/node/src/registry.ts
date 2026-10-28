import { generateResumeToken, generateTunnelId, sha256Hex, type TunnelSession } from '@via443/relay-core';
import type { ResumeRequest } from '@via443/protocol';

interface Entry {
  userId: string;
  resumeTokenHash: string;
  session: TunnelSession | undefined;
  /** When a disconnected tunnel's ID is released, unless it is resumed first. */
  expiresAt: number | undefined;
}

export interface Attached {
  tunnelId: string;
  resumeToken: string;
  resumed: boolean;
}

/** WebSocket close code sent to a session that is replaced by a resumed connection. */
export const CLOSE_REPLACED = 4000;

/**
 * In-memory tunnel table for the single-process relay. A tunnel ID stays
 * reserved for `graceMs` after its client disconnects, so the client can
 * reconnect and keep its URL.
 */
export class TunnelRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #graceMs: number;

  constructor(graceMs = 10 * 60_000) {
    this.#graceMs = graceMs;
  }

  async attach(userId: string, resume: ResumeRequest | undefined, session: TunnelSession): Promise<Attached> {
    this.sweep();
    const resumeToken = generateResumeToken();
    const resumeTokenHash = await sha256Hex(resumeToken);

    if (resume) {
      const entry = this.#entries.get(resume.tunnelId);
      if (entry && entry.userId === userId && entry.resumeTokenHash === (await sha256Hex(resume.resumeToken))) {
        const previous = entry.session;
        entry.session = session;
        entry.expiresAt = undefined;
        entry.resumeTokenHash = resumeTokenHash;
        // The old socket may still look open if the client's network dropped silently.
        if (previous && previous !== session) previous.close(CLOSE_REPLACED, 'replaced by a resumed connection');
        return { tunnelId: resume.tunnelId, resumeToken, resumed: true };
      }
    }

    let tunnelId = generateTunnelId();
    while (this.#entries.has(tunnelId)) tunnelId = generateTunnelId();
    this.#entries.set(tunnelId, { userId, resumeTokenHash, session, expiresAt: undefined });
    return { tunnelId, resumeToken, resumed: false };
  }

  /** The live session for a tunnel, if its client is connected. */
  get(tunnelId: string): TunnelSession | undefined {
    const session = this.#entries.get(tunnelId)?.session;
    return session && !session.isClosed ? session : undefined;
  }

  /** The client's socket closed; keep the ID reserved for the grace period. */
  detach(tunnelId: string, session: TunnelSession): void {
    const entry = this.#entries.get(tunnelId);
    if (!entry || entry.session !== session) return;
    entry.session = undefined;
    entry.expiresAt = Date.now() + this.#graceMs;
  }

  sweep(now = Date.now()): void {
    for (const [tunnelId, entry] of this.#entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.#entries.delete(tunnelId);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
