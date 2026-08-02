// A tiny multi-page app used to exercise everypage: real routes, dark mode,
// a login wall, and a dynamic route with concrete instances.
import { createServer } from 'node:http';

const shell = (title, body, accent = '#6366f1') => `<!doctype html><html><head>
<meta charset="utf-8"><title>${title} · Northwind</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#0b0b0d;--muted:#6b7280;--card:#f6f6f8;--line:#e5e7eb;--accent:${accent}}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--fg:#f3f4f6;--muted:#9ca3af;--card:#16161b;--line:#26262e}}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
nav{display:flex;gap:20px;padding:16px 24px;border-bottom:1px solid var(--line);align-items:center}
nav b{color:var(--accent)}nav a{color:var(--muted);text-decoration:none;font-size:14px}
main{padding:40px 24px;max-width:900px;margin:0 auto}
h1{font-size:30px;letter-spacing:-.02em;margin-bottom:8px}
p.sub{color:var(--muted);margin-bottom:28px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.card h3{font-size:15px;margin-bottom:6px}.card p{color:var(--muted);font-size:13px}
.btn{display:inline-block;background:var(--accent);color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px}
</style></head><body>
<nav><b>Northwind</b>
<a href="/">Home</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a>
<a href="/blog">Blog</a><a href="/dashboard">Dashboard</a><a href="/settings">Settings</a></nav>
<main>${body}</main></body></html>`;

const cards = (items) => `<div class="grid">${items.map((i) => `<div class="card"><h3>${i[0]}</h3><p>${i[1]}</p></div>`).join('')}</div>`;

const routes = {
  '/': shell('Home', `<h1>Ship faster than ever</h1><p class="sub">The platform for teams that move.</p><a class="btn" href="/pricing">Start free</a>${cards([['Fast','Sub-second builds'],['Simple','One command'],['Safe','Rollbacks included']])}`),
  '/pricing': shell('Pricing', `<h1>Pricing</h1><p class="sub">Simple, flat, honest.</p>${cards([['Hobby','$0 / month'],['Pro','$20 / month'],['Team','$99 / month'],['Enterprise','Talk to us']])}`),
  '/docs': shell('Docs', `<h1>Documentation</h1><p class="sub">Everything, in one place.</p>${cards([['Quickstart','Five minutes'],['CLI','Every command'],['API','REST + webhooks'],['SDKs','JS, Python, Go']])}`),
  '/blog': shell('Blog', `<h1>Blog</h1><p class="sub">Notes from the team.</p><div class="grid"><div class="card"><h3><a href="/blog/launch-week" style="color:inherit">Launch week</a></h3><p>Everything we shipped</p></div><div class="card"><h3><a href="/blog/how-we-build" style="color:inherit">How we build</a></h3><p>Our process</p></div></div>`),
  '/blog/launch-week': shell('Launch week', `<h1>Launch week</h1><p class="sub">Seven days, seven things.</p><p>We shipped every day this week and here is the recap of all of it.</p>`),
  '/blog/how-we-build': shell('How we build', `<h1>How we build</h1><p class="sub">Small teams, short cycles.</p><p>A look inside the way the team works day to day.</p>`),
  '/changelog': shell('Changelog', `<h1>Changelog</h1><p class="sub">What changed, when.</p>${cards([['v2.4','Dark mode'],['v2.3','Faster builds'],['v2.2','Team roles']])}`),
  '/about': shell('About', `<h1>About</h1><p class="sub">We are twelve people in four countries.</p>`),
  '/login': shell('Login', `<h1>Sign in</h1><p class="sub">Welcome back.</p><a class="btn" href="/dashboard">Continue</a>`, '#0ea5e9'),
};

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/\/$/, '') || '/';
  const authed = (req.headers.cookie ?? '').includes('session=yes');

  // Two routes sit behind a login — the exact case that ruins naive tools.
  if ((path === '/dashboard' || path === '/settings') && !authed) {
    res.writeHead(302, { location: '/login' });
    return res.end();
  }
  if (path === '/dashboard') return send(res, shell('Dashboard', `<h1>Dashboard</h1><p class="sub">Signed in as you.</p>${cards([['Revenue','$84,210'],['Users','1,204'],['Churn','1.2%']])}`));
  if (path === '/settings') return send(res, shell('Settings', `<h1>Settings</h1><p class="sub">Private preferences.</p>${cards([['Profile','Name, avatar'],['Billing','Card on file'],['Team','3 members']])}`));

  const order = /^\/orders\/(\w+)$/.exec(path);
  if (order) return send(res, shell(`Order ${order[1]}`, `<h1>Order #${order[1]}</h1><p class="sub">Placed 2 days ago.</p>${cards([['Status','Shipped'],['Total','$129.00']])}`));

  if (routes[path]) return send(res, routes[path]);
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end(shell('Not found', '<h1>404</h1><p class="sub">No such page.</p>'));
});

function send(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}
server.listen(4173, () => console.log('demo app on http://localhost:4173'));
