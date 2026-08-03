import test from 'node:test';
import assert from 'node:assert/strict';
import { families, globToRegex, groupRoutes, matchesAny, patternOf } from '../src/group.ts';
import type { Route } from '../src/types.ts';

const routes = (...paths: string[]): Route[] => paths.map((path) => ({ path, source: 'crawl' as const }));

test('a run of sibling pages becomes one pattern', () => {
  const paths = ['/blog/a', '/blog/b', '/blog/c', '/blog/d'];
  assert.equal(patternOf('/blog/a', paths), '/blog/:slug');
});

test('two siblings are not enough to call it a template', () => {
  const paths = ['/blog/a', '/blog/b'];
  assert.equal(patternOf('/blog/a', paths), '/blog/a');
});

test('numeric and date segments get their own placeholders', () => {
  const ids = ['/orders/1', '/orders/2', '/orders/3'];
  assert.equal(patternOf('/orders/1', ids), '/orders/:id');
  const dates = ['/archive/2021', '/archive/2022', '/archive/2023'];
  assert.equal(patternOf('/archive/2021', dates), '/archive/:date');
});

test('top-level pages are never collapsed into each other', () => {
  const paths = ['/about', '/pricing', '/contact', '/careers'];
  for (const p of paths) assert.equal(patternOf(p, paths), p);
});

test('a marketing site collapses to its layouts', () => {
  // The panel's example: 300 pages is not 300 designs.
  const all = routes(
    '/',
    '/pricing',
    '/about',
    ...Array.from({ length: 186 }, (_, i) => `/blog/post-${i}`),
    ...Array.from({ length: 74 }, (_, i) => `/customers/co-${i}`),
  );
  const groups = groupRoutes(all);
  const patterns = groups.map((g) => g.pattern).sort();
  assert.deepEqual(patterns, ['/', '/about', '/blog/:slug', '/customers/:slug', '/pricing']);

  const blog = groups.find((g) => g.pattern === '/blog/:slug');
  assert.equal(blog?.members.length, 186);
  // 263 pages become 5 screenshots.
  assert.equal(groups.length, 5);
});

test('the representative is the shortest, most canonical member', () => {
  const groups = groupRoutes(routes('/blog/zebra-long-title', '/blog/aa', '/blog/mid-length', '/blog/bb'));
  const blog = groups.find((g) => g.pattern.includes(':'));
  assert.equal(blog?.representative.path, '/blog/aa');
});

test('families are the groups standing for more than one page', () => {
  const groups = groupRoutes(routes('/', '/pricing', '/blog/a', '/blog/b', '/blog/c'));
  const fam = families(groups);
  assert.equal(fam.length, 1);
  assert.equal(fam[0]?.pattern, '/blog/:slug');
  assert.equal(fam[0]?.members.length, 3);
});

test('a site with no templates groups to itself, losing nothing', () => {
  const all = routes('/', '/about', '/pricing');
  const groups = groupRoutes(all);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((g) => g.members.length === 1));
});

test('globs match the way people expect', () => {
  assert.ok(globToRegex('/blog/*').test('/blog/hello'));
  assert.ok(!globToRegex('/blog/*').test('/blog/2024/hello'), 'single star stops at a slash');
  assert.ok(globToRegex('/blog/**').test('/blog/2024/hello'), 'double star crosses slashes');
  assert.ok(globToRegex('/docs').test('/docs'));
  assert.ok(!globToRegex('/docs').test('/docsy'));
  assert.ok(matchesAny('/blog/x', ['/about', '/blog/*']));
  assert.ok(!matchesAny('/pricing', ['/about', '/blog/*']));
});

test('grouping is deterministic and shallow-first', () => {
  const all = routes('/docs/api/x', '/docs/api/y', '/docs/api/z', '/', '/pricing');
  const a = groupRoutes(all).map((g) => g.pattern);
  const b = groupRoutes([...all].reverse()).map((g) => g.pattern);
  assert.deepEqual(a, b, 'order of input must not change output');
  assert.equal(a[0], '/', 'shallowest first');
});
