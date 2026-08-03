import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { captureAll } from './capture.ts';
import { crawlWithBrowser } from './crawl.ts';
import {
  mergeRoutes,
  normalizePath,
  routesFromCrawl,
  routesFromDisk,
  routesFromSitemap,
  sampleRoutes,
} from './discover.ts';
import { families, groupRoutes, matchesAny } from './group.ts';
import { chooseSheetWidth, renderSheet } from './sheet.ts';
import { DEVICES, type Device, type Route, type Shot, type Theme } from './types.ts';

/** Options for {@link allpages}. Only `url` is required. */
export interface AllpagesOptions {
  /** The site to shoot. `localhost:3000` and full URLs both work. */
  url: string;
  /** Device names (`phone`, `tablet`, `desktop`) or full device objects. */
  devices?: (keyof typeof DEVICES | Device)[];
  themes?: Theme[];
  /** Shoot exactly these paths and skip discovery entirely. */
  routes?: string[];
  /** Where the app's source lives, for reading framework route files. */
  projectDir?: string;
  /** Output directory. Receives `allpages.png` and `shots/`. */
  outDir?: string;
  /** Cap on discovered routes (ignored when `routes` is given). */
  max?: number;
  /** Playwright storageState path, so private pages shoot as a logged-in user. */
  storageState?: string;
  concurrency?: number;
  timeoutMs?: number;
  fullPage?: boolean;
  /** Link levels to follow while crawling. */
  depth?: number;
  hide?: string[];
  waitFor?: string;
  delayMs?: number;
  lazyLoad?: boolean;
  dismissBanners?: boolean;
  respectRobots?: boolean;
  insecure?: boolean;
  userAgent?: string;
  /** Only pages matching these globs, e.g. `['/blog/*']`. */
  only?: string[];
  /** Skip pages matching these globs. */
  exclude?: string[];
  /**
   * Collapse pages that share a URL shape into one representative
   * (`/blog/:slug` standing for 186 posts). On by default above 24 pages;
   * set false to shoot pages individually.
   */
  group?: boolean;
  /** Shoot every discovered page rather than one per layout. */
  all?: boolean;
  /** Skip writing the contact sheet and only produce individual shots. */
  skipSheet?: boolean;
  /** Reuse a browser you already launched; it will not be closed. */
  browser?: Browser;
  onProgress?: (done: number, total: number) => void;
}

export interface AllpagesResult {
  /** Absolute path to the contact sheet, unless `skipSheet` was set. */
  sheet?: string;
  /** Every capture attempt, including the ones that produced no image. */
  shots: Shot[];
  /** The routes that were shot. */
  routes: Route[];
  /** Routes that redirected to something that looks like a login. */
  authWalled: string[];
  /** Routes a bot check answered with an interstitial instead of the page. */
  botChecked: string[];
  /** True when the site rendered identically in light and dark. */
  noDarkMode: boolean;
  /** Every page discovered, including ones not shot. */
  discovered: Route[];
  outDir: string;
  elapsedMs: number;
}

export interface DiscoverResult {
  routes: Route[];
  fromDisk: number;
  fromSitemap: number;
  fromCrawl: number;
  usedBrowser: boolean;
  blockedByRobots: number;
}

function toDevice(d: keyof typeof DEVICES | Device): Device {
  if (typeof d === 'string') {
    const device = DEVICES[d];
    if (!device) throw new Error(`unknown device "${d}" (phone, tablet, desktop)`);
    return device;
  }
  return d;
}

/** Add a scheme when the caller passed a bare host. */
export function normalizeUrl(input: string): string {
  const url = /^https?:\/\//.test(input) ? input : `http://${input}`;
  new URL(url); // throws on garbage
  return url;
}

/**
 * Find every page of a site. Reads framework route files, sitemap.xml, and
 * crawled links; falls back to crawling in a real browser when the HTML has
 * no links, which is the normal case for client-rendered apps.
 */
