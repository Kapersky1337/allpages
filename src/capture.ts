import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { isDynamic, normalizePath } from './discover.ts';
import { preparePage } from './prepare.ts';
import type { CaptureOptions, Route, Shot, Theme, Device } from './types.ts';

/**
 * Slugs must be unique per route, not merely readable: `/blog/post-1` and
 * `/blog-post/1` both flatten to `blog-post-1`, and the second would
 * overwrite the first — putting the wrong screenshot under the right
 * label, which is the worst thing this tool could do.
 */
export function slugsFor(routes: Route[]): Map<string, string> {
  const slugs = new Map<string, string>();
  const used = new Set<string>();
  for (const route of routes) {
    const base = route.path === '/' ? 'home' : route.path.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-');
    let slug = base || 'page';
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    slugs.set(route.path, slug);
  }
  return slugs;
}

function fileNameFor(slug: string, device: Device, theme: Theme): string {
  return `${slug}--${device.name}--${theme}.png`;
}

/** Wait for the page to stop moving, without hanging on polling apps. */
async function settle(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 4000) });
  } catch {
    // A page that never goes idle (websockets, polling) is normal; the
    // domcontentloaded state already fired, so shoot what we have.
  }
  try {
    await page.evaluate('document.fonts && document.fonts.ready');
  } catch {
    // fonts API unavailable or blocked; not worth failing a shot over
  }
  // Let CSS entrance animations finish so we don't catch a half-faded page.
  await page.waitForTimeout(220);
}

export interface CaptureResult {
  shots: Shot[];
  /** Paths that redirected to a login-looking URL, deduped. */
  authWalled: string[];
  /**
   * True when every dark shot came out byte-identical to its light twin —
   * the app has no dark mode, and showing both would double the sheet
   * while halving the information in it.
   */
  noDarkMode: boolean;
}

/** Drop dark shots that are byte-identical to their light counterpart. */
function dropIdenticalDarkShots(shots: Shot[], outDir: string): { shots: Shot[]; noDarkMode: boolean } {
  const darkShots = shots.filter((s) => s.theme === 'dark' && s.file);
  if (darkShots.length === 0) return { shots, noDarkMode: false };

  let identical = 0;
  const redundant = new Set<Shot>();
  for (const dark of darkShots) {
    const light = shots.find(
      (s) => s.theme === 'light' && s.file && s.route.path === dark.route.path && s.device.name === dark.device.name,
    );
    if (!light?.file) continue;
    try {
      const a = readFileSync(join(outDir, dark.file!));
      const b = readFileSync(join(outDir, light.file));
      if (a.equals(b)) {
        identical++;
        redundant.add(dark);
      }
    } catch {
      // unreadable file; leave the tile alone
    }
  }
  // Only collapse when the app has no dark mode at all. A partial match
  // means some pages do theme, and those differences are worth seeing.
  if (identical !== darkShots.length) return { shots, noDarkMode: false };
  return { shots: shots.filter((s) => !redundant.has(s)), noDarkMode: true };
}

export async function captureAll(
  browser: Browser,
  routes: Route[],
  opts: CaptureOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<CaptureResult> {
  mkdirSync(opts.outDir, { recursive: true });
  const slugs = slugsFor(routes);

  const jobs: { route: Route; device: Device; theme: Theme }[] = [];
  for (const route of routes) {
    for (const device of opts.devices) {
      for (const theme of opts.themes) jobs.push({ route, device, theme });
    }
  }

  const shots: Shot[] = new Array(jobs.length);
  const authWalled = new Set<string>();
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    // One context per worker, reused across jobs: launching a context per
    // shot is the single biggest cost in a naive implementation.
    const contexts = new Map<string, Awaited<ReturnType<Browser['newContext']>>>();
    const contextFor = async (device: Device, theme: Theme) => {
      const key = `${device.name}:${theme}`;
      const existing = contexts.get(key);
      if (existing) return existing;
      const ctx = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.scale,
        isMobile: device.mobile,
        hasTouch: device.mobile,
        colorScheme: theme,
        // Inherit the session the user already has, so private pages shoot
        // as the logged-in user instead of 40 identical login walls.
        ...(opts.storageState ? { storageState: opts.storageState } : {}),
        reducedMotion: 'reduce',
        ...(opts.insecure ? { ignoreHTTPSErrors: true } : {}),
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      });
      contexts.set(key, ctx);
      return ctx;
    };

    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) break;
      const { route, device, theme } = jobs[index]!;

      if (isDynamic(route.path)) {
        shots[index] = { route, device, theme, skipped: 'dynamic route, no example URL found' };
        done++;
        onProgress?.(done, jobs.length);
        continue;
      }

      const started = Date.now();
      const ctx = await contextFor(device, theme);
      const page = await ctx.newPage();
      try {
        const target = new URL(route.path, opts.baseUrl).toString();
        const response = await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: opts.timeoutMs,
        });
        await settle(page, opts.timeoutMs);
        // Real websites need work before they are worth photographing:
        // consent walls, chat widgets, images that only load on scroll.
        await preparePage(page, {
          hide: opts.hide ?? [],
          delayMs: opts.delayMs ?? 0,
          lazyLoad: opts.lazyLoad ?? false,
          dismissBanners: opts.dismissBanners ?? true,
          ...(opts.waitFor ? { waitFor: opts.waitFor } : {}),
        });

        const landed = normalizePath(new URL(page.url()).pathname);
        const redirected = landed !== route.path;
        const status = response?.status() ?? 0;

        if (redirected && looksLikeAuthWall(landed)) {
          authWalled.add(route.path);
          shots[index] = {
            route,
            device,
            theme,
            skipped: `redirected to ${landed}`,
            redirectedTo: landed,
            ms: Date.now() - started,
          };
        } else if (status >= 400) {
          shots[index] = { route, device, theme, skipped: `HTTP ${status}`, ms: Date.now() - started };
        } else {
          const file = fileNameFor(slugs.get(route.path)!, device, theme);
          await page.screenshot({
            path: join(opts.outDir, file),
            fullPage: opts.fullPage,
            animations: 'disabled',
          });
          const title = (await page.title()).trim();
          shots[index] = {
            route,
            device,
            theme,
            file,
            ms: Date.now() - started,
            ...(title ? { title } : {}),
          };
        }
      } catch (error) {
        shots[index] = {
          route,
          device,
          theme,
          skipped: error instanceof Error ? shortError(error.message) : 'failed',
          ms: Date.now() - started,
        };
      } finally {
        await page.close().catch(() => {});
        done++;
        onProgress?.(done, jobs.length);
      }
    }
    for (const ctx of contexts.values()) await ctx.close().catch(() => {});
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  const collapsed = dropIdenticalDarkShots(shots, opts.outDir);
  return { shots: collapsed.shots, authWalled: [...authWalled], noDarkMode: collapsed.noDarkMode };
}

const AUTH_PATH = /(^|\/)(login|signin|sign-in|auth|register|signup|sign-up|account\/login)(\/|$)/i;

export function looksLikeAuthWall(path: string): boolean {
  return AUTH_PATH.test(path);
}

function shortError(message: string): string {
  const first = message.split('\n')[0] ?? message;
  if (/Timeout|timeout/.test(first)) return 'timed out';
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(first)) return 'connection refused';
  if (/ERR_NAME_NOT_RESOLVED/.test(first)) return 'host not found';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}
