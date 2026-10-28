import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { AccessRequest, ApiTokenInfo, Invite, User } from './accounts.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const style = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #666; --bg: #fff; --line: #ddd; --accent: #0b5fff; --danger: #c62828; --code: #f4f4f4; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #999; --bg: #141414; --line: #333; --accent: #6ea0ff; --danger: #ef6c6c; --code: #222; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 24px; }
  header a.brand { font-weight: 700; color: var(--fg); text-decoration: none; }
  h1 { font-size: 1.4rem; margin: 0 0 16px; } h2 { font-size: 1.1rem; margin: 32px 0 12px; }
  a { color: var(--accent); }
  p.muted, span.muted, td.muted { color: var(--muted); }
  form.inline { display: inline; margin: 0; }
  form.stack { display: grid; gap: 10px; max-width: 420px; }
  input, textarea, select { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); width: 100%; }
  button { font: inherit; padding: 6px 12px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); }
  button.danger { background: transparent; border-color: var(--danger); color: var(--danger); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row input { width: auto; flex: 1; min-width: 160px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; font-size: 0.9em; color: var(--muted); }
  code, pre { font-family: ui-monospace, monospace; background: var(--code); border-radius: 4px; }
  code { padding: 1px 4px; } pre { padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .notice { border: 1px solid var(--line); border-left: 4px solid var(--accent); padding: 10px 14px; border-radius: 6px; margin: 16px 0; }
  .error { border-left-color: var(--danger); }
`;

export function layout(title: string, body: Html, user?: User | null): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · via443</title>
<style>${style}</style>
</head>
<body>
<main>
<header>
  <a class="brand" href="/">via443</a>
  ${user
    ? html`<div class="row"><span class="muted">${user.email}</span>
        <form class="inline" method="post" action="/logout"><button class="secondary">Sign out</button></form></div>`
    : ''}
</header>
${body}
</main>
</body>
</html>`;
}

const date = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

export function landingPage(): Html {
  return layout(
    'Welcome',
    html`<h1>via443</h1>
<p>Share a local dev server through a tunnel that only needs HTTPS on port 443, even behind a corporate or sandbox proxy.</p>
<p>This relay is invite-only.</p>
<div class="row"><a href="/login">Sign in</a> · <a href="/request-access">Request access</a></div>`,
  );
}

export function messagePage(title: string, message: string, options: { error?: boolean; user?: User | null } = {}): Html {
  return layout(
    title,
    html`<h1>${title}</h1><div class="notice ${options.error ? 'error' : ''}">${message}</div><p><a href="/">Back</a></p>`,
    options.user,
  );
}

/** Shows a secret (token or link) that can't be shown again. */
export function secretPage(title: string, explanation: string, secret: string, user: User): Html {
  return layout(
    title,
    html`<h1>${title}</h1>
<p>${explanation}</p>
<pre>${secret}</pre>
<p class="muted">This is shown only once.</p>
<p><a href="/">Back to the dashboard</a></p>`,
    user,
  );
}

export function loginPage(error?: string): Html {
  return layout(
    'Sign in',
    html`<h1>Sign in</h1>
${error ? html`<div class="notice error">${error}</div>` : ''}
<form class="stack" method="post" action="/login">
  <label>Email <input type="email" name="email" required autocomplete="email"></label>
  <button>Send sign-in link</button>
</form>
<p class="muted">No account? <a href="/request-access">Request access</a>.</p>`,
  );
}

export function confirmLoginPage(token: string): Html {
  // A button, not an automatic sign-in: link scanners in mail clients follow GET links and would use up the link.
  return layout(
    'Sign in',
    html`<h1>Sign in</h1>
<form method="post" action="/auth">
  <input type="hidden" name="token" value="${token}">
  <button>Continue to via443</button>
</form>`,
  );
}

export function requestAccessPage(error?: string): Html {
  return layout(
    'Request access',
    html`<h1>Request access</h1>
${error ? html`<div class="notice error">${error}</div>` : ''}
<form class="stack" method="post" action="/request-access">
  <label>Email <input type="email" name="email" required autocomplete="email"></label>
  <label>Who are you, and what will you use it for? <textarea name="message" rows="4" maxlength="1000"></textarea></label>
  <button>Request access</button>
</form>`,
  );
}

export function invitePage(token: string, invite: Invite, error?: string): Html {
  return layout(
    'Accept invite',
    html`<h1>You're invited to via443</h1>
${error ? html`<div class="notice error">${error}</div>` : ''}
<form class="stack" method="post" action="/invite">
  <input type="hidden" name="token" value="${token}">
  <label>Email <input type="email" name="email" required autocomplete="email" value="${invite.email ?? ''}" ${invite.email ? 'readonly' : ''}></label>
  <button>Create account</button>
</form>`,
  );
}

export function setupPage(token: string, error?: string): Html {
  return layout(
    'Set up',
    html`<h1>Set up this relay</h1>
<p>Create the admin account. This page works only until the first account exists.</p>
${error ? html`<div class="notice error">${error}</div>` : ''}
<form class="stack" method="post" action="/setup">
  <input type="hidden" name="token" value="${token}">
  <label>Your email <input type="email" name="email" required autocomplete="email"></label>
  <button>Create admin account</button>
</form>`,
  );
}

export interface DashboardData {
  user: User;
  tokens: ApiTokenInfo[];
  /** The `--server` flag users need, or empty when the client's default applies. */
  serverFlag: string;
  admin?: {
    users: User[];
    invites: Invite[];
    requests: AccessRequest[];
  };
}

export function dashboardPage(data: DashboardData): Html {
  const { user, tokens, admin } = data;
  return layout(
    'Dashboard',
    html`<h1>Dashboard</h1>

<h2>Expose a local port</h2>
<pre>npx via443 --port 3000${data.serverFlag} --token &lt;your token&gt;</pre>
<p class="muted">Or set <code>VIA443_TOKEN</code> instead of passing <code>--token</code>.</p>

<h2>API tokens</h2>
<form class="row" method="post" action="/tokens">
  <input name="name" placeholder="Token name, e.g. laptop or ci" required maxlength="100">
  <button>Create token</button>
</form>
${tokens.length === 0
  ? html`<p class="muted">No tokens yet.</p>`
  : html`<table>
<tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th></th></tr>
${tokens.map(
  (t) => html`<tr>
  <td>${t.name}</td><td><code>${t.prefix}…</code></td><td class="muted">${date(t.createdAt)}</td><td class="muted">${date(t.lastUsedAt)}</td>
  <td>${t.revokedAt
    ? html`<span class="muted">revoked</span>`
    : html`<form class="inline" method="post" action="/tokens/${t.id}/revoke"><button class="danger">Revoke</button></form>`}</td>
</tr>`,
)}
</table>`}

${admin ? adminSection(admin, user) : ''}`,
    user,
  );
}

function adminSection(admin: NonNullable<DashboardData['admin']>, me: User): Html {
  return html`
<h2>Access requests</h2>
${admin.requests.length === 0
  ? html`<p class="muted">No pending requests.</p>`
  : html`<table>
<tr><th>Email</th><th>Message</th><th>Requested</th><th></th></tr>
${admin.requests.map(
  (r) => html`<tr>
  <td>${r.email}</td><td>${r.message}</td><td class="muted">${date(r.createdAt)}</td>
  <td class="row">
    <form class="inline" method="post" action="/admin/requests/${r.id}/approve"><button>Approve</button></form>
    <form class="inline" method="post" action="/admin/requests/${r.id}/reject"><button class="danger">Reject</button></form>
  </td>
</tr>`,
)}
</table>`}

<h2>Invites</h2>
<form class="row" method="post" action="/admin/invites">
  <input type="email" name="email" placeholder="Email (optional: binds the invite to it)">
  <select name="role" style="width:auto"><option value="user">user</option><option value="admin">admin</option></select>
  <button>Create invite link</button>
</form>
${admin.invites.length === 0
  ? html`<p class="muted">No open invites.</p>`
  : html`<table>
<tr><th>For</th><th>Role</th><th>Expires</th><th></th></tr>
${admin.invites.map(
  (i) => html`<tr>
  <td>${i.email ?? html`<span class="muted">anyone with the link</span>`}</td><td>${i.role}</td><td class="muted">${date(i.expiresAt)}</td>
  <td><form class="inline" method="post" action="/admin/invites/${i.id}/revoke"><button class="danger">Revoke</button></form></td>
</tr>`,
)}
</table>`}

<h2>Users</h2>
<table>
<tr><th>Email</th><th>Role</th><th>Joined</th><th></th></tr>
${admin.users.map(
  (u) => html`<tr>
  <td>${u.email}${u.disabledAt ? html` <span class="muted">(disabled)</span>` : ''}</td><td>${u.role}</td><td class="muted">${date(u.createdAt)}</td>
  <td class="row">
    ${u.disabledAt
      ? html`<form class="inline" method="post" action="/admin/users/${u.id}/enable"><button class="secondary">Enable</button></form>`
      : html`<form class="inline" method="post" action="/admin/users/${u.id}/login-link"><button class="secondary">Sign-in link</button></form>
        ${u.id === me.id
          ? ''
          : html`<form class="inline" method="post" action="/admin/users/${u.id}/disable"><button class="danger">Disable</button></form>`}`}
  </td>
</tr>`,
)}
</table>`;
}
