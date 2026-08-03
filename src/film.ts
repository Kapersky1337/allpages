import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Shot } from './types.ts';

/**
 * A flythrough of the whole site as one animated SVG: every page glides
 * past like a camera dolly, holds long enough to read, and loops without
 * a visible seam. Made for launch videos and READMEs.
 *
 * Why SVG and not video? A video needs ffmpeg or a React renderer, and
 * allpages has one dependency on purpose. An SVG with CSS keyframes plays
 * in every browser, animates inside a GitHub README, weighs what its
 * screenshots weigh, and screen-records into an mp4 whenever one is
 * needed. The whole animation is data plus a style block.
 */

export interface FilmOptions {
  /** Shown top-left, usually the host. */
  title: string;
  /** Directory the screenshots were written to. */
  outDir: string;
  /** How long each page stays still, in ms. */
  holdMs?: number;
  /** How long the glide between pages takes, in ms. */
  slideMs?: number;
  /** Background color, for filming on brand. */
  bg?: string;
  /** Accent color for the progress bar and the credit line. */
  accent?: string;
  /** Canvas size. 16:9 by default so it drops straight into a video. */
  width?: number;
  height?: number;
}

/** One frame of the film: a captured page and where its pixels live. */
interface Frame {
  path: string;
  dataUri: string;
  aspect: number; // width / height of the screenshot
  mobile: boolean;
}

/**
 * Pacing, in one place so the CLI's "a 20s loop" claim and the SVG's actual
 * timeline can never disagree. The floors exist because a zero-length hold
 * strobes and a zero-length slide teleports.
 */
export const PACING = {
  holdMs: 1600,
  slideMs: 650,
  minHoldMs: 400,
  minSlideMs: 150,
} as const;

/** The pacing a film will actually use, floors applied. */
export function effectivePacing(holdMs?: number, slideMs?: number): { holdMs: number; slideMs: number } {
  return {
    holdMs: Math.max(PACING.minHoldMs, holdMs ?? PACING.holdMs),
    slideMs: Math.max(PACING.minSlideMs, slideMs ?? PACING.slideMs),
  };
}

const TEXT = '#e8e8ea';
const DIM_TEXT = '#77777d';
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Percent with enough precision that a 60s loop still lands on frames. */
const pct = (n: number): string => `${(n * 100).toFixed(3)}%`;

/**
 * The camera's keyframes: sit on page i, then glide to page i+1. The last
 * glide lands on a duplicate of the first page, so the loop's restart is
 * invisible; that's the oldest carousel trick there is, and it still works.
 */
export function cameraKeyframes(
  count: number,
  step: number,
  holdMs: number,
  slideMs: number,
): { css: string; totalMs: number } {
  const per = holdMs + slideMs;
  const totalMs = count * per;
  const lines: string[] = [`0% { transform: translateX(0px); }`];
  for (let i = 0; i < count; i++) {
    const holdEnd = (i * per + holdMs) / totalMs;
    const slideEnd = ((i + 1) * per) / totalMs;
    lines.push(
      `${pct(holdEnd)} { transform: translateX(${-i * step}px); animation-timing-function: ${EASE}; }`,
      `${pct(slideEnd)} { transform: translateX(${-(i + 1) * step}px); }`,
    );
  }
  return { css: `@keyframes cam {\n      ${lines.join('\n      ')}\n    }`, totalMs };
}

