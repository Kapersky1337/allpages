import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { isAllowed, isCrawlable, fetchRobots } from '../src/crawl.ts';
import { byImportance, sampleRoutes } from '../src/discover.ts';
import { normalizeUrl } from '../src/api.ts';
import type { Route } from '../src/types.ts';

const route = (path: string): Route => ({ path, source: 'crawl' });

test('urls without a scheme get one', () => {
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('example.com'), 'http://example.com');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  assert.throws(() => normalizeUrl('http://'), 'garbage should throw');
});

test('assets and machinery are never given a tile', () => {
  for (const p of ['/logo.png', '/app.js', '/styles.css', '/font.woff2', '/doc.pdf', '/feed.xml']) {
    assert.ok(!isCrawlable(p), `${p} should be skipped`);
  }
  for (const p of ['/api/users', '/_next/static/chunk', '/wp-admin', '/sitemap.xml', '/robots.txt']) {
    assert.ok(!isCrawlable(p), `${p} should be skipped`);
  }
  for (const p of ['/', '/pricing', '/blog/hello', '/docs/api']) {
    assert.ok(isCrawlable(p), `${p} should be crawlable`);
  }
});

test('robots.txt disallow rules are honored', () => {
  const rules = { disallow: ['/admin', '/private/*', '/search?'] };
  assert.ok(!isAllowed('/admin', rules));
  assert.ok(!isAllowed('/admin/users', rules));
  assert.ok(!isAllowed('/private/x', rules));
  assert.ok(isAllowed('/pricing', rules));
  assert.ok(isAllowed('/', rules));
  // A blanket disallow blocks everything.
  assert.ok(!isAllowed('/anything', { disallow: ['/'] }));
  // No rules means everything is allowed.
  assert.ok(isAllowed('/anything', { disallow: [] }));
});

test('robots.txt is parsed from the * group only', async () => {
  const server: Server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(
        [
          'User-agent: Googlebot',
          'Disallow: /googlebot-only',
          '',
          'User-agent: *',
          'Disallow: /admin   # trailing comment',
          'Disallow: /tmp',
          'Allow: /',
        ].join('\n'),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const rules = await fetchRobots(`http://localhost:${port}`);
    assert.deepEqual(rules.disallow.sort(), ['/admin', '/tmp']);
    assert.ok(!rules.disallow.includes('/googlebot-only'), 'other agents groups must be ignored');
  } finally {
    server.close();
  }
});

test('a missing robots.txt allows everything', async () => {
  const server = createServer((_req, res) => res.writeHead(404).end());
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.deepEqual((await fetchRobots(`http://localhost:${port}`)).disallow, []);
  } finally {
    server.close();
  }
});

test('sampling prefers shallow pages: the map, not one deep section', () => {
  // playwright.dev has 357 routes; alphabetical truncation returns twenty
  // pages of one API section and tells you nothing about the site.
  const routes = [
    route('/docs/api/class-browser'),
    route('/docs/api/class-page'),
    route('/docs/api/class-frame'),
    route('/docs/api/class-locator'),
    route('/'),
    route('/pricing'),
    route('/docs'),
    route('/blog'),
  ];
  const picked = sampleRoutes(routes, 4).map((r) => r.path);
  assert.deepEqual(picked.sort(), ['/', '/blog', '/docs', '/pricing']);
});

test('sampling keeps everything when under the limit, in path order', () => {
  const routes = [route('/b'), route('/a')];
  assert.deepEqual(sampleRoutes(routes, 10).map((r) => r.path), ['/b', '/a']);
});

test('importance ranks by depth, then length, then name', () => {
  const sorted = [route('/zebra'), route('/a/b/c'), route('/'), route('/a/b')].sort(byImportance);
  assert.deepEqual(sorted.map((r) => r.path), ['/', '/zebra', '/a/b', '/a/b/c']);
});
