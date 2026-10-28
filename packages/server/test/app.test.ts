import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Accounts, createApp, type Mail } from '../src/index.ts';
import { migrate, sqliteDb } from '../src/node/index.ts';

const ORIGIN = 'https://via443.test';
const SETUP_TOKEN = 'setup-secret';

function setup() {
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  const accounts = new Accounts(sqliteDb(raw));
  const mails: Mail[] = [];
  const app = createApp({
    accounts,
    mailer: { send: async (mail) => void mails.push(mail) },
    publicOrigin: ORIGIN,
    setupToken: SETUP_TOKEN,
    defaultServer: 'via443.test',
  });
  return { app, accounts, mails };
}

/** A browser: keeps the session cookie and sends same-origin form posts. */
function browser(app: ReturnType<typeof setup>['app']) {
  let cookie = '';
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const res = await app.request(`${ORIGIN}${path}`, { ...init, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const [pair] = setCookie.split(';');
      cookie = pair!.endsWith('=') ? '' : pair!;
    }
    return res;
  };
  return {
    get: (path: string) => request(path),
    post: (path: string, fields: Record<string, string> = {}, origin = ORIGIN) =>
      request(path, {
        method: 'POST',
        body: new URLSearchParams(fields),
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      }),
    get cookie() {
      return cookie;
    },
  };
}

/** Pulls the secret shown in a page's <pre> block. */
async function shownSecret(res: Response): Promise<string> {
  const match = (await res.text()).match(/<pre>([^<]+)<\/pre>/);
  if (!match) throw new Error('no secret on page');
  return match[1]!.replaceAll('&amp;', '&');
}

async function signedInAdmin() {
  const ctx = setup();
  const admin = browser(ctx.app);
  const res = await admin.post('/setup', { token: SETUP_TOKEN, email: 'admin@example.com' });
  expect(res.status).toBe(303);
  return { ...ctx, admin };
}

describe('setup', () => {
  it('creates the admin with the setup token, then disappears', async () => {
    const { app } = setup();
    const visitor = browser(app);
    expect((await visitor.get('/setup?token=wrong')).status).toBe(404);
    expect((await visitor.get(`/setup?token=${SETUP_TOKEN}`)).status).toBe(200);

    const res = await visitor.post('/setup', { token: SETUP_TOKEN, email: 'admin@example.com' });
    expect(res.status).toBe(303);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^__Host-via443_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).not.toMatch(/Domain=/);

    const dashboard = await (await visitor.get('/')).text();
    expect(dashboard).toContain('admin@example.com');
    expect(dashboard).toContain('Access requests');
    expect((await visitor.get(`/setup?token=${SETUP_TOKEN}`)).status).toBe(404);
  });
});

describe('dashboard', () => {
  it('rejects cross-site form posts', async () => {
    const { admin } = await signedInAdmin();
    expect((await admin.post('/tokens', { name: 'x' }, 'https://evil.example')).status).toBe(403);
  });

  it('sends signed-out visitors to the login page', async () => {
    const { app } = setup();
    const res = await browser(app).post('/tokens', { name: 'x' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('creates an API token that authenticates tunnels, and revokes it', async () => {
    const { admin, accounts } = await signedInAdmin();
    const token = await shownSecret(await admin.post('/tokens', { name: 'laptop' }));
    const owner = await accounts.authenticateApiToken(token);
    expect(owner).not.toBeNull();

    const page = await (await admin.get('/')).text();
    expect(page).toContain(token.slice(0, 11));
    expect(page).not.toContain(token);
    expect(page).not.toContain('--server'); // the client's default server is this relay

    expect((await admin.post(`/tokens/${owner!.tokenId}/revoke`)).status).toBe(303);
    expect(await accounts.authenticateApiToken(token)).toBeNull();
  });
});

describe('invites and access requests', () => {
  it('lets an invited pal join, without admin powers', async () => {
    const { app, admin } = await signedInAdmin();
    const link = await shownSecret(await admin.post('/admin/invites', { email: '' }));
    expect(link).toMatch(new RegExp(`^${ORIGIN}/invite\\?token=`));
    const path = link.slice(ORIGIN.length);

    const pal = browser(app);
    expect((await pal.get(path)).status).toBe(200);
    const token = new URL(link).searchParams.get('token')!;
    expect((await pal.post('/invite', { token, email: 'pal@example.com' })).status).toBe(303);
    const dashboard = await (await pal.get('/')).text();
    expect(dashboard).toContain('pal@example.com');
    expect(dashboard).not.toContain('Access requests');

    const forbidden = await pal.post('/admin/invites', {});
    expect(forbidden.status).toBe(400);
    expect(await forbidden.text()).toContain('Only admins');
    expect((await browser(app).get(path)).status).toBe(404);
  });

  it('turns an approved access request into an invite for that email', async () => {
    const { app, admin, accounts } = await signedInAdmin();
    const stranger = browser(app);
    expect((await stranger.post('/request-access', { email: 'friend@example.com', message: 'hello!' })).status).toBe(200);
    const [request] = await accounts.listPendingAccessRequests();
    expect(await (await admin.get('/')).text()).toContain('friend@example.com');

    const link = await shownSecret(await admin.post(`/admin/requests/${request!.id}/approve`));
    const token = new URL(link).searchParams.get('token')!;
    const wrong = await stranger.post('/invite', { token, email: 'other@example.com' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('friend@example.com');
    expect((await stranger.post('/invite', { token, email: 'friend@example.com' })).status).toBe(303);
  });
});

describe('sign-in links', () => {
  it('mails a link for existing users only, and answers the same either way', async () => {
    const { app, mails } = await signedInAdmin();
    const visitor = browser(app);
    const unknown = await (await visitor.post('/login', { email: 'nobody@example.com' })).text();
    const known = await (await visitor.post('/login', { email: 'ADMIN@example.com' })).text();
    expect(known).toBe(unknown);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('admin@example.com');

    const link = mails[0]!.text.match(/https:\S+/)![0];
    const token = new URL(link).searchParams.get('token')!;
    // Opening the link only shows a button, so mail scanners can't use it up.
    expect(await (await visitor.get(link.slice(ORIGIN.length))).text()).toContain('Continue to via443');
    expect((await visitor.post('/auth', { token })).status).toBe(303);
    expect(await (await visitor.get('/')).text()).toContain('Dashboard');
    expect((await browser(app).post('/auth', { token })).status).toBe(400);
  });

  it('lets an admin hand out a sign-in link, and sign-out ends the session', async () => {
    const { app, admin, accounts } = await signedInAdmin();
    const [me] = await accounts.listUsers();
    const link = await shownSecret(await admin.post(`/admin/users/${me!.id}/login-link`));
    const other = browser(app);
    expect((await other.post('/auth', { token: new URL(link).searchParams.get('token')! })).status).toBe(303);

    expect((await other.post('/logout')).status).toBe(303);
    expect(other.cookie).toBe('');
    expect(await (await other.get('/')).text()).toContain('invite-only');
  });
});
