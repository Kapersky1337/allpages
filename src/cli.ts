#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { captureAll } from './capture.ts';
import { mergeRoutes, routesFromCrawl, routesFromDisk, routesFromSitemap, normalizePath } from './discover.ts';
import { chooseSheetWidth, renderSheet } from './sheet.ts';
import { DEVICES, type Device, type Theme } from './types.ts';

const HELP = `everypage — every page of your app, as one image

  npx everypage http://localhost:3000

Finds every route your app has, shoots each one on phone and desktop in
light and dark, and stitches them into a single contact sheet you can
look at — or drag into Claude or Cursor instead of making it take 47
screenshots one at a time.

Options
  --devices phone,desktop     which sizes (phone, tablet, desktop)
  --themes light,dark         which color schemes
  --auth <state.json>         Playwright storageState, so private pages
                              shoot as the logged-in you
  --routes /a,/b              shoot exactly these, skip discovery
  --project <dir>             where your app's code lives (default: cwd)
  --out <dir>                 output directory (default: ./everypage)
  --max <n>                   cap discovered routes (default: 40)
  --full-page                 capture whole scroll height, not just the fold
  --columns <n>               tiles per row on the sheet
  --concurrency <n>           parallel browser contexts (default: cpu count)
  --no-open                   don't open the sheet when done
  -h, --help                  this help

The sheet is honest: pages that redirected to a login, timed out, or are
dynamic routes with no example URL appear as labeled empty tiles rather
than being quietly dropped.`;

interface Args {
  url: string;
  devices: Device[];
  themes: Theme[];
  auth?: string;
  routes?: string[];
  project: string;
  out: string;
  max: number;
  fullPage: boolean;
  columns?: number;
  concurrency: number;
  open: boolean;
}

