import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { userAgentFor } from './identity.ts';
import { preparePage } from './prepare.ts';
import { extractVector, pageToSvgGroup, type VectorPage } from './vector.ts';
import type { Device, Route } from './types.ts';

export interface FigmaOptions {
  baseUrl: string;
  device: Device;
  theme: 'light' | 'dark';
  outDir: string;
  timeoutMs: number;
  concurrency: number;
  fullPage: boolean;
  /** Gap between page frames in the combined file. */
  gap: number;
  storageState?: string;
  insecure?: boolean;
  userAgent?: string;
  hide?: string[];
  waitFor?: string;
  delayMs?: number;
  lazyLoad?: boolean;
  dismissBanners?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface FigmaResult {
  file: string;
  pages: { route: string; nodes: number; skipped?: string }[];
  totalNodes: number;
}

const slug = (path: string): string =>
  path === '/' ? 'home' : path.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-');

/**
 * Capture each route as vector and write one SVG whose top-level groups are
 * the pages, laid out left to right. Dropping that single file into Figma
 * gives you every page as a group of editable text and shapes.
 */
export async function exportFigma(
  browser: Browser,
  routes: Route[],
  opts: FigmaOptions,
): Promise<FigmaResult> {
  mkdirSync(opts.outDir, { recursive: true });
  const pagesDir = join(opts.outDir, 'pages');
  mkdirSync(pagesDir, { recursive: true });

  const results: (VectorPage | null)[] = new Array(routes.length).fill(null);
  const notes: FigmaResult['pages'] = new Array(routes.length);
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    const context = await browser.newContext({
      viewport: { width: opts.device.width, height: opts.device.height },
      deviceScaleFactor: 1,
      isMobile: opts.device.mobile,
      colorScheme: opts.theme,
      reducedMotion: 'reduce',
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
      ...(opts.insecure ? { ignoreHTTPSErrors: true } : {}),
      userAgent: opts.userAgent ?? userAgentFor(opts.device, browser.version()),
      locale: 'en-US',
      extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    });
    for (;;) {
      const index = cursor++;
      if (index >= routes.length) break;
      const route = routes[index]!;
      const page = await context.newPage();
      try {
        await page.goto(new URL(route.path, opts.baseUrl).toString(), {
          waitUntil: 'domcontentloaded',
          timeout: opts.timeoutMs,
        });
        try {
          await page.waitForLoadState('networkidle', { timeout: 4000 });
        } catch {
          // never-idle page; the DOM is already measurable
        }
        await preparePage(page, {
          hide: opts.hide ?? [],
          delayMs: opts.delayMs ?? 0,
          lazyLoad: opts.lazyLoad ?? true,
          dismissBanners: opts.dismissBanners ?? true,
          ...(opts.waitFor ? { waitFor: opts.waitFor } : {}),
        });
        const vector = await extractVector(page);
        results[index] = vector;
        notes[index] = { route: route.path, nodes: vector.nodes.length };
      } catch (error) {
        notes[index] = {
          route: route.path,
          nodes: 0,
          skipped: error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : 'failed',
        };
      } finally {
        await page.close().catch(() => {});
        done++;
        opts.onProgress?.(done, routes.length);
      }
    }
    await context.close().catch(() => {});
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

  // Lay the pages out in a row, tallest page setting the row height.
  const groups: string[] = [];
  let x = 0;
  let maxHeight = 0;
  routes.forEach((route, i) => {
    const vector = results[i];
    if (!vector) return;
    const name = slug(route.path);
    groups.push(pageToSvgGroup(vector, name, x, 0));
    // Each page is also written on its own, for importing one at a time.
    writeFileSync(
      join(pagesDir, `${name}.svg`),
      wrapSvg(pageToSvgGroup(vector, name, 0, 0), vector.width, vector.height),
    );
    x += vector.width + opts.gap;
    maxHeight = Math.max(maxHeight, vector.height);
  });

  const file = join(opts.outDir, 'allpages.svg');
  writeFileSync(file, wrapSvg(groups.join('\n'), Math.max(x - opts.gap, 1), Math.max(maxHeight, 1)));

  return {
    file,
    pages: notes.filter(Boolean),
    totalNodes: notes.reduce((sum, n) => sum + (n?.nodes ?? 0), 0),
  };
}

export function wrapSvg(body: string, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}">
${body}
</svg>
`;
}
