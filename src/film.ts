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
  /** Canvas size. 16:9 by default so it drops straight into a video. */
  width?: number;
  height?: number;
}

/** One frame of the film: a captured page and where its pixels live. */
interface Frame {
  path: string;
  dataUri: string;
  aspect: number; // width / height of the screenshot
}

const BG = '#0b0b0d';
const TEXT = '#e8e8ea';
const DIM_TEXT = '#77777d';
const ACCENT = '#34d399';
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
  const holdMs = opts.holdMs ?? 1600;
  const slideMs = opts.slideMs ?? 650;

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
    });
  }
  if (frames.length === 0) throw new Error('no captured pages to film');

  // The film reads left to right, so page order is route order, home first.
  frames.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

  // Frame geometry: tall enough to read, room above for the title and
  // below for the progress line.
  const frameH = Math.round(height * 0.72);
  const frameW = Math.round(frameH * frames[0]!.aspect);
  const gap = Math.round(frameW * 0.18);
  const step = frameW + gap;
  const frameX = Math.round((width - frameW) / 2);
  const frameY = Math.round(height * 0.13);
  const radius = Math.max(10, Math.round(frameW * 0.045));

  const { css: camCss, totalMs } = cameraKeyframes(frames.length, step, holdMs, slideMs);

  // One extra copy of the first page sits after the last, so the final
  // glide arrives "home" exactly as the loop restarts.
  const sequence = [...frames, frames[0]!];
  const tiles = sequence
    .map((frame, i) => {
      const x = frameX + i * step;
      const labelY = frameY + frameH + 34;
      return (
        `    <g>\n` +
        `      <rect x="${x - 1}" y="${frameY - 1}" width="${frameW + 2}" height="${frameH + 2}" rx="${radius + 1}" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1"/>\n` +
        `      <image href="${frame.dataUri}" x="${x}" y="${frameY}" width="${frameW}" height="${frameH}" clip-path="url(#frame-${i})" preserveAspectRatio="xMidYMin slice"/>\n` +
        `      <text x="${x + frameW / 2}" y="${labelY}" text-anchor="middle" class="route">${escapeXml(frame.path)}</text>\n` +
        `    </g>`
      );
    })
    .join('\n');

  const clips = sequence
    .map((_, i) => {
      const x = frameX + i * step;
      return `    <clipPath id="frame-${i}"><rect x="${x}" y="${frameY}" width="${frameW}" height="${frameH}" rx="${radius}"/></clipPath>`;
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
  <rect width="${width}" height="${height}" fill="${BG}"/>
  <defs>
    <linearGradient id="fade-l" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${BG}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${BG}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fade-r" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="${BG}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${BG}" stop-opacity="0"/>
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
  <text x="${width - 40}" y="${height - 40}" text-anchor="end" font-size="14" fill="${DIM_TEXT}">made with <tspan fill="${ACCENT}">npx allpages</tspan></text>
  <rect x="${barX}" y="${barY}" width="${barW}" height="2" rx="1" fill="rgba(255,255,255,0.10)"/>
  <rect x="${barX}" y="${barY}" width="${barW}" height="2" rx="1" fill="${ACCENT}" class="bar"/>
</svg>
`;
}
