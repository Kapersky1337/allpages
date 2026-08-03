import type { Browser } from 'playwright-core';
import { normalizePath } from './discover.ts';
import { desktopUserAgent, httpHeaders } from './identity.ts';
import { dismissConsent } from './prepare.ts';
import type { Route } from './types.ts';

/**
 * Crawling with a real browser instead of `fetch`, because on a
 * client-rendered app the links do not exist in the HTML; they appear when
 * React runs. This is what makes allpages work on any site rather than only
 * on server-rendered ones.
 */

export interface CrawlOptions {
  maxPages: number;
  depth: number;
  timeoutMs: number;
  /** Skip paths disallowed by robots.txt. */
  respectRobots: boolean;
  userAgent?: string;
  storageState?: string;
  insecure?: boolean;
  onProgress?: (found: number) => void;
}

const ASSET_RE =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|pdf|zip|dmg|exe|woff2?|ttf|mp4|webm|mp3|rss|atom)$/i;

/** Paths that are never worth a tile on a contact sheet. */
const BORING_RE =
  /^\/(?:api|_next|_nuxt|static|assets|cdn-cgi|wp-json|wp-admin|feed|rss|atom|sitemap.*|robots\.txt)(\/|$)/i;

export interface RobotsRules {
  disallow: string[];
}

/** Fetch and parse the `*` user-agent group of robots.txt. Best-effort. */
export async function fetchRobots(baseUrl: string, timeoutMs = 4000): Promise<RobotsRules> {
  try {
    const res = await fetch(new URL('/robots.txt', baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: httpHeaders(),
    });
    if (!res.ok) return { disallow: [] };
    const text = await res.text();
    const disallow: string[] = [];
    let inStarGroup = false;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.split('#')[0]!.trim();
      if (!line) continue;
      const [rawKey, ...rest] = line.split(':');
      const key = (rawKey ?? '').trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') {
        inStarGroup = value === '*';
      } else if (key === 'disallow' && inStarGroup && value) {
        disallow.push(value);
      }
    }
    return { disallow };
  } catch {
    return { disallow: [] };
  }
}

export function isAllowed(path: string, rules: RobotsRules): boolean {
  return !rules.disallow.some((rule) => {
    if (rule === '/') return true;
    const prefix = rule.replace(/\*.*$/, '');
    return path.startsWith(prefix);
  });
}

/** Should this path get a tile? */
export function isCrawlable(path: string): boolean {
  return !ASSET_RE.test(path) && !BORING_RE.test(path);
}

/**
 * Breadth-first crawl in a real browser. Returns concrete, same-origin
 * paths, including the ones a router renders client-side.
 */
export async function crawlWithBrowser(
  browser: Browser,
  baseUrl: string,
  opts: CrawlOptions,
): Promise<{ routes: Route[]; blockedByRobots: number }> {
  const origin = new URL(baseUrl).origin;
  const start = normalizePath(new URL(baseUrl).pathname);
  const robots = opts.respectRobots ? await fetchRobots(baseUrl) : { disallow: [] };

  const seen = new Set<string>([start]);
  let blockedByRobots = 0;
  let frontier = [start];

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: opts.userAgent ?? desktopUserAgent(browser.version()),
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
    ...(opts.insecure ? { ignoreHTTPSErrors: true } : {}),
    // Images and fonts are irrelevant to link extraction; skipping them
    // makes the crawl several times faster on media-heavy sites.
    serviceWorkers: 'block',
  });
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') return route.abort();
    return route.continue();
  });

  try {
    for (let level = 0; level < opts.depth && seen.size < opts.maxPages; level++) {
      const next: string[] = [];
      for (const path of frontier) {
        if (seen.size >= opts.maxPages) break;
        const page = await context.newPage();
        try {
          await page.goto(new URL(path, origin).toString(), {
            waitUntil: 'domcontentloaded',
            timeout: opts.timeoutMs,
          });
          try {
            await page.waitForLoadState('networkidle', { timeout: 3500 });
          } catch {
            // long-polling app; the DOM is already good enough for links
          }
          // A consent wall can hide the entire nav behind it.
          if (level === 0) await dismissConsent(page);

          const hrefs: string[] = await page.evaluate(() =>
            [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href),
          );

          for (const href of hrefs) {
            if (seen.size >= opts.maxPages) break;
            let url: URL;
            try {
              url = new URL(href);
            } catch {
              continue;
            }
            if (url.origin !== origin) continue;
            const found = normalizePath(url.pathname);
            if (seen.has(found) || !isCrawlable(found)) continue;
            if (opts.respectRobots && !isAllowed(found, robots)) {
              blockedByRobots++;
              continue;
            }
            seen.add(found);
            next.push(found);
            opts.onProgress?.(seen.size);
          }
        } catch {
          // unreachable page; its links are simply unavailable
        } finally {
          await page.close().catch(() => {});
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
  } finally {
    await context.close().catch(() => {});
  }

  return {
    routes: [...seen].map((path) => ({ path, source: 'crawl' as const })),
    blockedByRobots,
  };
}