function fail(message: string): never {
  process.stderr.write(`everypage: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: '',
    devices: [DEVICES.phone!, DEVICES.desktop!],
    themes: ['light', 'dark'],
    project: process.cwd(),
    out: 'everypage',
    max: 40,
    fullPage: false,
    // Browser contexts are cheap and the work is almost all waiting on the
    // page. Measured on the demo app: 6 → 8.0s, 12 → 4.8s, 16 → 3.8s.
    concurrency: Math.min(16, Math.max(4, cpus().length)),
    open: true,
  };
  const need = (i: number, flag: string): string => argv[i + 1] ?? fail(`${flag} needs a value`);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(`${HELP}\n`);
        process.exit(0);
        break;
      case '-v':
      case '--version':
        process.stdout.write('0.1.0\n');
        process.exit(0);
        break;
      case '--devices': {
        const names = need(i++, '--devices').split(',').map((s) => s.trim());
        args.devices = names.map((n) => DEVICES[n] ?? fail(`unknown device "${n}" (phone, tablet, desktop)`));
        break;
      }
      case '--themes': {
        const names = need(i++, '--themes').split(',').map((s) => s.trim());
        args.themes = names.map((n) =>
          n === 'light' || n === 'dark' ? (n as Theme) : fail(`unknown theme "${n}" (light, dark)`),
        );
        break;
      }
      case '--auth':
        args.auth = need(i++, '--auth');
        break;
      case '--routes':
        args.routes = need(i++, '--routes').split(',').map((s) => normalizePath(s.trim()));
        break;
      case '--project':
        args.project = resolve(need(i++, '--project'));
        break;
      case '--out':
        args.out = need(i++, '--out');
        break;
      case '--max':
        args.max = Math.max(1, Number(need(i++, '--max')) || 40);
        break;
      case '--columns':
        args.columns = Math.max(1, Number(need(i++, '--columns')) || 4);
        break;
      case '--concurrency':
        args.concurrency = Math.max(1, Number(need(i++, '--concurrency')) || 6);
        break;
      case '--full-page':
        args.fullPage = true;
        break;
      case '--no-open':
        args.open = false;
        break;
      default:
        if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
        args.url = arg;
    }
  }
  if (!args.url) fail('give me a URL — npx everypage http://localhost:3000');
  if (!/^https?:\/\//.test(args.url)) args.url = `http://${args.url}`;
  try {
    new URL(args.url);
  } catch {
    fail(`not a URL: ${args.url}`);
  }
  if (args.auth) {
    if (!existsSync(args.auth)) fail(`--auth file not found: ${args.auth}`);
    // Catch a malformed session now, not after shooting a whole sheet of
    // logged-out pages that look fine until you notice they aren't.
    try {
      const parsed: unknown = JSON.parse(readFileSync(args.auth, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !('cookies' in parsed)) {
        fail(`--auth ${args.auth} is not a Playwright storageState (no "cookies" key).\n` +
          `  save one with: npx playwright codegen --save-storage=session.json`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        fail(`--auth ${args.auth} is not valid JSON: ${error.message}`);
      }
      throw error;
    }
  }
  return args;
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const color = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (s: string, c: string): string => (color ? `${c}${s}${RESET}` : s);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  process.stdout.write(`\n  ${paint('everypage', BOLD)} ${paint(args.url, DIM)}\n\n`);

  // 1. Reachability — a clear message beats a wall of browser errors.
  try {
    await fetch(args.url, { signal: AbortSignal.timeout(5000) });
  } catch {
    fail(`can't reach ${args.url} — is your dev server running?`);
  }

  // 2. Discover routes.
  let routes;
  if (args.routes) {
    routes = args.routes.map((path) => ({ path, source: 'given' as const }));
  } else {
    const fromDisk = routesFromDisk(args.project);
    const sitemap = await routesFromSitemap(args.url, 4000);
    const crawled =
      sitemap.length > 0
        ? sitemap
        : await routesFromCrawl(args.url, { maxPages: args.max * 2, depth: 2, timeoutMs: 6000 });
    routes = mergeRoutes(fromDisk, [...sitemap, ...crawled]);
    const how = [
      fromDisk.length > 0 ? `${fromDisk.length} from your route files` : null,
      sitemap.length > 0 ? `${sitemap.length} from sitemap.xml` : null,
      crawled.length > 0 && sitemap.length === 0 ? `${crawled.length} by crawling links` : null,
    ].filter(Boolean);
    if (how.length > 0) process.stdout.write(`  ${paint(`found ${how.join(', ')}`, DIM)}\n`);
  }
  // --max caps *discovery*. Routes you asked for by name are never dropped.
  if (!args.routes && routes.length > args.max) {
    process.stdout.write(
      `  ${paint(`showing the first ${args.max} of ${routes.length} routes (--max to change)`, DIM)}\n`,
    );
    routes = routes.slice(0, args.max);
  }
  if (routes.length === 0) fail('found no pages — pass --routes /,/about to shoot specific ones');

  const total = routes.length * args.devices.length * args.themes.length;
  process.stdout.write(
    `  ${paint(`${routes.length} routes × ${args.devices.length} sizes × ${args.themes.length} themes = ${total} screens`, DIM)}\n\n`,
  );

  // 3. Shoot.
  const outDir = resolve(args.out);
  rmSync(outDir, { recursive: true, force: true });
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
  let result;
  try {
    result = await captureAll(
      browser,
      routes,
      {
        baseUrl: args.url,
        devices: args.devices,
        themes: args.themes,
        outDir: resolve(outDir, 'shots'),
        concurrency: args.concurrency,
        timeoutMs: 15000,
        fullPage: args.fullPage,
        ...(args.auth ? { storageState: args.auth } : {}),
      },
      (done, all) => {
        if (!color) return;
        const width = 28;
        const filled = Math.round((done / all) * width);
        process.stdout.write(
          `\r  ${paint('▬'.repeat(filled) + '·'.repeat(width - filled), GREEN)} ${done}/${all}`,
        );
      },
    );
    if (color) process.stdout.write('\r'.padEnd(50) + '\r');

    // 4. Stitch.
    const elapsedMs = Date.now() - started;
    const sheet = resolve(outDir, 'everypage.png');
    // Aim for a landscape sheet you can actually take in at a glance:
    // widen it as tiles multiply so the result stays near 16:10.
    const tileHeight = 200;
    const widestTile = Math.max(
      ...result.shots.map((s) => Math.round(tileHeight * (s.device.width / s.device.height))),
      200,
    );
    const sheetWidth = args.columns
      ? Math.round(args.columns * (widestTile + 20) + 80)
      : chooseSheetWidth(result.shots, tileHeight);
    await renderSheet(browser, result.shots, {
      title: new URL(args.url).host,
      outDir: resolve(outDir, 'shots'),
      outFile: sheet,
      tileHeight,
      sheetWidth,
      elapsedMs,
    });

    // 5. Report.
    const captured = result.shots.filter((s) => s.file).length;
    const seconds = (elapsedMs / 1000).toFixed(1);
    process.stdout.write(
      `  ${paint('✓', GREEN)} ${paint(String(captured), BOLD)} screens in ${paint(`${seconds}s`, BOLD)} → ${paint(sheet.replace(`${process.cwd()}/`, ''), BOLD)}\n`,
    );
    if (result.authWalled.length > 0) {
      const list = result.authWalled.slice(0, 3).join(', ');
      const more = result.authWalled.length > 3 ? ` +${result.authWalled.length - 3} more` : '';
      process.stdout.write(
        `  ${paint(`${result.authWalled.length} pages redirected to a login (${list}${more})`, DIM)}\n` +
          `  ${paint('re-run with --auth <storageState.json> to shoot them as you', DIM)}\n`,
      );
    }
    process.stdout.write(`  ${paint('drag it into Claude or Cursor →', DIM)} ${paint('"make these consistent"', DIM)}\n\n`);

    if (args.open && process.platform === 'darwin') {
      const { spawn } = await import('node:child_process');
      spawn('open', [sheet], { detached: true, stdio: 'ignore' }).unref();
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|browserType.launch/.test(message)) {
    fail('Chromium is missing. Install it once with:\n\n    npx playwright install chromium\n');
  }
  fail(message);
});
