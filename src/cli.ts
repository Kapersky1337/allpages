#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { captureAll } from './capture.ts';
import { crawlWithBrowser } from './crawl.ts';
import { exportFigma } from './figma.ts';
import { buildFilmSvg } from './film.ts';
import { httpHeaders } from './identity.ts';
import { outDirFor, selectRoutes } from './api.ts';
import {
  mergeRoutes,
  normalizePath,
  routesFromCrawl,
  routesFromDisk,
  routesFromSitemap,
} from './discover.ts';
import { chooseSheetWidth, renderSheet } from './sheet.ts';
import { DEVICES, type Device, type Route, type Theme } from './types.ts';

/**
 * How many pages discovery will look at. Deliberately far above --max:
 * finding a URL is a cheap HTML fetch, and seeing the whole site is what
 * makes layout grouping accurate. Only screenshots are expensive.
 */
const DISCOVERY_CAP = 500;

const HELP = `allpages: every page of your app, as one image

  npx allpages http://localhost:3000
  npx allpages https://yoursite.com
  npx allpages figma https://yoursite.com    → editable SVG for Figma
  npx allpages film https://yoursite.com     → animated flythrough (SVG)

Finds every page a site has, shoots each one on phone, tablet and
desktop in light and dark, and stitches them into one contact sheet you
can look at, or drag into Claude or Cursor instead of making it take 47
screenshots one at a time.

Works on a local dev server or any public website. Cookie banners are
dismissed, lazy images are loaded, and client-rendered links are found
by crawling in a real browser.

Options
  --devices phone,desktop     which sizes (default: all three)
  --themes light,dark         which color schemes
  --auth <state.json>         Playwright storageState, so private pages
                              shoot as the logged-in you
  --routes /a,/b              shoot exactly these, skip discovery
  --project <dir>             where your app's code lives (default: cwd)
  --out <dir>                 output directory (default: allpages/<site>)
  --max <n>                   cap pages shot (default: 20)
  --all                       shoot every page, not one per layout
  --only <glob,glob>          only pages matching these (e.g. '/blog/*')
  --exclude <glob,glob>       skip pages matching these
  --no-group                  don't collapse pages that share a layout
  --full-page                 capture whole scroll height into shots/
  --columns <n>               tiles per row on the sheet
  --concurrency <n>           parallel browser contexts (default: cpu count)
  --timeout <seconds>         per-page load budget (default: 15)
  --hide <sel,sel>            CSS selectors to hide (chat widgets, banners)
  --wait <selector>           wait for this element before shooting
  --delay <ms>                extra settle time per page
  --depth <n>                 how many link levels to follow (default: 2)
  --no-lazy                   skip the scroll that loads lazy images
  --no-banners                don't try to dismiss cookie dialogs
  --no-robots                 crawl paths robots.txt disallows
  --user-agent <ua>           override the browser user agent
  --insecure                  accept self-signed certs (local https)
  --svg                       (figma) write SVG only, skip the sheet
  --force                     write into a directory that has other files
  --no-open                   don't open the sheet when done
  -h, --help                  this help

The sheet is honest: pages that redirected to a login, timed out, or are
dynamic routes with no example URL appear as labeled empty tiles rather
than being quietly dropped.`;

interface Args {
  command: 'sheet' | 'figma' | 'film';
  devicesExplicit: boolean;
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
  force: boolean;
  insecure: boolean;
  timeoutMs: number;
  all: boolean;
  only: string[];
  exclude: string[];
  group: boolean;
  hide: string[];
  waitFor?: string;
  delayMs: number;
  depth: number;
  lazyLoad: boolean;
  dismissBanners: boolean;
  respectRobots: boolean;
  userAgent?: string;
}

/** Everything any allpages command can put in an output directory. */
const ALL_OUTPUTS = ['allpages.png', 'shots', 'routes.txt', 'allpages.svg', 'pages', 'film.svg'];

