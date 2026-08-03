import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import type { Shot } from './types.ts';

export interface SheetOptions {
  title: string;
  outDir: string;
  outFile: string;
  /**
   * Tiles share a HEIGHT and vary in width by aspect ratio, the way a
   * photographic contact sheet works. Uniform widths would make a column
   * of phone shots five times taller than the desktop ones and turn the
   * sheet into a skyscraper nobody can look at.
   */
  tileHeight: number;
  /** Target width of the finished image in CSS px. */
  sheetWidth: number;
  elapsedMs: number;
}

const GAP = 20;
const CAPTION = 46;
const PADDING = 80;
const CHROME = 150; // header + footer + section headings

/**
 * Pick a sheet width that lands closest to a landscape shape. Tile widths
 * differ per device, so the only honest way to know how tall the result
 * will be is to lay it out, cheaply, for each candidate width.
 */
export function chooseSheetWidth(shots: Shot[], tileHeight: number, targetRatio = 1.5): number {
  const captured = shots.filter((s) => s.file);
  if (captured.length === 0) return 1280;

  const byDevice = new Map<string, { width: number; count: number }>();
  for (const shot of captured) {
    const width = Math.round(tileHeight * (shot.device.width / shot.device.height));
    const entry = byDevice.get(shot.device.name) ?? { width, count: 0 };
    entry.count++;
    byDevice.set(shot.device.name, entry);
  }

  const widestTile = Math.max(...[...byDevice.values()].map((d) => d.width));
  // Never buy more width than there is anything to put in it. Chasing the
  // target ratio alone gives a four-column sheet to a site with one page,
  // and three quarters of that image is empty.
  const fullestSection = Math.max(...[...byDevice.values()].map((d) => d.count));
  const maxColumns = Math.min(10, Math.max(1, fullestSection));

  let best = { width: widestTile + GAP + PADDING, distance: Infinity };
  for (let columns = 1; columns <= maxColumns; columns++) {
    const width = columns * (widestTile + GAP) + PADDING;
    const content = width - PADDING;
    let height = CHROME;
    for (const device of byDevice.values()) {
      const perRow = Math.max(1, Math.floor(content / (device.width + GAP)));
      height += Math.ceil(device.count / perRow) * (tileHeight + CAPTION + GAP) + 40;
    }
    const distance = Math.abs(width / height - targetRatio);
    if (distance < best.distance) best = { width, distance };
  }
  return best.width;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dataUri(outDir: string, file: string): string | null {
  try {
    const bytes = readFileSync(join(outDir, file));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

/** The contact sheet is an HTML page we screenshot. No image toolchain. */
export function buildHtml(shots: Shot[], opts: SheetOptions): string {
  const captured = shots.filter((s) => s.file).length;
  const routeCount = new Set(shots.map((s) => s.route.path)).size;
  const seconds = (opts.elapsedMs / 1000).toFixed(1);

  // Group by device so every tile in a block shares a width. Mixing a
  // narrow phone tile with a wide desktop one makes ragged, unreadable rows.
  const shot_ = shots.filter((s) => s.file);
  const deviceOrder = [...new Set(shot_.map((s) => s.device.name))];
  const sections = deviceOrder
    .map((deviceName) => {
      const inDevice = shot_
        .filter((s) => s.device.name === deviceName)
        // Light before dark: it reads as the default state, then the variant.
        .sort(
          (a, b) =>
            a.route.path.localeCompare(b.route.path, undefined, { numeric: true }) ||
            (a.theme === b.theme ? 0 : a.theme === 'light' ? -1 : 1),
        );
      if (inDevice.length === 0) return '';
      const device = inDevice[0]!.device;
      const width = Math.round(opts.tileHeight * (device.width / device.height));
      // Balance the rows. Packing greedily leaves a single orphan tile next
      // to a wall of empty space (23 phones → 22 + 1), which reads as broken.
      const perRow = Math.max(1, Math.floor((opts.sheetWidth - PADDING) / (width + GAP)));
      const rows = Math.max(1, Math.ceil(inDevice.length / perRow));
      const columns = Math.ceil(inDevice.length / rows);

      const cells = inDevice
        .map((shot) => {
          const stands = shot.route.standsFor;
          // A tile that stands for a family says so: the pattern is the
          // headline, the page actually shot is the fine print.
          const label = stands ? stands.pattern : shot.route.path;
          const sub = stands
            ? `one of ${stands.count.toLocaleString()} · ${shot.route.path}`
            : shot.theme;
          const uri = dataUri(opts.outDir, shot.file!);
          const media = uri
            ? `<img src="${uri}" alt="${escapeHtml(label)}">`
            : `<div class="missing"><span>image missing</span></div>`;
          return `<figure class="cell">
  <div class="frame">${media}</div>
  <figcaption><span class="path">${escapeHtml(label)}</span><span class="variant">${escapeHtml(sub)}</span></figcaption>
</figure>`;
        })
        .join('\n');

      return `<section>
  <h2>${escapeHtml(device.name)} <span>${device.width}×${device.height}</span></h2>
  <div class="grid" style="--w:${width}px; grid-template-columns: repeat(${columns}, ${width}px)">
${cells}
  </div>
</section>`;
    })
    .join('\n');

  // Everything that has no picture collapses into one honest line per
  // route, instead of eating a quarter of the sheet as empty tiles.
  const missingByRoute = new Map<string, string>();
  for (const shot of shots) {
    if (!shot.file && shot.skipped) missingByRoute.set(shot.route.path, shot.skipped);
  }
  const missingBlock =
    missingByRoute.size === 0
      ? ''
      : `<section class="skipped">
  <h2>not captured <span>${missingByRoute.size} route${missingByRoute.size === 1 ? '' : 's'}</span></h2>
  <ul>${[...missingByRoute.entries()]
    .map(([path, why]) => `<li><code>${escapeHtml(path)}</code><span>${escapeHtml(why)}</span></li>`)
    .join('')}</ul>
</section>`;
  const cells = `${sections}\n${missingBlock}`;

  return `<!doctype html>
<meta charset="utf-8">
<style>
  :root {
    --bg: #0b0b0d;
    --panel: #131318;
    --line: #23232b;
    --text: #f2f2f4;
    --muted: #8b8b96;
    --accent: #6ee7a8;
    --h: ${opts.tileHeight}px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 400 14px/1.45 ui-sans-serif, -apple-system, "SF Pro Text", Inter, system-ui, sans-serif;
    padding: 40px;
    width: ${opts.sheetWidth}px;
    -webkit-font-smoothing: antialiased;
  }
  header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 28px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.015em; }
  .stats { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .stats b { color: var(--text); font-weight: 600; }
  section { margin-bottom: 40px; }
  h2 {
    font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .09em;
    color: var(--muted); margin-bottom: 16px; display: flex; gap: 10px; align-items: baseline;
  }
  h2 span { font-weight: 400; letter-spacing: .02em; text-transform: none; opacity: .65; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, var(--w));
    justify-content: start;
    gap: 26px 20px;
  }
  .cell { display: flex; flex-direction: column; gap: 9px; width: var(--w); }
  .skipped ul { list-style: none; display: flex; flex-wrap: wrap; gap: 8px 10px; }
  .skipped li {
    display: flex; align-items: baseline; gap: 8px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 7px;
    padding: 7px 12px;
  }
  .skipped code { font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .skipped li span { color: var(--muted); font-size: 11px; }
  .frame {
    width: 100%;
    height: var(--h);
    border-radius: 10px;
    overflow: hidden;
    background: var(--panel);
    border: 1px solid var(--line);
    box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.28);
  }
  .frame img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
  .is-missing .frame {
    border-style: dashed;
    box-shadow: none;
    background: repeating-linear-gradient(45deg, #101014, #101014 8px, #0d0d11 8px, #0d0d11 16px);
  }
  .missing {
    height: 100%; display: grid; place-items: center; padding: 16px; text-align: center;
  }
  .missing span { color: var(--muted); font-size: 12px; line-height: 1.4; }
  figcaption { display: flex; flex-direction: column; gap: 2px; padding-left: 2px; }
  .path {
    font: 500 13px/1.3 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    letter-spacing: -0.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .variant { color: var(--muted); font-size: 11px; letter-spacing: .01em; }
  footer { margin-top: 36px; color: var(--muted); font-size: 12px; letter-spacing: .01em; }
  footer b { color: var(--accent); font-weight: 500; }
</style>
<body>
  <header>
    <h1>${escapeHtml(opts.title)}</h1>
    <div class="stats"><b>${routeCount}</b> route${routeCount === 1 ? '' : 's'} · <b>${captured}</b> screen${captured === 1 ? '' : 's'} · <b>${seconds}s</b></div>
  </header>
${cells}
  <footer>made with <b>npx allpages</b></footer>
</body>`;
}

/** Render the sheet HTML and screenshot it into one PNG. */
export async function renderSheet(browser: Browser, shots: Shot[], opts: SheetOptions): Promise<string> {
  const html = buildHtml(shots, opts);
  const context = await browser.newContext({
    viewport: { width: opts.sheetWidth, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  const body = page.locator('body');
  await body.screenshot({ path: opts.outFile, scale: 'device' });
  await context.close();
  return opts.outFile;
}
