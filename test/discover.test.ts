import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDynamic, mergeRoutes, normalizePath, routesFromDisk } from '../src/discover.ts';
import { looksLikeAuthWall } from '../src/capture.ts';
import { chooseSheetWidth, buildHtml } from '../src/sheet.ts';
import { DEVICES, type Route, type Shot } from '../src/types.ts';

function project(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'allpages-'));
  for (const file of files) {
    const full = join(dir, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'export default function P(){}');
  }
  return dir;
}

const paths = (routes: Route[]): string[] => routes.map((r) => r.path).sort();

test('reads Next.js app-router routes off disk', () => {
  const dir = project([
    'app/page.tsx',
    'app/pricing/page.tsx',
    'app/blog/[slug]/page.tsx',
    'app/(marketing)/about/page.tsx',
    'app/api/webhook/route.ts',
    'app/layout.tsx',
  ]);
  const found = paths(routesFromDisk(dir));
  assert.deepEqual(found, ['/', '/about', '/blog/[slug]', '/pricing']);
});

test('route groups are stripped, api and internals ignored', () => {
  const dir = project(['app/(shop)/(sale)/deals/page.tsx', 'app/api/x/route.ts', 'app/_private/page.tsx']);
  assert.deepEqual(paths(routesFromDisk(dir)), ['/deals']);
});

test('reads pages-router and SvelteKit layouts', () => {
  // pages/index.tsx is the root route, not "/index".
  const pages = project(['pages/index.tsx', 'pages/about.tsx', 'pages/blog/[id].tsx']);
  assert.deepEqual(paths(routesFromDisk(pages)), ['/', '/about', '/blog/[id]']);

  const svelte = project(['src/routes/+page.svelte', 'src/routes/pricing/+page.svelte']);
  assert.deepEqual(paths(routesFromDisk(svelte)), ['/', '/pricing']);
});

test('returns nothing for a project with no recognizable routes', () => {
  const dir = project(['src/lib/util.ts', 'README.md']);
  assert.deepEqual(routesFromDisk(dir), []);
});

test('normalizes paths', () => {
  assert.equal(normalizePath('/about/'), '/about');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('about'), '/about');
  assert.equal(normalizePath('/x?y=1#z'), '/x');
});

test('recognizes dynamic route templates', () => {
  assert.ok(isDynamic('/blog/[slug]'));
  assert.ok(isDynamic('/orders/:id'));
  assert.ok(isDynamic('/docs/[...rest]'));
  assert.ok(!isDynamic('/pricing'));
});

test('a dynamic route resolves to a real URL found while crawling', () => {
  // The whole point: shooting the literal "[id]" would 404, so a concrete
  // example seen in the wild stands in for the template.
  const merged = mergeRoutes(
    [{ path: '/orders/[id]', source: 'manifest' }],
    [{ path: '/orders/42', source: 'crawl' }],
  );
  const order = merged.find((r) => r.path.startsWith('/orders'));
  assert.equal(order?.path, '/orders/42');
  assert.equal(order?.template, '/orders/[id]');
});

test('a dynamic route with no example survives as a template, not a 404', () => {
  const merged = mergeRoutes([{ path: '/orders/[id]', source: 'manifest' }], []);
  assert.deepEqual(paths(merged), ['/orders/[id]']);
});

test('catch-all templates match multi-segment URLs', () => {
  const merged = mergeRoutes(
    [{ path: '/docs/[...slug]', source: 'manifest' }],
    [{ path: '/docs/a/b/c', source: 'crawl' }],
  );
  assert.ok(merged.some((r) => r.path === '/docs/a/b/c'));
});

test('merging deduplicates and sorts', () => {
  const merged = mergeRoutes(
    [{ path: '/pricing', source: 'manifest' }],
    [{ path: '/pricing', source: 'crawl' }, { path: '/about', source: 'crawl' }],
  );
  assert.deepEqual(paths(merged), ['/about', '/pricing']);
});