/**
 * Clear what this command is about to write, and refuse a directory holding
 * files allpages did not put there. `--out .` must never be read as "delete
 * my project". The two commands share a directory on purpose: running the
 * sheet and then the Figma export for the same site should leave you with
 * both, not with an error.
 */
function prepareOutDir(outDir: string, force: boolean, writes: string[]): void {
  if (existsSync(outDir)) {
    const stray = readdirSync(outDir).filter((e) => !ALL_OUTPUTS.includes(e));
    if (stray.length > 0 && !force) {
      fail(
        `${outDir} already has files in it that allpages didn't write (${stray.slice(0, 3).join(', ')}${stray.length > 3 ? ', …' : ''}).\n` +
          `  Pick an empty --out, or pass --force to write here anyway.`,
      );
    }
  }
  for (const entry of writes) {
    rmSync(resolve(outDir, entry), { recursive: true, force: true });
  }
}

function fail(message: string): never {
  process.stderr.write(`allpages: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'sheet',
    devicesExplicit: false,
    url: '',
    // All three sizes by default. A layout breaks at the size nobody
    // remembered to open, and tablet is almost always that size.
    devices: [DEVICES.phone!, DEVICES.tablet!, DEVICES.desktop!],
    themes: ['light', 'dark'],
    project: process.cwd(),
    // Filled in from the URL once it's parsed, unless --out overrides it.
    out: '',
    // 20 routes × 4 variants = 80 tiles, which still downscales to
    // something a person (or a vision model) can actually read.
    max: 20,
    fullPage: false,
    // Browser contexts are cheap and the work is almost all waiting on the
    // page. Measured on the demo app: 6 → 8.0s, 12 → 4.8s, 16 → 3.8s.
    concurrency: Math.min(16, Math.max(4, cpus().length)),
    open: true,
    force: false,
    insecure: false,
    timeoutMs: 15000,
    all: false,
    only: [],
    exclude: [],
    group: true,
    hide: [],
    delayMs: 0,
    depth: 2,
    lazyLoad: true,
    dismissBanners: true,
    respectRobots: true,
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
        process.stdout.write(`${version()}\n`);
        process.exit(0);
        break;
      case '--devices': {
        args.devicesExplicit = true;
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
        args.max = Math.max(1, Math.floor(Number(need(i, '--max'))) || 20);
        i++;
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
      case '--force':
        args.force = true;
        break;
      case '--insecure':
        args.insecure = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--no-group':
        args.group = false;
        break;
      case '--only':
        args.only = need(i, '--only').split(',').map((x) => x.trim()).filter(Boolean);
        i++;
        break;
      case '--exclude':
        args.exclude = need(i, '--exclude').split(',').map((x) => x.trim()).filter(Boolean);
        i++;
        break;
      case '--hide':
        args.hide = need(i, '--hide').split(',').map((x) => x.trim()).filter(Boolean);
        i++;
        break;
      case '--wait':
        args.waitFor = need(i, '--wait');
        i++;
        break;
      case '--delay':
        args.delayMs = Math.max(0, Math.floor(Number(need(i, '--delay'))) || 0);
        i++;
        break;
      case '--depth':
        args.depth = Math.max(1, Math.floor(Number(need(i, '--depth'))) || 2);
        i++;
        break;
      case '--user-agent':
        args.userAgent = need(i, '--user-agent');
        i++;
        break;
      case '--no-lazy':
        args.lazyLoad = false;
        break;
      case '--no-banners':
        args.dismissBanners = false;
        break;
      case '--no-robots':
        args.respectRobots = false;
        break;
      case '--timeout':
        args.timeoutMs = Math.max(1000, (Math.floor(Number(need(i, '--timeout'))) || 15) * 1000);
        i++;
        break;
      case 'figma':
      case 'film':
        // Subcommands, but only in the first position; a site could
        // legitimately have a page called /figma or /film.
        if (i === 0) args.command = arg;
        else args.url = arg;
        break;
      default:
        if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
        args.url = arg;
    }
  }
  if (!args.url) fail('give me a URL: npx allpages http://localhost:3000');
  if (!/^https?:\/\//.test(args.url)) args.url = `http://${args.url}`;
  try {
    new URL(args.url);
  } catch {
    fail(`not a URL: ${args.url}`);
  }
  // Each site gets its own folder, so trying four sites in a row gives you
  // four sheets to compare rather than one that keeps getting overwritten.
  if (!args.out) args.out = outDirFor(args.url);
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

function version(): string {
  try {
    const pkg = new URL('../package.json', import.meta.url);
    return JSON.parse(readFileSync(pkg, 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const color = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (s: string, c: string): string => (color ? `${c}${s}${RESET}` : s);

/**
 * Find a browser to drive, and if there is none, fetch one.
 *
 * playwright-core deliberately ships no browsers, so a bare `npx allpages`
 * on a clean machine would otherwise end in "now run this other command".
 * The order is cheapest-first: a Playwright Chromium if it is already
 * there, then the Chrome or Edge nearly every machine already has, and
 * only then a one-time download. The install is loud, because spending
 * 100MB of somebody's bandwidth silently is not acceptable.
 */
async function launchBrowser(): Promise<Browser> {
  const launchArgs = ['--force-color-profile=srgb', '--hide-scrollbars'];
  const attempts: { channel?: string; label: string }[] = [
    { label: "Playwright's Chromium" },
    { channel: 'chrome', label: 'Google Chrome' },
    { channel: 'msedge', label: 'Microsoft Edge' },
  ];

  const problems: string[] = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch({
        args: launchArgs,
        ...(attempt.channel ? { channel: attempt.channel } : {}),
      });
    } catch (error) {
      problems.push(`${attempt.label}: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : 'failed'}`);
    }
  }

  // Nothing on the machine, so fetch Chromium once, then retry.
  if (await installChromium()) {
    try {
      return await chromium.launch({ args: launchArgs });
    } catch (error) {
      problems.push(`after install: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : 'failed'}`);
    }
  }

  fail(
    `couldn't start a browser, and couldn't install one.\n\n` +
      `  Install it manually with:  npx playwright install chromium\n\n` +
      `  tried: ${problems.join(' · ')}`,
  );
}

/** Download Chromium via the Playwright CLI. Returns whether it succeeded. */
async function installChromium(): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const version = playwrightVersion();
  process.stdout.write(
    `  ${paint('no browser found, downloading Chromium once (~120 MB)', BOLD)}\n` +
      `  ${paint('this happens on first run only', DIM)}\n\n`,
  );
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['--yes', version ? `playwright@${version}` : 'playwright', 'install', 'chromium'],
      { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' },
    );
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      process.stdout.write('\n');
      resolve(code === 0);
    });
  });
}

