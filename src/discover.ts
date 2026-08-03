import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { httpHeaders } from './identity.ts';
import type { Route } from './types.ts';

// Finding every route with zero config is the whole promise, so this tries
// three sources in order of reliability and merges what it finds:
//   1. the framework's own route files on disk (exact, includes pages nothing links to)
//   2. sitemap.xml (exact, common in real apps)
//   3. crawling same-origin links (works for anything, misses orphans)

const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.svelte-kit', 'out']);

/** Turn a filesystem route file into a URL path, or null if it isn't one. */
function fileToRoute(relative: string): string | null {
  let p = relative.replace(/\\/g, '/');

  // Next.js app router: app/foo/page.tsx → /foo
  const appMatch = /^(?:src\/)?app\/(.*\/)?page\.(tsx|ts|jsx|js|mdx)$/.exec(p);
  if (appMatch) {
    p = `/${appMatch[1] ?? ''}`;
  } else {
    // SvelteKit: only +page.* is a route. +layout, +error and +page.server
    // are not pages, and treating them as routes invents URLs that 404,
    // `sv create` scaffolds a +layout.svelte, so this hits everyone.
    const svelteMatch = /^(?:src\/)?routes\/(.*\/)?\+page\.(svelte|js|ts)$/.exec(p);
    if (svelteMatch) {
      p = `/${svelteMatch[1] ?? ''}`;
    } else {
      // Next.js pages router / Nuxt: pages/foo.tsx → /foo
      const pagesMatch = /^(?:src\/)?pages\/(.*)\.(tsx|ts|jsx|js|mdx|vue)$/.exec(p);
      if (!pagesMatch) return null;
      p = `/${pagesMatch[1]}`;
      if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
      if (/\/_(app|document|error)$/.test(p)) return null;
    }
  }

  // Strip Next.js route groups: /(marketing)/pricing → /pricing
  p = p.replace(/\/\([^/]+\)/g, '');
  // Normalize
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') p = '/';

  // API routes and framework internals aren't pages.
  if (p.startsWith('/api') || p.startsWith('/_')) return null;
  return p;
}

function walk(dir: string, root: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, root, out, depth + 1);
    } else {
      out.push(full.slice(root.length + 1));
    }
  }
}

/** Routes read from the framework's route files in `projectDir`. */
export function routesFromDisk(projectDir: string): Route[] {
  const candidates = ['app', 'src/app', 'pages', 'src/pages', 'src/routes'];
  if (!candidates.some((c) => existsSync(join(projectDir, c)))) return [];
  const files: string[] = [];
  walk(projectDir, projectDir, files);
  const paths = new Set<string>();
  for (const file of files) {
    const route = fileToRoute(file);
    if (route) paths.add(route);
  }
  return [...paths].map((path) => ({ path, source: 'manifest' as const }));
}

