import type { Page } from 'playwright-core';

/**
 * Turn a rendered page into SVG that Figma imports as *editable* layers:
 * real <text> nodes with their fonts and colours, real rects with their
 * radii and borders, and raster only where the page itself is raster.
 *
 * Deliberately written as a self-contained function evaluated inside the
 * page, using nothing but the DOM and getComputedStyle. Converting a full
 * DOM to SVG in the general case needs a bundler and a stack of CSS
 * dependencies; extracting the primitives a designer actually edits —
 * boxes, type, images — needs none, runs in milliseconds, and never
 * breaks on a CSS feature it has not heard of.
 */

export interface VectorNode {
  kind: 'rect' | 'text' | 'image' | 'svg';
  x: number;
  y: number;
  w: number;
  h: number;
  /** rect */
  fill?: string;
  radius?: number[];
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  /** text */
  text?: string;
  font?: string;
  size?: number;
  weight?: string;
  color?: string;
  letterSpacing?: number;
  baseline?: number;
  align?: string;
  /** image */
  href?: string;
  /** inline svg, carried through as-is */
  markup?: string;
}

export interface VectorPage {
  width: number;
  height: number;
  background: string;
  nodes: VectorNode[];
  title: string;
}

/** Runs in the browser. Keep it dependency-free and defensive. */
/* c8 ignore start — executes in the page, not in node */
function extract(maxNodes: number): VectorPage {
  const out: VectorNode[] = [];
  const seenText = new Set<Text>();

  const num = (v: string): number => Number.parseFloat(v) || 0;
  const visible = (s: CSSStyleDeclaration): boolean =>
    s.visibility !== 'hidden' && s.display !== 'none' && num(s.opacity) > 0.01;
  const painted = (c: string): boolean =>
    !!c && c !== 'transparent' && !c.startsWith('rgba(0, 0, 0, 0)') && !/,\s*0\)$/.test(c);

  // Screen-reader-only text is invisible on the page and must stay
  // invisible in the export: every sr-only recipe in the wild.
  const screenReaderOnly = (s: CSSStyleDeclaration, box: DOMRect): boolean => {
    if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)') return true;
    if (box.width <= 1 && box.height <= 1) return true;
    if (s.position === 'absolute' && (num(s.left) <= -9000 || num(s.top) <= -9000)) return true;
    if (num(s.textIndent) <= -9000) return true;
    return false;
  };

  const doc = document.documentElement;
  const pageWidth = Math.min(doc.scrollWidth, window.innerWidth);
  const pageHeight = Math.min(doc.scrollHeight, 20000);

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [document.body];
  let node = walker.nextNode();
  while (node && elements.length < maxNodes) {
    elements.push(node as Element);
    node = walker.nextNode();
  }

  for (const el of elements) {
    if (out.length >= maxNodes) break;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'head') continue;

    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(el);
    } catch {
      continue;
    }
    if (!visible(style)) continue;

    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    if (screenReaderOnly(style, box)) continue;
    if (box.bottom < 0 || box.top > pageHeight || box.right < 0 || box.left > pageWidth) continue;

    const x = box.left + window.scrollX;
    const y = box.top + window.scrollY;
    const alpha = num(style.opacity);

    // An inline <svg> is already vector. Carrying its markup through gives
    // Figma the real icon instead of a black box where the box model was.
    if (tag === 'svg') {
      try {
        out.push({
          kind: 'svg',
          x, y, w: box.width, h: box.height,
          markup: (el as SVGElement).outerHTML,
          opacity: alpha,
        });
      } catch {
        // inaccessible shadow content; skip rather than draw a block
      }
      continue;
    }

    // Images become <image> with their own source — the one place raster
    // is correct, because the page itself is raster there.
    if (tag === 'img') {
      const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
      if (src && !src.startsWith('data:image/svg')) {
        out.push({ kind: 'image', x, y, w: box.width, h: box.height, href: src, opacity: alpha });
        continue;
      }
    }

    // Background layers: colour, then any background-image.
    const bg = style.backgroundColor;
    const radius = [
      num(style.borderTopLeftRadius),
      num(style.borderTopRightRadius),
      num(style.borderBottomRightRadius),
      num(style.borderBottomLeftRadius),
    ];
    const borderWidth = num(style.borderTopWidth);
    const hasBorder = borderWidth > 0 && painted(style.borderTopColor);
    // A CSS-mask icon is a solid colour shaped by a mask. Without the mask
    // it is a black square, so draw nothing rather than a block.
    const maskProp = style.maskImage || (style as unknown as { webkitMaskImage?: string }).webkitMaskImage;
    const isMasked = !!maskProp && maskProp !== 'none';
    if (!isMasked && (painted(bg) || hasBorder)) {
      const rect: VectorNode = { kind: 'rect', x, y, w: box.width, h: box.height, opacity: alpha };
      if (painted(bg)) rect.fill = bg;
      if (radius.some((r) => r > 0)) rect.radius = radius;
      if (hasBorder) {
        rect.stroke = style.borderTopColor;
        rect.strokeWidth = borderWidth;
      }
      out.push(rect);
    }
    const bgImage = style.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      const url = /url\(["']?([^"')]+)["']?\)/.exec(bgImage)?.[1];
      if (url && !url.startsWith('data:image/svg')) {
        out.push({ kind: 'image', x, y, w: box.width, h: box.height, href: url, opacity: alpha });
      }
    }

    // Text: measured per line via Range rects, so wrapped paragraphs come
    // out as separate lines instead of one mispositioned blob.
    for (const child of el.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const textNode = child as Text;
      if (seenText.has(textNode)) continue;
      seenText.add(textNode);
      const content = textNode.textContent ?? '';
      if (!content.trim()) continue;

      const range = document.createRange();
      range.selectNodeContents(textNode);
      const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (lines.length === 0) continue;

      const size = num(style.fontSize);
      // Split the text across the measured line boxes proportionally to
      // their widths — good enough to place, and exact for single lines.
      const words = content.trim().split(/\s+/);
      const totalWidth = lines.reduce((sum, r) => sum + r.width, 0) || 1;
      let cursor = 0;
      lines.forEach((line, i) => {
        const share = i === lines.length - 1 ? words.length - cursor : Math.round((line.width / totalWidth) * words.length);
        const slice = words.slice(cursor, cursor + Math.max(1, share)).join(' ');
        cursor += Math.max(1, share);
        if (!slice) return;
        out.push({
          kind: 'text',
          x: line.left + window.scrollX,
          y: line.top + window.scrollY,
          w: line.width,
          h: line.height,
          text: slice,
          font: style.fontFamily,
          size,
          weight: style.fontWeight,
          color: style.color,
          letterSpacing: style.letterSpacing === 'normal' ? 0 : num(style.letterSpacing),
          // Approximate the alphabetic baseline within the line box.
          baseline: line.top + window.scrollY + size * 0.8,
          align: style.textAlign,
        });
      });
      if (out.length >= maxNodes) break;
    }
  }

  return {
    width: pageWidth,
    height: pageHeight,
    background: getComputedStyle(document.body).backgroundColor || '#ffffff',
    nodes: out,
    title: document.title,
  };
}
/* c8 ignore stop */

