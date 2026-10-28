import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { AccountError, type Accounts, LIFETIMES, type Role, type User } from './accounts.ts';
import { sha256Hex } from './crypto.ts';
import type { Mailer } from './mailer.ts';
import {
  confirmLoginPage,
  dashboardPage,
  invitePage,
  landingPage,
  loginPage,
  messagePage,
  requestAccessPage,
  secretPage,
  setupPage,
  tokenCommand,
} from './views.ts';

export interface AppConfig {
  accounts: Accounts;
  mailer: Mailer;
  /** Origin of the apex domain, e.g. `https://via443.com`. Links and CSRF checks use it. */
  publicOrigin: string;
  /** Enables `/setup?token=…` while the relay has no users. */
  setupToken?: string;
  /** Domain the client's `--server` flag defaults to, `via443.com`; the dashboard only shows the flag when it differs. */
  defaultServer?: string;
  /** Called when a token is revoked or a user disabled, so the relay can drop their live tunnels. */
  onAccessRevoked?: (match: { userId?: string; tokenId?: string }) => void | Promise<void>;
}

type Env = { Variables: { user: User | null } };

/** Thrown by route helpers to send a signed-out visitor to the login page. */
class HttpRedirect extends Error {
  readonly location: string;
  constructor(location: string) {
    super(`redirect to ${location}`);
    this.location = location;
  }
}

