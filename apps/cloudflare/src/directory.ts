import type { TunnelOwner } from '@via443/relay-core';
import { type Db, sql } from '@via443/server';

/**
 * The `tunnels` table in D1: which tunnel IDs are taken, and by whom. Each
 * tunnel lives in its own Durable Object, so this is the one place to reserve
 * an ID without collisions and to find a user's tunnels on revocation.
 */
export class TunnelDirectory {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Claims a tunnel ID. False if it's already taken. */
  async reserve(tunnelId: string, owner: TunnelOwner): Promise<boolean> {
    const { changes } = await this.#db.run(sql`
      INSERT INTO tunnels (id, user_id, token_id, created_at)
      VALUES (${tunnelId}, ${owner.userId}, ${owner.tokenId}, ${Date.now()})
      ON CONFLICT (id) DO NOTHING`);
    return changes === 1;
  }

  /** Records the token a resumed tunnel now runs under, so revoking that token finds it. */
  async setToken(tunnelId: string, tokenId: string): Promise<void> {
    await this.#db.run(sql`UPDATE tunnels SET token_id = ${tokenId} WHERE id = ${tunnelId}`);
  }

  async release(tunnelId: string): Promise<void> {
    await this.#db.run(sql`DELETE FROM tunnels WHERE id = ${tunnelId}`);
  }

  /** Tunnels opened by a user or with a token. */
  async find(match: { userId?: string; tokenId?: string }): Promise<string[]> {
    const rows = await this.#db.all<{ id: string }>(sql`
      SELECT id FROM tunnels WHERE user_id = ${match.userId ?? null} OR token_id = ${match.tokenId ?? null}`);
    return rows.map((row) => row.id);
  }
}
