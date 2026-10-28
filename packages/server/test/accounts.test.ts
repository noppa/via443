import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AccountError, Accounts, API_TOKEN_PREFIX, LIFETIMES } from '../src/index.ts';
import { migrate, sqliteDb } from '../src/node/index.ts';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  migrate(raw);
  let now = 1_700_000_000_000;
  const clock = {
    advance: (ms: number) => {
      now += ms;
    },
  };
  return { raw, accounts: new Accounts(sqliteDb(raw), () => now), clock };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AccountError) return err.code;
    throw err;
  }
  return 'ok';
};

describe('migrate', () => {
  it('applies each migration once and records it like wrangler does', () => {
    const raw = new DatabaseSync(':memory:');
    expect(migrate(raw)).toEqual(['0001_accounts.sql']);
    expect(migrate(raw)).toEqual([]);
    expect(raw.prepare('SELECT name FROM d1_migrations').all()).toEqual([{ name: '0001_accounts.sql' }]);
  });

  it('rolls back a failing migration and leaves earlier ones applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'via443-migrations-'));
    try {
      writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE a (x INTEGER);');
      writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE b (x INTEGER); SELECT * FROM missing;');
      writeFileSync(join(dir, 'README.md'), 'not a migration');
      const raw = new DatabaseSync(':memory:');
      expect(() => migrate(raw, dir)).toThrow(/missing/);
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      expect(tables.map((t) => t.name)).toEqual(['a', 'd1_migrations', 'sqlite_sequence']);
      expect(raw.prepare('SELECT name FROM d1_migrations').all()).toEqual([{ name: '0001_ok.sql' }]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('Accounts', () => {
  it('creates the first admin only once', async () => {
    const { accounts } = setup();
    expect(await accounts.hasUsers()).toBe(false);
    const admin = await accounts.createFirstAdmin(' Me@Example.com ');
    expect(admin).toMatchObject({ email: 'me@example.com', role: 'admin', disabledAt: null });
    expect(await code(accounts.createFirstAdmin('other@example.com'))).toBe('already_set_up');
  });

  it('invites: single use, optional email binding, expiry', async () => {
    const { accounts, clock } = setup();
    const admin = await accounts.createFirstAdmin('admin@example.com');

    const open = await accounts.createInvite({ createdBy: admin.id });
    const user = await accounts.acceptInvite(open.token, 'pal@example.com');
    expect(user.role).toBe('user');
    expect(await code(accounts.acceptInvite(open.token, 'another@example.com'))).toBe('invalid_invite');

    const bound = await accounts.createInvite({ createdBy: admin.id, email: 'bound@example.com', role: 'admin' });
    expect(await code(accounts.acceptInvite(bound.token, 'someone@example.com'))).toBe('email_mismatch');
    expect((await accounts.acceptInvite(bound.token, 'BOUND@example.com')).role).toBe('admin');

    const taken = await accounts.createInvite({ createdBy: admin.id });
    expect(await code(accounts.acceptInvite(taken.token, 'pal@example.com'))).toBe('email_taken');
    expect(await accounts.findInvite(taken.token)).not.toBeNull();

    const late = await accounts.createInvite({ createdBy: admin.id });
    clock.advance(LIFETIMES.invite + 1);
    expect(await code(accounts.acceptInvite(late.token, 'late@example.com'))).toBe('invalid_invite');

    const revoked = await accounts.createInvite({ createdBy: admin.id });
    await accounts.revokeInvite(revoked.invite.id);
    expect(await accounts.findInvite(revoked.token)).toBeNull();
    expect(await accounts.listPendingInvites()).toHaveLength(0);
  });

  it('access requests: deduplicated, hidden for existing users, approved into a bound invite', async () => {
    const { accounts } = setup();
    const admin = await accounts.createFirstAdmin('admin@example.com');
    await accounts.requestAccess('new@example.com', 'hi, I am a friend');
    await accounts.requestAccess('NEW@example.com', 'again');
    await accounts.requestAccess('admin@example.com', 'already have an account');
    expect(await code(accounts.requestAccess('nope', ''))).toBe('invalid_email');

    const [request, ...rest] = await accounts.listPendingAccessRequests();
    expect(rest).toHaveLength(0);
    expect(request).toMatchObject({ email: 'new@example.com', message: 'hi, I am a friend' });

    const { email, token } = await accounts.approveAccessRequest(request!.id, admin.id);
    expect(email).toBe('new@example.com');
    expect((await accounts.findInvite(token))?.email).toBe('new@example.com');
    expect(await accounts.listPendingAccessRequests()).toHaveLength(0);
    expect(await code(accounts.approveAccessRequest(request!.id, admin.id))).toBe('not_found');

    await accounts.requestAccess('spam@example.com', '');
    const [spam] = await accounts.listPendingAccessRequests();
    await accounts.rejectAccessRequest(spam!.id, admin.id);
    expect(await accounts.listPendingAccessRequests()).toHaveLength(0);
  });

  it('login links work once and expire', async () => {
    const { accounts, clock } = setup();
    const admin = await accounts.createFirstAdmin('admin@example.com');
    const link = await accounts.createLoginLink(admin.id);
    expect((await accounts.consumeLoginLink(link))?.id).toBe(admin.id);
    expect(await accounts.consumeLoginLink(link)).toBeNull();

    const late = await accounts.createLoginLink(admin.id);
    clock.advance(LIFETIMES.loginLink + 1);
    expect(await accounts.consumeLoginLink(late)).toBeNull();
    expect(await accounts.consumeLoginLink('made-up')).toBeNull();
  });

  it('sessions slide forward when used and end on logout or disable', async () => {
    const { accounts, clock } = setup();
    const admin = await accounts.createFirstAdmin('admin@example.com');
    const pal = await accounts.acceptInvite((await accounts.createInvite({ createdBy: admin.id })).token, 'pal@example.com');

    const session = await accounts.createSession(pal.id);
    clock.advance(LIFETIMES.session - 1000);
    expect((await accounts.getSessionUser(session))?.id).toBe(pal.id); // extends it
    clock.advance(LIFETIMES.session - 1000);
    expect((await accounts.getSessionUser(session))?.id).toBe(pal.id);
    clock.advance(LIFETIMES.session + 1);
    expect(await accounts.getSessionUser(session)).toBeNull();

    const second = await accounts.createSession(pal.id);
    await accounts.deleteSession(second);
    expect(await accounts.getSessionUser(second)).toBeNull();

    const third = await accounts.createSession(pal.id);
    await accounts.setDisabled(pal.id, true);
    expect(await accounts.getSessionUser(third)).toBeNull();
    expect(await accounts.consumeLoginLink(await accounts.createLoginLink(pal.id))).toBeNull();
  });

  it('API tokens: shown once, stored hashed, revocable, dead for disabled users', async () => {
    const { accounts, raw } = setup();
    const admin = await accounts.createFirstAdmin('admin@example.com');
    const { token, info } = await accounts.createApiToken(admin.id, ' laptop ');
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(info).toMatchObject({ name: 'laptop', prefix: token.slice(0, 11), lastUsedAt: null });
    expect(JSON.stringify(raw.prepare('SELECT * FROM api_tokens').all())).not.toContain(token);
    expect(await code(accounts.createApiToken(admin.id, '  '))).toBe('invalid_name');

    expect(await accounts.authenticateApiToken(token)).toEqual({ userId: admin.id, tokenId: info.id });
    expect((await accounts.listApiTokens(admin.id))[0]?.lastUsedAt).not.toBeNull();
    expect(await accounts.authenticateApiToken(`${token}x`)).toBeNull();
    expect(await accounts.authenticateApiToken('no-prefix')).toBeNull();

    const pal = await accounts.acceptInvite((await accounts.createInvite({ createdBy: admin.id })).token, 'pal@example.com');
    expect(await accounts.revokeApiToken(pal.id, info.id)).toBe(false); // not theirs
    expect(await accounts.revokeApiToken(admin.id, info.id)).toBe(true);
    expect(await accounts.authenticateApiToken(token)).toBeNull();

    const palToken = await accounts.createApiToken(pal.id, 'ci');
    expect(await accounts.authenticateApiToken(palToken.token)).not.toBeNull();
    await accounts.setDisabled(pal.id, true);
    expect(await accounts.authenticateApiToken(palToken.token)).toBeNull();
    await accounts.setDisabled(pal.id, false);
    expect(await accounts.authenticateApiToken(palToken.token)).not.toBeNull();
  });
});
