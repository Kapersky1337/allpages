import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_ABOVE, selectRoutes } from '../src/api.ts';
import type { Route } from '../src/types.ts';

const routes = (...paths: string[]): Route[] => paths.map((path) => ({ path, source: 'crawl' as const }));

/** A 267-page marketing site: 9 real layouts, 186 posts, 74 case studies. */
function bigSite(): Route[] {
  return routes(
    '/',
    '/about',
    '/pricing',
    '/careers',
    '/blog',
    '/customers',
    '/legal/terms',
    ...Array.from({ length: 186 }, (_, i) => `/blog/post-${i + 1}`),
    ...Array.from({ length: 74 }, (_, i) => `/customers/co-${i + 1}`),
  );
}

const defaults = { max: 20, only: [], exclude: [], group: true, all: false };

test('a small site is untouched: no grouping, no cap, no surprises', () => {
  const all = routes('/', '/about', '/pricing');
  const { routes: picked } = selectRoutes(all, defaults);
  assert.deepEqual(picked.map((r) => r.path), ['/', '/about', '/pricing']);
  assert.ok(picked.every((r) => !r.standsFor), 'nothing should be marked as standing for a family');
});

test('a site right at the threshold is still shot page by page', () => {
  const all = routes(...Array.from({ length: GROUP_ABOVE }, (_, i) => `/blog/post-${i}`));
  const { routes: picked } = selectRoutes(all, { ...defaults, max: 100 });
  assert.equal(picked.length, GROUP_ABOVE);
  assert.ok(picked.every((r) => !r.standsFor));
});

test('a big site collapses to its layouts, and says what each stands for', () => {
  const { routes: picked } = selectRoutes(bigSite(), defaults);
  assert.ok(picked.length <= 12, `expected a handful of layouts, got ${picked.length}`);

  const blog = picked.find((r) => r.standsFor?.pattern === '/blog/:slug');
  assert.ok(blog, `no /blog/:slug family in ${picked.map((r) => r.path).join(', ')}`);
  assert.equal(blog.standsFor?.count, 186);
  assert.ok(blog.path.startsWith('/blog/'), 'the representative must be a real URL');

  const customers = picked.find((r) => r.standsFor?.pattern === '/customers/:slug');
  assert.equal(customers?.standsFor?.count, 74);

  // The distinct top-level pages survive as themselves.
  for (const p of ['/', '/about', '/pricing']) {
    assert.ok(picked.some((r) => r.path === p && !r.standsFor), `${p} should be shot as itself`);
  }
});

test('--only opens a family up instead of re-collapsing it', () => {
  // This is what the footer tells people to run; if grouping still applied,
  // asking for 186 blog posts would hand back one tile.
  const { routes: picked, considered } = selectRoutes(bigSite(), {
    ...defaults,
    only: ['/blog/*'],
    max: 8,
  });
  assert.equal(considered, 186, 'the filter should report what it matched');
  assert.equal(picked.length, 8);
  assert.ok(picked.every((r) => r.path.startsWith('/blog/')), 'only blog pages');
  assert.ok(picked.every((r) => !r.standsFor), 'an explicit --only must not group');
});

test('--exclude removes a family', () => {
  const { routes: picked } = selectRoutes(bigSite(), {
    ...defaults,
    exclude: ['/blog/*', '/customers/*'],
    max: 50,
  });
  assert.ok(!picked.some((r) => r.path.startsWith('/blog/post')), 'no blog posts');
  assert.ok(!picked.some((r) => r.path.startsWith('/customers/co')), 'no case studies');
  assert.ok(picked.some((r) => r.path === '/pricing'));
});

test('--all shoots pages individually, still bounded by --max', () => {
  const { routes: picked } = selectRoutes(bigSite(), { ...defaults, all: true, max: 30 });
  assert.equal(picked.length, 30);
  assert.ok(picked.every((r) => !r.standsFor), '--all means no collapsing');
});

test('--no-group falls back to shallow sampling', () => {
  const { routes: picked } = selectRoutes(bigSite(), { ...defaults, group: false, max: 6 });
  assert.equal(picked.length, 6);
  assert.ok(picked.every((r) => !r.standsFor));
  // Shallow-first: the map, not six blog posts.
  assert.ok(picked.some((r) => r.path === '/'));
});

test('selection is deterministic', () => {
  const a = selectRoutes(bigSite(), defaults).routes.map((r) => r.path);
  const b = selectRoutes(bigSite(), defaults).routes.map((r) => r.path);
  assert.deepEqual(a, b);
});

test('a filter that matches nothing returns nothing, rather than guessing', () => {
  const { routes: picked } = selectRoutes(bigSite(), { ...defaults, only: ['/nope/*'] });
  assert.equal(picked.length, 0);
});

/**
 * A site with more layouts than --max, which is where the cap decides what
 * the sheet is about. linear.app is the real case: 999 pages, 73 layouts, 20
 * tiles to spend.
 */
function manyLayoutSite(): Route[] {
  return routes(
    '/',
    ...Array.from({ length: 30 }, (_, i) => `/page-${i + 1}`),
    ...Array.from({ length: 298 }, (_, i) => `/integrations/int-${i + 1}`),
    ...Array.from({ length: 246 }, (_, i) => `/changelog/rel-${i + 1}`),
    ...Array.from({ length: 139 }, (_, i) => `/docs/doc-${i + 1}`),
  );
}

test('the layout count is reported, not just the page count', () => {
  const { considered, layouts } = selectRoutes(bigSite(), defaults);
  assert.equal(considered, 267);
  assert.ok(layouts < considered, 'grouping should reduce 267 pages to a handful of layouts');
  assert.ok(layouts >= 7, 'every non-family page still counts as its own layout');
});

test('layouts standing for hundreds of pages survive the cap', () => {
  const { routes: picked, layouts } = selectRoutes(manyLayoutSite(), defaults);
  assert.equal(picked.length, 20);
  assert.ok(layouts > 20, 'this site has more layouts than tiles to show them in');

  // The whole point of grouping is lost if the cap then throws away the
  // families and fills the sheet with one-off pages.
  const stood = picked.filter((r) => r.standsFor).map((r) => r.standsFor!.pattern);
  assert.ok(stood.includes('/integrations/:slug'), '298 pages must not be dropped for a one-off');
  assert.ok(stood.includes('/changelog/:slug'), '246 pages must not be dropped for a one-off');
  assert.ok(stood.includes('/docs/:slug'), '139 pages must not be dropped for a one-off');
  assert.ok(picked.some((r) => r.path === '/'), 'the homepage always earns a tile');
});

test('an ungrouped site reports layouts equal to its pages', () => {
  const { considered, layouts } = selectRoutes(routes('/', '/about'), defaults);
  assert.equal(considered, 2);
  assert.equal(layouts, 2);
});
