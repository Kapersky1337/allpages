import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright-core';
import { crawlWithBrowser } from '../src/crawl.ts';
import { routesFromCrawl } from '../src/discover.ts';

/**
 * The distinguishing test for "works on any website": a client-rendered app
 * whose links exist only after JavaScript runs. Reading the HTML finds
 * nothing; a real browser finds everything.
 */
const SPA_HTML = `<!doctype html><html><head><title>SPA</title></head>
<body>
  <div id="root"></div>
  <div id="banner" style="position:fixed;inset:0;background:#000;color:#fff">
    We use cookies. <button id="ok">Accept all</button>
  </div>
  <script>
    // Links are written by "the framework", not present in the HTML.
    document.getElementById('root').innerHTML =
      '<nav>' +
      '<a href="/pricing">Pricing</a>' +
      '<a href="/about">About</a>' +
      '<a href="/blog">Blog</a>' +
      '<a href="/logo.png">Logo asset</a>' +
      '<a href="/admin">Admin</a>' +
      '<a href="https://elsewhere.example.com/x">External</a>' +
      '</nav>';
    document.getElementById('ok').onclick = () => document.getElementById('banner').remove();
  </script>
</body></html>`;

function startSpa(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /admin\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SPA_HTML);
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, port: (server.address() as { port: number }).port })),
  );
}

let browser: Browser | undefined;
async function getBrowser(): Promise<Browser | null> {
  if (browser) return browser;
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try {
      browser = await chromium.launch(channel ? { channel } : {});
      return browser;
    } catch {
      // try the next one
    }
  }
  return null;
}

test('the HTML crawler finds nothing on a client-rendered app', async () => {
  const { server, port } = await startSpa();
  try {
    const routes = await routesFromCrawl(`http://localhost:${port}`, {
      maxPages: 20,
      depth: 2,
      timeoutMs: 5000,
    });
    // Only the entry page — the links don't exist until JS runs.
    assert.deepEqual(routes.map((r) => r.path), ['/']);
  } finally {
    server.close();
  }
});

test('the browser crawler finds links that JavaScript wrote', async (t) => {
  const b = await getBrowser();
  if (!b) return t.skip('no chromium available');
  const { server, port } = await startSpa();
  try {
    const { routes, blockedByRobots } = await crawlWithBrowser(b, `http://localhost:${port}`, {
      maxPages: 20,
      depth: 1,
      timeoutMs: 8000,
      respectRobots: true,
    });
    const paths = routes.map((r) => r.path).sort();
    assert.ok(paths.includes('/pricing'), `expected /pricing in ${paths.join(', ')}`);
    assert.ok(paths.includes('/about'), `expected /about in ${paths.join(', ')}`);
    assert.ok(paths.includes('/blog'), `expected /blog in ${paths.join(', ')}`);
    // Assets, other origins, and robots-disallowed paths stay out.
    assert.ok(!paths.includes('/logo.png'), 'assets must not become tiles');
    assert.ok(!paths.some((p) => p.includes('elsewhere')), 'other origins must not be crawled');
    assert.ok(!paths.includes('/admin'), 'robots.txt disallow must be honored');
    assert.equal(blockedByRobots, 1);
  } finally {
    server.close();
  }
});

test('--no-robots includes paths robots.txt disallows', async (t) => {
  const b = await getBrowser();
  if (!b) return t.skip('no chromium available');
  const { server, port } = await startSpa();
  try {
    const { routes } = await crawlWithBrowser(b, `http://localhost:${port}`, {
      maxPages: 20,
      depth: 1,
      timeoutMs: 8000,
      respectRobots: false,
    });
    assert.ok(routes.some((r) => r.path === '/admin'));
  } finally {
    server.close();
  }
});

test.after(async () => {
  await browser?.close().catch(() => {});
});
