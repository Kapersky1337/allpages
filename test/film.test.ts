import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFilmSvg, cameraKeyframes } from '../src/film.ts';
import { DEVICES, type Shot } from '../src/types.ts';

// A 1x1 transparent PNG; the film only needs bytes it can base64.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function fakeShots(dir: string, paths: string[]): Shot[] {
  return paths.map((path, i) => {
    const file = `page-${i}.png`;
    writeFileSync(join(dir, file), PNG);
    return { route: { path, source: 'crawl' as const }, device: DEVICES.phone!, theme: 'light' as const, file };
  });
}

test('the film is one self-contained SVG that loops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allpages-film-'));
  try {
    const svg = buildFilmSvg(fakeShots(dir, ['/', '/pricing', '/blog']), { title: 'acme.com', outDir: dir });

    assert.ok(svg.startsWith('<svg '), 'must be a plain SVG document');
    assert.match(svg, /@keyframes cam/, 'the camera animation is CSS, not a runtime');
    assert.match(svg, /infinite/, 'it loops');
    assert.match(svg, /data:image\/png;base64,/, 'screenshots ride inside the file');
    assert.ok(!/https?:\/\//.test(svg.replace(/xmlns="[^"]+"/, '')), 'nothing external to fetch');

    // Three pages plus the duplicate of the first, for the seamless loop.
    assert.equal((svg.match(/<image /g) ?? []).length, 4);
    // Every route is labeled, and the first appears twice (real + duplicate).
    assert.equal((svg.match(/\/pricing/g) ?? []).length, 1);
    assert.equal((svg.match(/>\/</g) ?? []).length, 2);
    assert.match(svg, /npx allpages/, 'the film says what made it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pages appear in route order, home first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allpages-film-'));
  try {
    const svg = buildFilmSvg(fakeShots(dir, ['/pricing', '/', '/about']), { title: 'x', outDir: dir });
    const home = svg.indexOf('>/<');
    const about = svg.indexOf('/about');
    const pricing = svg.indexOf('/pricing');
    assert.ok(home < about && about < pricing, 'a flythrough that starts mid-site reads as a glitch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the camera timeline starts at rest, ends one page past the last, and stays monotonic', () => {
  const { css, totalMs } = cameraKeyframes(3, 500, 1600, 650);
  assert.equal(totalMs, 3 * 2250);
  assert.match(css, /0% \{ transform: translateX\(0px\); \}/);
  // The final keyframe lands on the duplicated first page.
  assert.match(css, /100\.000% \{ transform: translateX\(-1500px\); \}/);

  // Percentages must never go backwards; a reversed keyframe silently
  // breaks the whole animation in some renderers.
  const percents = [...css.matchAll(/([\d.]+)% \{/g)].map((m) => Number(m[1]));
  for (let i = 1; i < percents.length; i++) {
    assert.ok(percents[i]! >= percents[i - 1]!, `keyframes out of order at ${percents[i]}%`);
  }
});

test('a film with no captured pages refuses instead of writing an empty box', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allpages-film-'));
  try {
    const missing: Shot[] = [
      { route: { path: '/', source: 'crawl' }, device: DEVICES.phone!, theme: 'light', skipped: 'timed out' },
    ];
    assert.throws(() => buildFilmSvg(missing, { title: 'x', outDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pacing and colors are options, with floors that keep the film watchable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allpages-film-'));
  try {
    const svg = buildFilmSvg(fakeShots(dir, ['/', '/a']), {
      title: 'x',
      outDir: dir,
      holdMs: 900,
      slideMs: 400,
      bg: '#101014',
      accent: '#f472b6',
    });
    assert.match(svg, /animation: cam 2600ms/, 'loop length follows the pacing options');
    assert.match(svg, /fill="#101014"/);
    assert.match(svg, /fill="#f472b6"/);

    // A zero-length hold would strobe; the floor holds.
    const floored = buildFilmSvg(fakeShots(dir, ['/', '/a']), { title: 'x', outDir: dir, holdMs: 0, slideMs: 0 });
    assert.match(floored, /animation: cam 1100ms/);

    // A color with a quote in it must not be able to break out of the markup.
    const hostile = buildFilmSvg(fakeShots(dir, ['/']), { title: 'x', outDir: dir, bg: '"/><script>' });
    assert.ok(!hostile.includes('<script>'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phones wear a device body, desktops a browser bar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allpages-film-'));
  try {
    const phone = buildFilmSvg(fakeShots(dir, ['/']), { title: 'x', outDir: dir });
    assert.ok(!phone.includes('<circle'), 'a phone has no window dots');

    const desktopShots = fakeShots(dir, ['/']).map((s) => ({ ...s, device: DEVICES.desktop! }));
    const desktop = buildFilmSvg(desktopShots, { title: 'x', outDir: dir });
    assert.equal((desktop.match(/<circle/g) ?? []).length, 6, 'three dots per window, two windows (page + loop copy)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