test('detects login walls by path', () => {
  for (const p of ['/login', '/signin', '/sign-in', '/auth/callback', '/account/login', '/register']) {
    assert.ok(looksLikeAuthWall(p), `${p} should look like an auth wall`);
  }
  for (const p of ['/pricing', '/blog/logging-best-practices', '/']) {
    assert.ok(!looksLikeAuthWall(p), `${p} should not`);
  }
});

function shot(path: string, device: 'phone' | 'desktop', theme: 'light' | 'dark', captured = true): Shot {
  return {
    route: { path, source: 'crawl' },
    device: DEVICES[device]!,
    theme,
    ...(captured ? { file: `${path.slice(1) || 'home'}--${device}--${theme}.png` } : { skipped: 'redirected to /login' }),
  };
}

test('sheet width solver produces a landscape sheet, not a skyscraper', () => {
  const shots: Shot[] = [];
  for (let i = 0; i < 12; i++) {
    for (const theme of ['light', 'dark'] as const) {
      shots.push(shot(`/p${i}`, 'phone', theme));
      shots.push(shot(`/p${i}`, 'desktop', theme));
    }
  }
  const tileHeight = 200;
  const width = chooseSheetWidth(shots, tileHeight);
  assert.ok(width >= 1280 && width <= 4000, `unreasonable width ${width}`);

  // Recompute the height the same way the solver does and check the shape.
  const desktopW = Math.round(tileHeight * (1440 / 900));
  const phoneW = Math.round(tileHeight * (390 / 844));
  const content = width - 80;
  let height = 150;
  for (const [tileW, count] of [
    [desktopW, 24],
    [phoneW, 24],
  ] as const) {
    const perRow = Math.max(1, Math.floor(content / (tileW + 20)));
    height += Math.ceil(count / perRow) * (tileHeight + 46 + 20) + 40;
  }
  const ratio = width / height;
  assert.ok(ratio > 1.0 && ratio < 2.6, `sheet aspect ${ratio.toFixed(2)} is not landscape-ish`);
});

test('empty input does not crash the solver', () => {
  assert.equal(chooseSheetWidth([], 200), 1280);
});

test('skipped routes become one honest line each, not empty tiles', () => {
  const shots = [
    shot('/', 'desktop', 'light'),
    shot('/dashboard', 'desktop', 'light', false),
    shot('/dashboard', 'desktop', 'dark', false),
    shot('/dashboard', 'phone', 'light', false),
  ];
  const html = buildHtml(shots, {
    title: 'x',
    outDir: '/nonexistent',
    outFile: '/tmp/x.png',
    tileHeight: 200,
    sheetWidth: 1600,
    elapsedMs: 1000,
  });
  // One entry for the route, not one per variant.
  const occurrences = html.split('<code>/dashboard</code>').length - 1;
  assert.equal(occurrences, 1, 'skipped route should collapse to a single line');
  assert.ok(html.includes('redirected to /login'), 'reason must be shown');
  assert.ok(html.includes('NOT CAPTURED') || html.includes('not captured'), 'section must be labeled');
});

test('html escapes route paths', () => {
  const shots = [shot('/x"><script>alert(1)</script>', 'desktop', 'light', false)];
  const html = buildHtml(shots, {
    title: '<img>',
    outDir: '/nonexistent',
    outFile: '/tmp/x.png',
    tileHeight: 200,
    sheetWidth: 1600,
    elapsedMs: 1,
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'must not inject raw html');
  assert.ok(html.includes('&lt;script&gt;'), 'should escape');
});

test('routes that flatten to the same slug get distinct filenames', async () => {
  // /blog/post-1 and /blog-post/1 both slugify to "blog-post-1"; without
  // disambiguation the second overwrites the first and a tile shows the
  // wrong page under the right label.
  const { slugsFor } = await import('../src/capture.ts');
  const slugs = slugsFor([
    { path: '/blog/post-1', source: 'crawl' },
    { path: '/blog-post/1', source: 'crawl' },
    { path: '/blog/post/1', source: 'crawl' },
    { path: '/', source: 'crawl' },
  ]);
  const values = [...slugs.values()];
  assert.equal(new Set(values).size, values.length, `collision in ${values.join(', ')}`);
  assert.equal(slugs.get('/'), 'home');
});
