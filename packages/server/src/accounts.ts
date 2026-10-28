import { randomId, randomToken, sha256Hex } from './crypto.ts';
import { type Db, sql } from './db.ts';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: number;
  disabledAt: number | null;
}

export interface Invite {
  id: string;
  email: string | null;
  role: Role;
  createdAt: number;
  expiresAt: number;
}

export interface AccessRequest {
  id: string;
  email: string;
  message: string;
  createdAt: number;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface ApiTokenOwner {
  userId: string;
  tokenId: string;
}

export class AccountError extends Error {
  override name = 'AccountError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const LIFETIMES = {
  loginLink: 15 * MINUTE,
  invite: 7 * DAY,
  session: 30 * DAY,
  /** Sessions and token usage are only written back when older than this, to avoid a write per request. */
  touchInterval: 1 * DAY,
  tokenTouchInterval: 1 * MINUTE,
};

export const API_TOKEN_PREFIX = 'v443_';
/** Characters of a token kept in clear text so users can recognize it: `v443_` plus 6. */
const VISIBLE_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 6;

interface UserRow {
  id: string;
  email: string;
  role: Role;
  created_at: number;
  disabled_at: number | null;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  role: row.role,
  createdAt: row.created_at,
  disabledAt: row.disabled_at,
});

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new AccountError('invalid_email', 'Enter a valid email address.');
  }
  return trimmed;
}

/**
 * Users, invites, access requests, sign-in and API tokens. Plain SQL over the
 * `Db` interface, so it runs the same on D1 and node:sqlite.
 */
export class Accounts {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  // Setup

  async hasUsers(): Promise<boolean> {
    return (await this.#db.first(sql`SELECT 1 AS x FROM users LIMIT 1`)) !== null;
  }

  /** Creates the first admin. Fails once any user exists. */
  async createFirstAdmin(email: string): Promise<User> {
    const id = randomId();
    const { changes } = await this.#db.run(sql`
      INSERT INTO users (id, email, role, created_at)
      SELECT ${id}, ${normalizeEmail(email)}, 'admin', ${this.#now()}
      WHERE NOT EXISTS (SELECT 1 FROM users)`);
    if (changes === 0) throw new AccountError('already_set_up', 'This relay already has an admin.');
    return (await this.getUser(id))!;
  }

  // Users

  async getUser(id: string): Promise<User | null> {
    const row = await this.#db.first<UserRow>(sql`SELECT * FROM users WHERE id = ${id}`);
    return row ? toUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const row = await this.#db.first<UserRow>(sql`SELECT * FROM users WHERE email = ${email.trim()}`);
    return row ? toUser(row) : null;
  }

  async listUsers(): Promise<User[]> {
    return (await this.#db.all<UserRow>(sql`SELECT * FROM users ORDER BY created_at`)).map(toUser);
  }

  /** Disabling signs the user out everywhere and makes their API tokens stop working. */
  async setDisabled(userId: string, disabled: boolean): Promise<void> {
    if (disabled) {
      await this.#db.batch([
        sql`UPDATE users SET disabled_at = ${this.#now()} WHERE id = ${userId} AND disabled_at IS NULL`,
        sql`DELETE FROM sessions WHERE user_id = ${userId}`,
      ]);
    } else {
      await this.#db.run(sql`UPDATE users SET disabled_at = NULL WHERE id = ${userId}`);
    }
  }

  // Invites