/** Pull the vector description of the current page. */
export async function extractVector(page: Page, maxNodes = 4000): Promise<VectorPage> {
  return page.evaluate(extract, maxNodes);
}

/** XML-escape, and drop control characters that would make the SVG invalid. */
function escapeXml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// CSS generic families are not fonts. Figma cannot match "ui-sans-serif",
// and an SVG renderer falls back to Times, so headings arrive as serif.
const GENERIC_FAMILIES = new Set([
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'system-ui', '-apple-system',
  'blinkmacsystemfont', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'emoji', 'math',
]);

/** The first real font in the stack — what Figma should try to match. */
export function primaryFont(family: string | undefined): string {
  if (!family) return 'Inter';
  const names = family.split(',').map((f) => f.replace(/["']/g, '').trim()).filter(Boolean);
  const concrete = names.find((n) => !GENERIC_FAMILIES.has(n.toLowerCase()));
  if (concrete) return concrete;
  // An all-generic stack still has an intent worth preserving.
  const generic = names[0]?.toLowerCase() ?? '';
  if (generic.includes('mono')) return 'Roboto Mono';
  if (generic.includes('serif') && !generic.includes('sans')) return 'Georgia';
  return 'Inter';
}

function roundedPath(n: VectorNode): string {
  const r = n.radius ?? [0, 0, 0, 0];
  const max = Math.min(n.w, n.h) / 2;
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, max));
  return (
    `M${n.x + tl!},${n.y} H${n.x + n.w - tr!} A${tr},${tr} 0 0 1 ${n.x + n.w},${n.y + tr!} ` +
    `V${n.y + n.h - br!} A${br},${br} 0 0 1 ${n.x + n.w - br!},${n.y + n.h} ` +
    `H${n.x + bl!} A${bl},${bl} 0 0 1 ${n.x},${n.y + n.h - bl!} ` +
    `V${n.y + tl!} A${tl},${tl} 0 0 1 ${n.x + tl!},${n.y} Z`
  );
}

/** Render one page's nodes as an SVG group, offset to (dx, dy). */
export function pageToSvgGroup(page: VectorPage, label: string, dx: number, dy: number): string {
  const parts: string[] = [];
  parts.push(`<g id="${escapeXml(label)}" transform="translate(${dx},${dy})">`);
  parts.push(
    `<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="${escapeXml(page.background)}"/>`,
  );

  for (const n of parts0(page.nodes)) {
    const op = n.opacity !== undefined && n.opacity < 1 ? ` opacity="${n.opacity.toFixed(2)}"` : '';
    if (n.kind === 'rect') {
      const fill = n.fill ? escapeXml(n.fill) : 'none';
      const stroke = n.stroke ? ` stroke="${escapeXml(n.stroke)}" stroke-width="${n.strokeWidth ?? 1}"` : '';
      if (n.radius?.some((r) => r > 0)) {
        parts.push(`<path d="${roundedPath(n)}" fill="${fill}"${stroke}${op}/>`);
      } else {
        parts.push(
          `<rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" fill="${fill}"${stroke}${op}/>`,
        );
      }
    } else if (n.kind === 'image' && n.href) {
      parts.push(
        `<image x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" href="${escapeXml(n.href)}" preserveAspectRatio="xMidYMid slice"${op}/>`,
      );
    } else if (n.kind === 'svg' && n.markup) {
      parts.push(
        `<svg x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" overflow="visible"${op}>${stripOuterSvgTag(n.markup)}</svg>`,
      );
    } else if (n.kind === 'text' && n.text) {
      const ls = n.letterSpacing ? ` letter-spacing="${n.letterSpacing.toFixed(2)}"` : '';
      parts.push(
        `<text x="${n.x.toFixed(1)}" y="${(n.baseline ?? n.y).toFixed(1)}" ` +
          `font-family="${escapeXml(primaryFont(n.font))}" font-size="${(n.size ?? 16).toFixed(1)}" ` +
          `font-weight="${escapeXml(n.weight ?? '400')}" fill="${escapeXml(n.color ?? '#000')}"${ls}${op}>` +
          `${escapeXml(n.text)}</text>`,
      );
    }
  }
  parts.push('</g>');
  return parts.join('\n');
}

/**
 * Keep an inline SVG's children and viewBox, drop its outer tag so the
 * wrapper can position it. Attributes we care about are re-applied.
 */
function stripOuterSvgTag(markup: string): string {
  const open = /^<svg\b([^>]*)>/i.exec(markup.trim());
  if (!open) return markup;
  const viewBox = /viewBox="([^"]+)"/i.exec(open[1] ?? '')?.[1];
  const inner = markup.trim().replace(/^<svg\b[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
  return viewBox ? `<g transform="scale(1)"><svg viewBox="${viewBox}" width="100%" height="100%">${inner}</svg></g>` : inner;
}

/** Painter's order: backgrounds, then images, then vector icons, then text. */
function parts0(nodes: VectorNode[]): VectorNode[] {
  const order = { rect: 0, image: 1, svg: 2, text: 3 } as const;
  return [...nodes].sort((a, b) => order[a.kind] - order[b.kind]);
}