/** The dashboard and account pages served on the relay's apex domain. */
export function createApp(config: AppConfig): Hono<Env> {
  const { accounts, mailer, publicOrigin } = config;
  const secure = publicOrigin.startsWith('https:');
  // `__Host-` cookies are bound to this exact host, so tunnel subdomains never see the session.
  const cookieName = secure ? '__Host-via443_session' : 'via443_session';
  const app = new Hono<Env>();
  const host = new URL(publicOrigin).host;
  // The `--server` flag for commands shown to users, or empty when the client's default is this relay.
  const serverFlag = (config.defaultServer ?? 'via443.com') === host ? '' : ` --server ${secure ? host : publicOrigin}`;

  app.use(csrf({ origin: publicOrigin }));

  app.use(async (c, next) => {
    const token = getCookie(c, cookieName);
    c.set('user', token ? await accounts.getSessionUser(token) : null);
    c.header('cache-control', 'no-store');
    c.header('x-frame-options', 'DENY');
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpRedirect) return c.redirect(err.location, 303);
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof AccountError) return c.html(messagePage('Something went wrong', err.message, { error: true, user: c.get('user') }), 400);
    console.error('via443 server error', err);
    return c.html(messagePage('Server error', 'Something went wrong on our side.', { error: true }), 500);
  });

  const signIn = async (c: Context<Env>, userId: string) => {
    setCookie(c, cookieName, await accounts.createSession(userId), {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      maxAge: LIFETIMES.session / 1000,
    });
    return c.redirect('/', 303);
  };

  const requireUser = (c: Context<Env>): User => {
    const user = c.get('user');
    if (!user) throw new HttpRedirect('/login');
    return user;
  };

  const requireAdmin = (c: Context<Env>): User => {
    const user = requireUser(c);
    if (user.role !== 'admin') throw new AccountError('forbidden', 'Only admins can do that.');
    return user;
  };

  const form = async (c: Context<Env>) => {
    const body = await c.req.parseBody();
    return (name: string) => (typeof body[name] === 'string' ? (body[name] as string) : '');
  };

  app.get('/', async (c) => {
    const user = c.get('user');
    if (!user) return c.html(landingPage());
    return c.html(
      dashboardPage({
        user,
        tokens: await accounts.listApiTokens(user.id),
        serverFlag,
        admin:
          user.role === 'admin'
            ? {
                users: await accounts.listUsers(),
                invites: await accounts.listPendingInvites(),
                requests: await accounts.listPendingAccessRequests(),
              }
            : undefined,
      }),
    );
  });

  // Signing in

  app.get('/login', (c) => (c.get('user') ? c.redirect('/') : c.html(loginPage())));

  app.post('/login', async (c) => {
    const field = await form(c);
    const email = field('email').trim();
    if (!email) return c.html(loginPage('Enter your email.'), 400);
    const user = await accounts.getUserByEmail(email);
    if (user && !user.disabledAt) {
      const link = `${publicOrigin}/auth?token=${await accounts.createLoginLink(user.id)}`;
      await mailer.send({
        to: user.email,
        subject: 'Your via443 sign-in link',
        text: `Sign in to via443:\n\n${link}\n\nThe link works once and expires in 15 minutes.`,
      });
    }
    // The same answer either way, so the form doesn't reveal who has an account.
    return c.html(
      messagePage('Check your email', 'If an account exists for that address, a sign-in link is on its way. It expires in 15 minutes.'),
    );
  });

  app.get('/auth', (c) => c.html(confirmLoginPage(c.req.query('token') ?? '')));

  app.post('/auth', async (c) => {
    const user = await accounts.consumeLoginLink((await form(c))('token'));
    if (!user) {
      return c.html(messagePage('Link expired', 'This sign-in link is invalid, expired or already used. Request a new one.', { error: true }), 400);
    }
    return signIn(c, user.id);
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, cookieName);
    if (token) await accounts.deleteSession(token);
    deleteCookie(c, cookieName, { path: '/', secure });
    return c.redirect('/', 303);
  });

  // Joining

  app.get('/invite', async (c) => {
    const token = c.req.query('token') ?? '';
    const invite = await accounts.findInvite(token);
    if (!invite) return c.html(messagePage('Invite not valid', 'This invite link is invalid, expired or already used.', { error: true }), 404);
    return c.html(invitePage(token, invite));
  });

  app.post('/invite', async (c) => {
    const field = await form(c);
    const token = field('token');
    try {
      const user = await accounts.acceptInvite(token, field('email'));
      return signIn(c, user.id);
    } catch (err) {
      const invite = await accounts.findInvite(token);
      if (err instanceof AccountError && invite) return c.html(invitePage(token, invite, err.message), 400);
      throw err;
    }
  });

  app.get('/request-access', (c) => c.html(requestAccessPage()));

  app.post('/request-access', async (c) => {
    const field = await form(c);
    try {
      await accounts.requestAccess(field('email'), field('message'));
    } catch (err) {
      if (err instanceof AccountError) return c.html(requestAccessPage(err.message), 400);
      throw err;
    }
    return c.html(messagePage('Request sent', "Thanks! You'll get an invite link if your request is approved."));
  });

  app.get('/setup', async (c) => {
    const token = c.req.query('token') ?? '';
    if (!(await setupAllowed(token))) return c.notFound();
    return c.html(setupPage(token));
  });

  app.post('/setup', async (c) => {
    const field = await form(c);
    const token = field('token');
    if (!(await setupAllowed(token))) return c.notFound();
    try {
      const user = await accounts.createFirstAdmin(field('email'));
      return signIn(c, user.id);
    } catch (err) {
      if (err instanceof AccountError && err.code === 'invalid_email') return c.html(setupPage(token, err.message), 400);
      throw err;
    }
  });

  async function setupAllowed(token: string): Promise<boolean> {
    if (!config.setupToken || !token) return false;
    // Compare hashes so the comparison time doesn't depend on how much of the token matches.
    if ((await sha256Hex(token)) !== (await sha256Hex(config.setupToken))) return false;
    return !(await accounts.hasUsers());
  }

  // API tokens

  app.post('/tokens', async (c) => {
    const user = requireUser(c);
    const { token, info } = await accounts.createApiToken(user.id, (await form(c))('name'));
    return c.html(
      secretPage(
        `Token "${info.name}" created`,
        'Copy your token now. Pass it to the client with --token or the VIA443_TOKEN environment variable.',
        token,
        user,
        tokenCommand(token, serverFlag),
      ),
    );
  });

  app.post('/tokens/:id/revoke', async (c) => {
    const user = requireUser(c);
    const tokenId = c.req.param('id');
    if (await accounts.revokeApiToken(user.id, tokenId)) await config.onAccessRevoked?.({ tokenId });
    return c.redirect('/', 303);
  });

  // Admin

  app.post('/admin/invites', async (c) => {
    const admin = requireAdmin(c);
    const field = await form(c);
    const role: Role = field('role') === 'admin' ? 'admin' : 'user';
    const email = field('email').trim();
    const { token } = await accounts.createInvite({ createdBy: admin.id, email: email || undefined, role });
    return c.html(
      secretPage(
        'Invite link created',
        `Send this link to ${email || 'the person you are inviting'}. It works once and expires in 7 days.`,
        `${publicOrigin}/invite?token=${token}`,
        admin,
      ),
    );
  });

  app.post('/admin/invites/:id/revoke', async (c) => {
    requireAdmin(c);
    await accounts.revokeInvite(c.req.param('id'));
    return c.redirect('/', 303);
  });

  app.post('/admin/requests/:id/approve', async (c) => {
    const admin = requireAdmin(c);
    const { email, token } = await accounts.approveAccessRequest(c.req.param('id'), admin.id);
    return c.html(
      secretPage(
        'Request approved',
        `Send this invite link to ${email}. It works once, only for that address, and expires in 7 days.`,
        `${publicOrigin}/invite?token=${token}`,
        admin,
      ),
    );
  });

  app.post('/admin/requests/:id/reject', async (c) => {
    const admin = requireAdmin(c);
    await accounts.rejectAccessRequest(c.req.param('id'), admin.id);
    return c.redirect('/', 303);
  });

  app.post('/admin/users/:id/login-link', async (c) => {
    const admin = requireAdmin(c);
    const user = await accounts.getUser(c.req.param('id'));
    if (!user || user.disabledAt) throw new AccountError('not_found', 'No active user with this ID.');
    const token = await accounts.createLoginLink(user.id);
    return c.html(
      secretPage(
        `Sign-in link for ${user.email}`,
        'Send this link to them. It works once and expires in 15 minutes.',
        `${publicOrigin}/auth?token=${token}`,
        admin,
      ),
    );
  });

  app.post('/admin/users/:id/disable', async (c) => {
    const admin = requireAdmin(c);
    const userId = c.req.param('id');
    if (userId === admin.id) throw new AccountError('forbidden', "You can't disable your own account.");
    await accounts.setDisabled(userId, true);
    await config.onAccessRevoked?.({ userId });
    return c.redirect('/', 303);
  });

  app.post('/admin/users/:id/enable', async (c) => {
    requireAdmin(c);
    await accounts.setDisabled(c.req.param('id'), false);
    return c.redirect('/', 303);
  });

  return app;
}