/** Match the installer to the playwright-core we ship against. */
function playwrightVersion(): string | null {
  try {
    const url = new URL('../node_modules/playwright-core/package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  process.stdout.write(`\n  ${paint('allpages', BOLD)} ${paint(args.url, DIM)}\n\n`);

  // 1. Reachability: a clear message beats a wall of browser errors, and
  // a TLS complaint must not be reported as "server not running".
  if (args.insecure) process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  try {
    await fetch(args.url, { signal: AbortSignal.timeout(5000), headers: httpHeaders() });
  } catch (error) {
    const message = error instanceof Error ? String(error.cause ?? error.message) : '';
    if (/certificate|SELF_SIGNED|DEPTH_ZERO|ERR_TLS/i.test(message)) {
      fail(`${args.url} has a certificate this doesn't trust (self-signed?). Re-run with --insecure`);
    }
    fail(`can't reach ${args.url}. Is your dev server running?`);
  }

  // The browser is needed for capture regardless, and discovery may want
  // it too, so start it once here.
  const browser = await launchBrowser();

  // 2. Discover routes.
  let routes: Route[];
  if (args.routes) {
    routes = args.routes.map((path) => ({ path, source: 'given' as const }) satisfies Route);
  } else {
    // All sources always run and merge. A sitemap listing only the
    // marketing pages must not hide the rest of the app.
    const fromDisk = routesFromDisk(args.project);
    const [sitemap, quickCrawl] = await Promise.all([
      routesFromSitemap(args.url, 4000),
      routesFromCrawl(args.url, { maxPages: DISCOVERY_CAP, depth: args.depth, timeoutMs: 6000 }),
    ]);

    // The cheap crawl reads raw HTML, which is empty on a client-rendered
    // app: React writes the links after it boots. When the fast path finds
    // almost nothing, crawl again in a real browser where the links exist.
    let browserCrawled: typeof quickCrawl = [];
    let blockedByRobots = 0;
    const needsJs = quickCrawl.length <= 1 && sitemap.length === 0 && fromDisk.length === 0;
    if (needsJs) {
      process.stdout.write(`  ${paint('no links in the HTML, looking again in a browser…', DIM)}\n`);
      const result = await crawlWithBrowser(browser, args.url, {
        maxPages: DISCOVERY_CAP,
        depth: args.depth,
        timeoutMs: args.timeoutMs,
        respectRobots: args.respectRobots,
        insecure: args.insecure,
        ...(args.userAgent ? { userAgent: args.userAgent } : {}),
        ...(args.auth ? { storageState: args.auth } : {}),
      });
      browserCrawled = result.routes;
      blockedByRobots = result.blockedByRobots;
    }

    routes = mergeRoutes(fromDisk, [...sitemap, ...quickCrawl, ...browserCrawled]);
    const how = [
      fromDisk.length > 0 ? `${fromDisk.length} from your route files` : null,
      sitemap.length > 0 ? `${sitemap.length} from sitemap.xml` : null,
      browserCrawled.length > 0
        ? `${browserCrawled.length} by crawling in a browser`
        : quickCrawl.length > 0
          ? `${quickCrawl.length} by crawling links`
          : null,
    ].filter(Boolean);
    if (how.length > 0) process.stdout.write(`  ${paint(`found ${how.join(', ')}`, DIM)}\n`);
    if (blockedByRobots > 0) {
      process.stdout.write(
        `  ${paint(`${blockedByRobots} paths skipped per robots.txt (--no-robots to include them)`, DIM)}\n`,
      );
    }

    // Even a browser crawl finds nothing on an app whose only navigation is
    // a form submit or a button handler. Say so rather than handing over a
    // one-page sheet of a seven-page app.
    if (routes.length <= 1) {
      process.stdout.write(
        `\n  ${paint('only found the page you gave me.', BOLD)}\n` +
          `  ${paint('If navigation happens without <a> links, list the pages yourself:', DIM)}\n` +
          `  ${paint('--routes /,/about,/pricing', DIM)}\n\n`,
      );
    }
  }
  // Selection is shared with the library so the two can never disagree
  // about what a run means: filters, then layout grouping, then the cap.
  const allDiscovered = routes;
  const discoveredCount = routes.length;
  const selection = selectRoutes(routes, {
    max: args.max,
    only: args.only,
    exclude: args.exclude,
    group: args.group && !args.routes,
    all: args.all,
  });
  routes = selection.routes;
  const before = args.only.length > 0 || args.exclude.length > 0 ? selection.considered : discoveredCount;
  if (routes.length === 0) {
    fail(`no pages matched ${args.only.length > 0 ? `--only ${args.only.join(',')}` : '--exclude'}`);
  }

  // Say what actually happened. Reporting "taking the top 20" on a site
  // whose 999 pages collapsed to 63 layouts hides the interesting half of
  // the story, and reporting "one page per layout" when the cap then threw
  // 43 of those layouts away is simply untrue.
  const layouts = selection.layouts;
  if (!args.routes && layouts < before) {
    const summary = `${before.toLocaleString()} pages, ${layouts} layout${layouts === 1 ? '' : 's'}`;
    process.stdout.write(
      routes.length < layouts
        ? `  ${paint(`${summary}, shooting the ${routes.length} biggest (--max ${layouts} for every layout)`, DIM)}\n`
        : `  ${paint(`${summary}, shooting one page from each`, DIM)}\n`,
    );
  } else if (!args.routes && before > routes.length) {
    process.stdout.write(
      `  ${paint(`${before.toLocaleString()} pages to shoot, taking the top ${routes.length} (--max ${before} for all)`, DIM)}\n`,
    );
  }

  if (args.command === 'sheet') {
    const total = routes.length * args.devices.length * args.themes.length;
    process.stdout.write(
      `  ${paint(`${routes.length} routes × ${args.devices.length} sizes × ${args.themes.length} themes = ${total} screens`, DIM)}\n\n`,
    );
  } else if (args.command === 'film') {
    process.stdout.write(
      `  ${paint(`${routes.length} page${routes.length === 1 ? '' : 's'} → one looping flythrough`, DIM)}\n\n`,
    );
  } else {
    process.stdout.write(
      `  ${paint(`${routes.length} page${routes.length === 1 ? '' : 's'} → vector`, DIM)}\n\n`,
    );
  }

  // 3b. Film: same discovery, but the output is one animated SVG that
  // glides through the pages in order. Phone frames unless told otherwise,
  // because a row of phones reads instantly at video sizes.
  if (args.command === 'film') {
    const filmDir = resolve(args.out);
    prepareOutDir(filmDir, args.force, ['film.svg', 'shots']);
    try {
      const device = args.devicesExplicit ? (args.devices[0] ?? DEVICES.phone!) : DEVICES.phone!;
      const theme = args.themes[0] ?? 'light';
      const result = await captureAll(
        browser,
        routes,
        {
          baseUrl: args.url,
          devices: [device],
          themes: [theme],
          outDir: resolve(filmDir, 'shots'),
          concurrency: args.concurrency,
          timeoutMs: args.timeoutMs,
          fullPage: false,
          insecure: args.insecure,
          hide: args.hide,
          delayMs: args.delayMs,
          lazyLoad: args.lazyLoad,
          dismissBanners: args.dismissBanners,
          ...(args.waitFor ? { waitFor: args.waitFor } : {}),
          ...(args.userAgent ? { userAgent: args.userAgent } : {}),
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

      const captured = result.shots.filter((s) => s.file);
      if (captured.length === 0) {
        process.stderr.write(`\n  ${paint('captured nothing', BOLD)}: every page failed to load\n\n`);
        await browser.close().catch(() => {});
        process.exit(1);
      }

      const filmPath = resolve(filmDir, 'film.svg');
      const svg = buildFilmSvg(captured, {
        title: new URL(args.url).host,
        outDir: resolve(filmDir, 'shots'),
      });
      writeFileSync(filmPath, svg);

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const loopSeconds = ((captured.length * 2250) / 1000).toFixed(0);
      process.stdout.write(
        `  ${paint('✓', GREEN)} ${paint(String(captured.length), BOLD)} page${captured.length === 1 ? '' : 's'} → a ${paint(`${loopSeconds}s`, BOLD)} loop in ${paint(`${seconds}s`, BOLD)}\n` +
          `    ${paint(filmPath.replace(`${process.cwd()}/`, ''), BOLD)}  ${paint('plays in any browser, loops without a seam', DIM)}\n` +
          `    ${paint('screen-record it for video, or use the SVG as is in a README', DIM)}\n\n`,
      );
      if (args.open && process.platform === 'darwin') {
        const { spawn } = await import('node:child_process');
        spawn('open', [filmPath], { detached: true, stdio: 'ignore' }).unref();
      }
    } finally {
      await browser.close().catch(() => {});
    }
    return;
  }

  // 3a. Figma export: same discovery, vector output instead of pixels.
  if (args.command === 'figma') {
    const figDir = resolve(args.out);
    prepareOutDir(figDir, args.force, ['allpages.svg', 'pages']);
    try {
      const result = await exportFigma(browser, routes, {
        baseUrl: args.url,
        device: args.devicesExplicit ? (args.devices[0] ?? DEVICES.desktop!) : DEVICES.desktop!,
        theme: args.themes[0] ?? 'light',
        outDir: figDir,
        timeoutMs: args.timeoutMs,
        concurrency: args.concurrency,
        fullPage: args.fullPage,
        gap: 120,
        hide: args.hide,
        delayMs: args.delayMs,
        lazyLoad: args.lazyLoad,
        dismissBanners: args.dismissBanners,
        ...(args.waitFor ? { waitFor: args.waitFor } : {}),
        ...(args.userAgent ? { userAgent: args.userAgent } : {}),
        ...(args.auth ? { storageState: args.auth } : {}),
        insecure: args.insecure,
        onProgress: (done, all) => {
          if (!color) return;
          const width = 28;
          const filled = Math.round((done / all) * width);
          process.stdout.write(
            `\r  ${paint('▬'.repeat(filled) + '·'.repeat(width - filled), GREEN)} ${done}/${all}`,
          );
        },
      });
      if (color) process.stdout.write('\r'.padEnd(50) + '\r');

      const ok = result.pages.filter((p) => !p.skipped);
      if (ok.length === 0) {
        process.stderr.write(`\n  ${paint('captured nothing', BOLD)}: every page failed to load\n\n`);
        await browser.close().catch(() => {});
        process.exit(1);
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(
        `  ${paint('✓', GREEN)} ${paint(String(ok.length), BOLD)} page${ok.length === 1 ? '' : 's'} · ` +
          `${paint(result.totalNodes.toLocaleString(), BOLD)} editable layers in ${paint(`${seconds}s`, BOLD)}\n` +
          `    ${paint(result.file.replace(`${process.cwd()}/`, ''), BOLD)}  ${paint('← drag into Figma', DIM)}\n` +
          `    ${paint(`${args.out}/pages/`, DIM)} ${paint('one SVG per page', DIM)}\n\n`,
      );
      const failed = result.pages.filter((p) => p.skipped);
      if (failed.length > 0) {
        process.stdout.write(
          `  ${paint(`${failed.length} page${failed.length === 1 ? '' : 's'} skipped: ${failed.slice(0, 3).map((p) => p.route).join(', ')}`, DIM)}\n\n`,
        );
      }
    } finally {
      await browser.close().catch(() => {});
    }
    return;
  }

  // 3. Shoot. (browser launched before discovery when a JS crawl is needed)
  const outDir = resolve(args.out);
  const sheetPath = resolve(outDir, 'allpages.png');
  prepareOutDir(outDir, args.force, ['allpages.png', 'shots', 'routes.txt']);
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
        timeoutMs: args.timeoutMs,
        fullPage: args.fullPage,
        insecure: args.insecure,
        hide: args.hide,
        delayMs: args.delayMs,
        lazyLoad: args.lazyLoad,
        dismissBanners: args.dismissBanners,
        ...(args.waitFor ? { waitFor: args.waitFor } : {}),
        ...(args.userAgent ? { userAgent: args.userAgent } : {}),
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

    // Nothing is ever silently dropped: when the sheet shows fewer pages
    // than the site has, every URL still lands in a greppable file.
    if (allDiscovered.length > routes.length) {
      const shot = new Set(routes.map((r) => r.path));
      const lines = [
        `# ${new URL(args.url).host} · ${allDiscovered.length} pages, ${routes.length} shot · ${new Date().toISOString().slice(0, 10)}`,
        '# * = in the sheet',
        '',
        ...allDiscovered.map((r) => `${shot.has(r.path) ? '* ' : '  '}${r.path}`),
      ];
      writeFileSync(resolve(outDir, 'routes.txt'), `${lines.join('\n')}\n`);
    }

    // 4. Stitch.
    const elapsedMs = Date.now() - started;
    const sheet = resolve(outDir, 'allpages.png');
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

    // A green check over an empty sheet is the one place this tool could
    // lie about itself. Zero captures is a failure, and exits like one.
    if (captured === 0) {
      const why = result.shots.find((s) => s.skipped)?.skipped ?? 'every page failed to load';
      // A bot check is not a broken URL, and telling someone to check their
      // URL when the site simply refused a script wastes their afternoon.
      const advice =
        result.botChecked.length > 0
          ? `this site challenges automated browsers. Log in once and reuse the session:\n` +
            `  npx playwright codegen --save-storage=session.json ${args.url}\n` +
            `  npx allpages ${args.url} --auth session.json`
          : 'check the URL, or pass --auth if the app is behind a login';
      process.stderr.write(
        `\n  ${paint('captured nothing', BOLD)}: ${why}\n` + `  ${paint(advice, DIM)}\n\n`,
      );
      await browser.close().catch(() => {});
      process.exit(1);
    }

    process.stdout.write(
      `  ${paint('✓', GREEN)} ${paint(String(captured), BOLD)} screen${captured === 1 ? '' : 's'} in ${paint(`${seconds}s`, BOLD)} → ${paint(sheet.replace(`${process.cwd()}/`, ''), BOLD)}\n`,
    );
    if (result.noDarkMode) {
      process.stdout.write(
        `  ${paint('no dark mode: every dark shot was identical to its light one, so they were dropped', DIM)}\n`,
      );
    }
    if (result.botChecked.length > 0) {
      const list = result.botChecked.slice(0, 3).join(', ');
      const more = result.botChecked.length > 3 ? ` +${result.botChecked.length - 3} more` : '';
      process.stdout.write(
        `  ${paint(`${result.botChecked.length} page${result.botChecked.length === 1 ? '' : 's'} hit a bot check (${list}${more})`, DIM)}\n` +
          `  ${paint('--auth <storageState.json> shoots them with a session you opened yourself', DIM)}\n`,
      );
    }
    if (result.authWalled.length > 0) {
      const list = result.authWalled.slice(0, 3).join(', ');
      const more = result.authWalled.length > 3 ? ` +${result.authWalled.length - 3} more` : '';
      process.stdout.write(
        `  ${paint(`${result.authWalled.length} pages redirected to a login (${list}${more})`, DIM)}\n` +
          `  ${paint('re-run with --auth <storageState.json> to shoot them as you', DIM)}\n`,
      );
    }
    // Choice belongs *after* the picture, when you finally know what your
    // site contains. Print the exact command at the moment it's useful.
    const stood = routes.filter((r) => r.standsFor);
    if (stood.length > 0) {
      const top = [...stood]
        .sort((a, b) => (b.standsFor?.count ?? 0) - (a.standsFor?.count ?? 0))
        .slice(0, 3)
        .map((r) => `${r.standsFor!.pattern} ${r.standsFor!.count.toLocaleString()} pages`)
        .join(' · ');
      const biggest = stood.reduce((a, b) => ((a.standsFor?.count ?? 0) >= (b.standsFor?.count ?? 0) ? a : b));
      const glob = `${biggest.standsFor!.pattern.replace(/\/:[^/]+$/, '')}/*`;
      process.stdout.write(
        `  ${paint(top, DIM)}\n` +
          `  ${paint(`--only '${glob}' to open one up · --all for every page`, DIM)}\n`,
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