/** Build the animated SVG from one captured shot per route. */
export function buildFilmSvg(shots: Shot[], opts: FilmOptions): string {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const { holdMs, slideMs } = effectivePacing(opts.holdMs, opts.slideMs);
  const bg = escapeXml(opts.bg ?? '#0b0b0d');
  const accent = escapeXml(opts.accent ?? '#34d399');

  const frames: Frame[] = [];
  for (const shot of shots) {
    if (!shot.file) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(opts.outDir, shot.file));
    } catch {
      continue;
    }
    frames.push({
      path: shot.route.path,
      dataUri: `data:image/png;base64,${bytes.toString('base64')}`,
      aspect: shot.device.width / shot.device.height,
      mobile: shot.device.mobile,
    });
  }
  if (frames.length === 0) throw new Error('no captured pages to film');

  // The film reads left to right, so page order is route order, home first.
  frames.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

  // Frame geometry: tall enough to read, room above for the title and
  // below for the label and progress line. Phones wear a device body,
  // desktops a browser bar; both are drawn, not photographed, so they
  // stay crisp at any scale.
  const mobile = frames[0]!.mobile;
  const frameH = Math.round(height * 0.7);
  const frameW = Math.round(frameH * frames[0]!.aspect);
  const bezel = mobile ? Math.max(8, Math.round(frameW * 0.035)) : 0;
  const barH = mobile ? 0 : Math.max(20, Math.round(frameH * 0.05));
  const gap = Math.round(frameW * 0.18) + bezel * 2;
  const step = frameW + gap;
  const frameX = Math.round((width - frameW) / 2);
  const frameY = Math.round(height * 0.14);
  const radius = mobile ? Math.max(14, Math.round(frameW * 0.09)) : 10;
  const screenR = mobile ? Math.max(8, radius - Math.round(bezel * 0.6)) : 8;

  const { css: camCss, totalMs } = cameraKeyframes(frames.length, step, holdMs, slideMs);

  // One extra copy of the first page sits after the last, so the final
  // glide arrives "home" exactly as the loop restarts.
  const sequence = [...frames, frames[0]!];
  const tiles = sequence
    .map((frame, i) => {
      const x = frameX + i * step;
      const chrome = frame.mobile
        ? // A phone body: one rounded slab behind the screen.
          `      <rect x="${x - bezel}" y="${frameY - bezel}" width="${frameW + bezel * 2}" height="${frameH + bezel * 2}" rx="${radius}" fill="#141416" stroke="rgba(255,255,255,0.17)" stroke-width="1" filter="url(#lift)"/>\n`
        : // A browser window: a bar with three dots over the page.
          `      <rect x="${x - 1}" y="${frameY - barH}" width="${frameW + 2}" height="${frameH + barH + 1}" rx="10" fill="#141416" stroke="rgba(255,255,255,0.17)" stroke-width="1" filter="url(#lift)"/>\n` +
          `      <circle cx="${x + 16}" cy="${frameY - barH / 2}" r="3.5" fill="#3d3d42"/>\n` +
          `      <circle cx="${x + 30}" cy="${frameY - barH / 2}" r="3.5" fill="#3d3d42"/>\n` +
          `      <circle cx="${x + 44}" cy="${frameY - barH / 2}" r="3.5" fill="#3d3d42"/>\n`;
      const labelY = frameY + frameH + Math.max(bezel, 8) + 30;
      return (
        `    <g>\n` +
        chrome +
        `      <image href="${frame.dataUri}" x="${x}" y="${frameY}" width="${frameW}" height="${frameH}" clip-path="url(#frame-${i})" preserveAspectRatio="xMidYMin slice"/>\n` +
        `      <text x="${x + frameW / 2}" y="${labelY}" text-anchor="middle" class="route">${escapeXml(frame.path)}</text>\n` +
        `    </g>`
      );
    })
    .join('\n');

  const clips = sequence
    .map((_, i) => {
      const x = frameX + i * step;
      return `    <clipPath id="frame-${i}"><rect x="${x}" y="${frameY}" width="${frameW}" height="${frameH}" rx="${screenR}"/></clipPath>`;
    })
    .join('\n');

  const barY = height - 26;
  const barW = Math.round(width * 0.28);
  const barX = Math.round((width - barW) / 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', sans-serif">
  <style>
    ${camCss}
    @keyframes bar {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }
    .cam { animation: cam ${totalMs}ms linear infinite; will-change: transform; }
    .bar { animation: bar ${totalMs}ms linear infinite; transform-origin: ${barX}px ${barY}px; }
    .route { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 15px; fill: ${DIM_TEXT}; }
  </style>
  <rect width="${width}" height="${height}" fill="${bg}"/>
  <defs>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    <linearGradient id="fade-l" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${bg}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${bg}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fade-r" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="${bg}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${bg}" stop-opacity="0"/>
    </linearGradient>
${clips}
  </defs>
  <g class="cam">
${tiles}
  </g>
  <rect x="0" y="0" width="${Math.round((width - frameW) / 2 - gap / 3)}" height="${height}" fill="url(#fade-l)"/>
  <rect x="${width - Math.round((width - frameW) / 2 - gap / 3)}" y="0" width="${Math.round((width - frameW) / 2 - gap / 3)}" height="${height}" fill="url(#fade-r)"/>
  <text x="40" y="52" font-size="22" font-weight="700" fill="${TEXT}">${escapeXml(opts.title)}</text>
  <text x="40" y="76" font-size="14" fill="${DIM_TEXT}">${frames.length} page${frames.length === 1 ? '' : 's'}</text>
  <text x="${width - 40}" y="${height - 40}" text-anchor="end" font-size="14" fill="${DIM_TEXT}">made with <tspan fill="${accent}">npx allpages</tspan></text>
  <rect x="${barX}" y="${barY}" width="${barW}" height="2" rx="1" fill="rgba(255,255,255,0.10)"/>
  <rect x="${barX}" y="${barY}" width="${barW}" height="2" rx="1" fill="${accent}" class="bar"/>
</svg>
`;
}