  async createInvite(options: { createdBy: string; email?: string; role?: Role }): Promise<{ invite: Invite; token: string }> {
    const token = randomToken();
    const invite: Invite = {
      id: randomId(),
      email: options.email ? normalizeEmail(options.email) : null,
      role: options.role ?? 'user',
      createdAt: this.#now(),
      expiresAt: this.#now() + LIFETIMES.invite,
    };
    await this.#db.run(sql`
      INSERT INTO invites (id, token_hash, email, role, created_by, created_at, expires_at)
      VALUES (${invite.id}, ${await sha256Hex(token)}, ${invite.email}, ${invite.role}, ${options.createdBy},
              ${invite.createdAt}, ${invite.expiresAt})`);
    return { invite, token };
  }

  /** An invite that can still be accepted, or null. */
  async findInvite(token: string): Promise<Invite | null> {
    const row = await this.#db.first<{ id: string; email: string | null; role: Role; created_at: number; expires_at: number }>(sql`
      SELECT id, email, role, created_at, expires_at FROM invites
      WHERE token_hash = ${await sha256Hex(token)} AND used_at IS NULL AND expires_at > ${this.#now()}`);
    return row ? { id: row.id, email: row.email, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at } : null;
  }

  async listPendingInvites(): Promise<Invite[]> {
    const rows = await this.#db.all<{ id: string; email: string | null; role: Role; created_at: number; expires_at: number }>(sql`
      SELECT id, email, role, created_at, expires_at FROM invites
      WHERE used_at IS NULL AND expires_at > ${this.#now()} ORDER BY created_at DESC`);
    return rows.map((row) => ({ id: row.id, email: row.email, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at }));
  }

  async revokeInvite(inviteId: string): Promise<void> {
    await this.#db.run(sql`UPDATE invites SET expires_at = ${this.#now()} WHERE id = ${inviteId} AND used_at IS NULL`);
  }

  /** Creates the invited user. The invite can be used once. */
  async acceptInvite(token: string, email: string): Promise<User> {
    const invite = await this.findInvite(token);
    if (!invite) throw new AccountError('invalid_invite', 'This invite link is invalid, expired or already used.');
    const normalized = normalizeEmail(email);
    if (invite.email && invite.email !== normalized) {
      throw new AccountError('email_mismatch', `This invite is for ${invite.email}.`);
    }
    if (await this.getUserByEmail(normalized)) {
      throw new AccountError('email_taken', 'An account with this email already exists. Sign in instead.');
    }
    const id = randomId();
    const now = this.#now();
    // Claim the invite first, so two people can't both use it.
    const claimed = await this.#db.run(sql`
      UPDATE invites SET used_at = ${now}, used_by = NULL WHERE id = ${invite.id} AND used_at IS NULL`);
    if (claimed.changes === 0) throw new AccountError('invalid_invite', 'This invite link was just used.');
    await this.#db.batch([
      sql`INSERT INTO users (id, email, role, created_at) VALUES (${id}, ${normalized}, ${invite.role}, ${now})`,
      sql`UPDATE invites SET used_by = ${id} WHERE id = ${invite.id}`,
    ]);
    return (await this.getUser(id))!;
  }

  // Access requests

  /** Records a request. Silently does nothing for existing users or repeated requests, to not reveal accounts. */
  async requestAccess(email: string, message: string): Promise<void> {
    const normalized = normalizeEmail(email);
    if (await this.getUserByEmail(normalized)) return;
    await this.#db.run(sql`
      INSERT INTO access_requests (id, email, message, created_at)
      SELECT ${randomId()}, ${normalized}, ${message.trim().slice(0, 1000)}, ${this.#now()}
      WHERE NOT EXISTS (SELECT 1 FROM access_requests WHERE email = ${normalized} AND status = 'pending')`);
  }

  async listPendingAccessRequests(): Promise<AccessRequest[]> {
    const rows = await this.#db.all<{ id: string; email: string; message: string; created_at: number }>(sql`
      SELECT id, email, message, created_at FROM access_requests WHERE status = 'pending' ORDER BY created_at`);
    return rows.map((row) => ({ id: row.id, email: row.email, message: row.message, createdAt: row.created_at }));
  }

  /** Approving produces an invite bound to the requester's email; the admin sends them the link. */
  async approveAccessRequest(requestId: string, adminId: string): Promise<{ email: string; token: string }> {
    const request = await this.#decideAccessRequest(requestId, adminId, 'approved');
    const { token } = await this.createInvite({ createdBy: adminId, email: request.email });
    return { email: request.email, token };
  }

  async rejectAccessRequest(requestId: string, adminId: string): Promise<void> {
    await this.#decideAccessRequest(requestId, adminId, 'rejected');
  }

  async #decideAccessRequest(requestId: string, adminId: string, status: 'approved' | 'rejected'): Promise<{ email: string }> {
    const request = await this.#db.first<{ email: string }>(sql`
      UPDATE access_requests SET status = ${status}, decided_by = ${adminId}, decided_at = ${this.#now()}
      WHERE id = ${requestId} AND status = 'pending' RETURNING email`);
    if (!request) throw new AccountError('not_found', 'No pending access request with this ID.');
    return request;
  }

  // Login links and sessions

  async createLoginLink(userId: string): Promise<string> {
    const token = randomToken();
    await this.#db.run(sql`
      INSERT INTO login_links (token_hash, user_id, created_at, expires_at)
      VALUES (${await sha256Hex(token)}, ${userId}, ${this.#now()}, ${this.#now() + LIFETIMES.loginLink})`);
    return token;
  }

  /** Uses up a login link and returns its user, or null if the link is invalid, expired or used. */
  async consumeLoginLink(token: string): Promise<User | null> {
    const row = await this.#db.first<{ user_id: string }>(sql`
      UPDATE login_links SET used_at = ${this.#now()}
      WHERE token_hash = ${await sha256Hex(token)} AND used_at IS NULL AND expires_at > ${this.#now()}
      RETURNING user_id`);
    if (!row) return null;
    const user = await this.getUser(row.user_id);
    return user && !user.disabledAt ? user : null;
  }

  async createSession(userId: string): Promise<string> {
    const token = randomToken();
    const now = this.#now();
    await this.#db.run(sql`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at)
      VALUES (${await sha256Hex(token)}, ${userId}, ${now}, ${now + LIFETIMES.session}, ${now})`);
    return token;
  }

  /** The signed-in user for a session token. Extends the session at most once a day. */
  async getSessionUser(token: string): Promise<User | null> {
    const hash = await sha256Hex(token);
    const now = this.#now();
    const row = await this.#db.first<UserRow & { last_used_at: number }>(sql`
      SELECT users.*, sessions.last_used_at FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ${hash} AND sessions.expires_at > ${now} AND users.disabled_at IS NULL`);
    if (!row) return null;
    if (now - row.last_used_at > LIFETIMES.touchInterval) {
      await this.#db.run(sql`
        UPDATE sessions SET last_used_at = ${now}, expires_at = ${now + LIFETIMES.session} WHERE token_hash = ${hash}`);
    }
    return toUser(row);
  }

  async deleteSession(token: string): Promise<void> {
    await this.#db.run(sql`DELETE FROM sessions WHERE token_hash = ${await sha256Hex(token)}`);
  }

  // API tokens

  /** Creates a token. The returned secret is never stored and can't be shown again. */
  async createApiToken(userId: string, name: string): Promise<{ token: string; info: ApiTokenInfo }> {
    const trimmed = name.trim().slice(0, 100);
    if (!trimmed) throw new AccountError('invalid_name', 'Give the token a name.');
    const token = `${API_TOKEN_PREFIX}${randomToken()}`;
    const info: ApiTokenInfo = {
      id: randomId(),
      name: trimmed,
      prefix: token.slice(0, VISIBLE_PREFIX_LENGTH),
      createdAt: this.#now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.#db.run(sql`
      INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, created_at)
      VALUES (${info.id}, ${userId}, ${info.name}, ${info.prefix}, ${await sha256Hex(token)}, ${info.createdAt})`);
    return { token, info };
  }

  async listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
    const rows = await this.#db.all<{
      id: string;
      name: string;
      prefix: string;
      created_at: number;
      last_used_at: number | null;
      revoked_at: number | null;
    }>(sql`
      SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_tokens
      WHERE user_id = ${userId} ORDER BY revoked_at IS NOT NULL, created_at DESC`);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }

  async revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
    const { changes } = await this.#db.run(sql`
      UPDATE api_tokens SET revoked_at = ${this.#now()}
      WHERE id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL`);
    return changes > 0;
  }

  /** Checks an API token from a tunnel client. Null for unknown, revoked, or disabled users' tokens. */
  async authenticateApiToken(token: string): Promise<ApiTokenOwner | null> {
    if (!token.startsWith(API_TOKEN_PREFIX)) return null;
    const now = this.#now();
    const row = await this.#db.first<{ id: string; user_id: string; last_used_at: number | null }>(sql`
      SELECT api_tokens.id, api_tokens.user_id, api_tokens.last_used_at
      FROM api_tokens JOIN users ON users.id = api_tokens.user_id
      WHERE api_tokens.token_hash = ${await sha256Hex(token)}
        AND api_tokens.revoked_at IS NULL AND users.disabled_at IS NULL`);
    if (!row) return null;
    if (row.last_used_at === null || now - row.last_used_at > LIFETIMES.tokenTouchInterval) {
      await this.#db.run(sql`UPDATE api_tokens SET last_used_at = ${now} WHERE id = ${row.id}`);
    }
    return { userId: row.user_id, tokenId: row.id };
  }
}