/** Routes listed in /sitemap.xml, when the app serves one. */
export async function routesFromSitemap(baseUrl: string, timeoutMs: number): Promise<Route[]> {
  for (const name of ['/sitemap.xml', '/sitemap_index.xml']) {
    try {
      const res = await fetch(new URL(name, baseUrl), {
        signal: AbortSignal.timeout(timeoutMs),
        headers: httpHeaders(),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const paths = new Set<string>();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        try {
          const url = new URL(m[1]!);
          if (url.origin === new URL(baseUrl).origin) paths.add(normalizePath(url.pathname));
        } catch {
          // relative or malformed entry; skip
        }
      }
      if (paths.size > 0) {
        return [...paths].map((path) => ({ path, source: 'sitemap' as const }));
      }
    } catch {
      // no sitemap; fall through
    }
  }
  return [];
}

export function normalizePath(pathname: string): string {
  let p = pathname.split('#')[0]!.split('?')[0]!;
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|pdf|zip|woff2?|ttf|mp4|webm|mp3)$/i;

/**
 * Crawl same-origin links breadth-first. Also the only source that finds
 * *concrete* dynamic URLs (/orders/42), which is what makes a dynamic route
 * shootable instead of a 404 on the literal "[id]".
 */
export async function routesFromCrawl(
  baseUrl: string,
  opts: { maxPages: number; depth: number; timeoutMs: number },
): Promise<Route[]> {
  const origin = new URL(baseUrl).origin;
  const start = normalizePath(new URL(baseUrl).pathname);
  const seen = new Set<string>([start]);
  let frontier = [start];

  for (let level = 0; level < opts.depth && seen.size < opts.maxPages; level++) {
    const next: string[] = [];
    const batch = frontier.slice(0, opts.maxPages);
    const pages = await Promise.all(
      batch.map(async (path) => {
        try {
          const res = await fetch(new URL(path, origin), {
            signal: AbortSignal.timeout(opts.timeoutMs),
            headers: { accept: 'text/html', ...httpHeaders() },
          });
          if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return '';
          return await res.text();
        } catch {
          return '';
        }
      }),
    );
    for (const rawHtml of pages) {
      // Scripts, styles, templates and comments routinely contain href-like
      // strings (a framework's own markup, an inlined router table). Matching
      // inside them invents routes that no link on the page points to.
      const html = rawHtml
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');
      for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'>]+)["']/gi)) {
        const href = m[1]!;
        if (href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
        let url: URL;
        try {
          url = new URL(href, origin);
        } catch {
          continue;
        }
        if (url.origin !== origin) continue;
        const path = normalizePath(url.pathname);
        if (ASSET_RE.test(path) || seen.has(path) || seen.size >= opts.maxPages) continue;
        seen.add(path);
        next.push(path);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return [...seen].map((path) => ({ path, source: 'crawl' as const }));
}

/**
 * Rank routes for a limited sheet. A real site can have hundreds of pages;
 * taking the alphabetical first 20 of playwright.dev yields twenty pages of
 * one API section, which tells you nothing about the site. Shallow pages
 * first gives you the map: /, /docs, /pricing before /docs/api/class-foo.
 */
export function byImportance(a: Route, b: Route): number {
  const depth = (p: string): number => (p === '/' ? 0 : p.split('/').length - 1);
  return (
    depth(a.path) - depth(b.path) ||
    a.path.length - b.path.length ||
    a.path.localeCompare(b.path, undefined, { numeric: true })
  );
}

/**
 * Take the `limit` most representative routes, then restore path order so the
 * sheet reads alphabetically rather than in ranking order. Callers that have
 * grouped pages into layouts pass their own ranking.
 */
export function sampleRoutes(
  routes: Route[],
  limit: number,
  rank: (a: Route, b: Route) => number = byImportance,
): Route[] {
  if (routes.length <= limit) return routes;
  return [...routes]
    .sort(rank)
    .slice(0, limit)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** Is this a dynamic route template rather than a real URL? */
export function isDynamic(path: string): boolean {
  return /\[[^\]]+\]|:[A-Za-z_]|\*/.test(path);
}

/**
 * Merge sources, and resolve dynamic templates against real URLs seen while
 * crawling: `/orders/[id]` becomes `/orders/42` when the crawl found one.
 * Templates with no real example are kept, flagged, and rendered as a
 * labeled empty cell, because an honest hole beats a screenshot of a 404.
 */
export function mergeRoutes(fromDisk: Route[], fromWeb: Route[]): Route[] {
  const concrete = fromWeb.filter((r) => !isDynamic(r.path));
  const byPath = new Map<string, Route>();
  for (const route of concrete) byPath.set(route.path, route);

  for (const route of fromDisk) {
    if (!isDynamic(route.path)) {
      if (!byPath.has(route.path)) byPath.set(route.path, route);
      continue;
    }
    // Find a crawled URL that matches this template's shape.
    const re = templateToRegex(route.path);
    const example = concrete.find((c) => re.test(c.path));
    if (example) {
      byPath.set(example.path, { path: example.path, source: 'manifest', template: route.path });
    } else {
      byPath.set(route.path, route);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

function templateToRegex(template: string): RegExp {
  const pattern = template
    .split('/')
    .map((seg) => {
      if (/^\[\.\.\..+\]$/.test(seg)) return '.+';
      if (/^\[.+\]$/.test(seg) || /^:.+/.test(seg) || seg === '*') return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${pattern}$`);
}