export async function discoverRoutes(
  url: string,
  browser: Browser,
  opts: Pick<AllpagesOptions, 'projectDir' | 'max' | 'depth' | 'timeoutMs' | 'respectRobots' | 'insecure' | 'userAgent' | 'storageState'> = {},
): Promise<DiscoverResult> {
  const max = opts.max ?? 20;
  const depth = opts.depth ?? 2;
  const fromDisk = opts.projectDir ? routesFromDisk(opts.projectDir) : [];
  const [sitemap, quickCrawl] = await Promise.all([
    routesFromSitemap(url, 4000),
    routesFromCrawl(url, { maxPages: 500, depth, timeoutMs: 6000 }),
  ]);

  let browserCrawled: Route[] = [];
  let blockedByRobots = 0;
  const needsJs = quickCrawl.length <= 1 && sitemap.length === 0 && fromDisk.length === 0;
  if (needsJs) {
    const result = await crawlWithBrowser(browser, url, {
      maxPages: 500,
      depth,
      timeoutMs: opts.timeoutMs ?? 15000,
      respectRobots: opts.respectRobots ?? true,
      ...(opts.insecure !== undefined ? { insecure: opts.insecure } : {}),
      ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    browserCrawled = result.routes;
    blockedByRobots = result.blockedByRobots;
  }

  return {
    routes: mergeRoutes(fromDisk, [...sitemap, ...quickCrawl, ...browserCrawled]),
    fromDisk: fromDisk.length,
    fromSitemap: sitemap.length,
    fromCrawl: browserCrawled.length || quickCrawl.length,
    usedBrowser: needsJs,
    blockedByRobots,
  };
}

/** Pages get grouped into layouts above this count. */
export const GROUP_ABOVE = 24;

export interface SelectResult {
  /** The pages worth shooting. */
  routes: Route[];
  /** How many pages survived the filters, before grouping and the cap. */
  considered: number;
  /**
   * How many distinct layouts those pages collapse into. Equal to
   * `considered` when nothing grouped, and the honest denominator for
   * "showing 20 of these" when something did.
   */
  layouts: number;
}

export interface SelectOptions {
  max: number;
  only: string[];
  exclude: string[];
  group: boolean;
  all: boolean;
}

/**
 * Turn everything discovered into the pages actually worth shooting:
 * filters first (explicit intent), then layout grouping (a big site is not
 * a big design), then the cap. Shared by the CLI and the library so the two
 * can never disagree about what a run means.
 */
export function selectRoutes(discovered: Route[], opts: SelectOptions): SelectResult {
  let routes = discovered;
  if (opts.only.length > 0) routes = routes.filter((r) => matchesAny(r.path, opts.only));
  if (opts.exclude.length > 0) routes = routes.filter((r) => !matchesAny(r.path, opts.exclude));
  const considered = routes.length;

  // An explicit --only means the caller already chose; never re-collapse it.
  let grouped = false;
  if (opts.only.length === 0 && opts.group && !opts.all && routes.length > GROUP_ABOVE) {
    const groups = groupRoutes(routes);
    if (families(groups).length > 0) {
      grouped = true;
      routes = groups.map((g) =>
        g.members.length > 1
          ? { ...g.representative, standsFor: { pattern: g.pattern, count: g.members.length } }
          : g.representative,
      );
    }
  }
  const layouts = routes.length;

  // A site can have more layouts than --max, and then the cap decides what
  // the sheet is about. Depth-first ordering alone would spend all twenty
  // tiles on top-level pages and drop `/blog/:slug` standing for 186,
  // the single most informative tile on the sheet. So a family counts as
  // one level shallower than it sits, and the bigger family wins the tie.
  const rank = grouped ? byRepresentativeness : undefined;
  return { routes: sampleRoutes(routes, opts.max, rank), considered, layouts };
}

/** Sort order for grouped routes: shallow first, but families count double. */
function byRepresentativeness(a: Route, b: Route): number {
  const depth = (r: Route): number => {
    const raw = r.path === '/' ? 0 : r.path.split('/').length - 1;
    return r.standsFor ? raw - 1 : raw;
  };
  return (
    depth(a) - depth(b) ||
    (b.standsFor?.count ?? 1) - (a.standsFor?.count ?? 1) ||
    a.path.localeCompare(b.path, undefined, { numeric: true })
  );
}

/**
 * Shoot every page of a site and stitch one contact sheet.
 *
 * ```ts
 * import { allpages } from 'allpages';
 *
 * const { sheet, shots } = await allpages({ url: 'https://example.com' });
 * console.log(sheet); // → /abs/path/allpages/allpages.png
 * ```
 */
export async function allpages(options: AllpagesOptions): Promise<AllpagesResult> {
  const started = Date.now();
  const url = normalizeUrl(options.url);
  const outDir = resolve(options.outDir ?? 'allpages');
  const devices = (options.devices ?? ['phone', 'tablet', 'desktop']).map(toDevice);
  const themes = options.themes ?? (['light', 'dark'] as Theme[]);
  const max = options.max ?? 20;

  const browser = options.browser ?? (await (await import('playwright-core')).chromium.launch());
  const ownsBrowser = !options.browser;

  try {
    let discovered: Route[] = [];
    const routes = options.routes
      ? options.routes.map((path) => ({ path: normalizePath(path), source: 'given' as const }) satisfies Route)
      : selectRoutes(
          (discovered = (
            await discoverRoutes(url, browser, {
              ...(options.projectDir !== undefined ? { projectDir: options.projectDir } : {}),
              max,
              ...(options.depth !== undefined ? { depth: options.depth } : {}),
              ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
              ...(options.respectRobots !== undefined ? { respectRobots: options.respectRobots } : {}),
              ...(options.insecure !== undefined ? { insecure: options.insecure } : {}),
              ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
              ...(options.storageState !== undefined ? { storageState: options.storageState } : {}),
            })
          ).routes),
          {
            max,
            only: options.only ?? [],
            exclude: options.exclude ?? [],
            group: options.group ?? true,
            all: options.all ?? false,
          },
        ).routes;

    mkdirSync(outDir, { recursive: true });
    const shotsDir = resolve(outDir, 'shots');

    const captured = await captureAll(
      browser,
      routes,
      {
        baseUrl: url,
        devices,
        themes,
        outDir: shotsDir,
        concurrency: options.concurrency ?? 8,
        timeoutMs: options.timeoutMs ?? 15000,
        fullPage: options.fullPage ?? false,
        hide: options.hide ?? [],
        delayMs: options.delayMs ?? 0,
        lazyLoad: options.lazyLoad ?? true,
        dismissBanners: options.dismissBanners ?? true,
        ...(options.waitFor !== undefined ? { waitFor: options.waitFor } : {}),
        ...(options.insecure !== undefined ? { insecure: options.insecure } : {}),
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
        ...(options.storageState !== undefined ? { storageState: options.storageState } : {}),
      },
      options.onProgress,
    );

    const elapsedMs = Date.now() - started;
    let sheet: string | undefined;
    if (!options.skipSheet && captured.shots.some((s) => s.file)) {
      const tileHeight = 200;
      sheet = resolve(outDir, 'allpages.png');
      await renderSheet(browser, captured.shots, {
        title: new URL(url).host,
        outDir: shotsDir,
        outFile: sheet,
        tileHeight,
        sheetWidth: chooseSheetWidth(captured.shots, tileHeight),
        elapsedMs,
      });
    }

    return {
      ...(sheet ? { sheet } : {}),
      shots: captured.shots,
      routes,
      discovered: discovered.length > 0 ? discovered : routes,
      authWalled: captured.authWalled,
      botChecked: captured.botChecked,
      noDarkMode: captured.noDarkMode,
      outDir,
      elapsedMs,
    };
  } finally {
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}
