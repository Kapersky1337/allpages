import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright-core';
import { extractVector, pageToSvgGroup, primaryFont } from '../src/vector.ts';
import { wrapSvg } from '../src/figma.ts';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Vector</title>
<style>
  body { margin:0; background:#ffffff; font-family: "Custom Sans", ui-sans-serif, sans-serif; }
  .card { width:300px; height:120px; background:#f3f4f6; border:2px solid #4f46e5;
          border-radius:12px; margin:20px; }
  h1 { color:#111827; font-size:32px; font-weight:700; margin:20px }
  .sr-only { position:absolute; width:1px; height:1px; clip:rect(0 0 0 0); overflow:hidden }
  .offscreen { position:absolute; left:-9999px }
  .masked { width:24px; height:24px; background:#000; -webkit-mask-image:url(#m); mask-image:url(#m) }
  .hidden { display:none }
</style></head><body>
  <h1>Hello &amp; welcome &lt;world&gt;</h1>
  <div class="card"></div>
  <span class="sr-only">Screen reader only</span>
  <span class="offscreen">Offscreen text</span>
  <div class="masked"></div>
  <div class="hidden">Never rendered</div>
  <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="red"/></svg>
</body></html>`;

let browser: Browser | undefined;
async function getBrowser(): Promise<Browser | null> {
  if (browser) return browser;
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try {
      browser = await chromium.launch(channel ? { channel } : {});
      return browser;
    } catch {
      /* try next */
    }
  }
  return null;
}

function serve(html: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise((r) =>
    server.listen(0, () => r({ server, port: (server.address() as { port: number }).port })),
  );
}

test('the first real font wins over CSS generics', () => {
  assert.equal(primaryFont('"Custom Sans", ui-sans-serif, sans-serif'), 'Custom Sans');
  assert.equal(primaryFont('ui-sans-serif, system-ui, sans-serif'), 'Inter');
  assert.equal(primaryFont('ui-monospace, monospace'), 'Roboto Mono');
  assert.equal(primaryFont('Georgia, serif'), 'Georgia');
  assert.equal(primaryFont(undefined), 'Inter');
});

test('extracts text, boxes and icons — and leaves out what is invisible', async (t) => {
  const b = await getBrowser();
  if (!b) return t.skip('no chromium available');
  const { server, port } = await serve(PAGE);
  const page = await b.newPage({ viewport: { width: 900, height: 600 } });
  try {
    await page.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded' });
    const vector = await extractVector(page);

    const texts = vector.nodes.filter((n) => n.kind === 'text').map((n) => n.text ?? '');
    assert.ok(texts.some((t) => t.includes('Hello')), `expected heading, got ${texts.join(' | ')}`);

    // Invisible things must not be exported.
    assert.ok(!texts.some((t) => t.includes('Screen reader only')), 'sr-only text leaked');
    assert.ok(!texts.some((t) => t.includes('Offscreen')), 'offscreen text leaked');
    assert.ok(!texts.some((t) => t.includes('Never rendered')), 'display:none leaked');

    // The card is a rect with a radius and a stroke. Its measured width is
    // the border box (300 + 2px borders), which is what should be drawn.
    const card = vector.nodes.find((n) => n.kind === 'rect' && Math.abs(n.w - 304) < 2);
    assert.ok(card, 'card rect missing');
    assert.ok((card.radius ?? []).some((r) => r > 0), 'radius lost');
    assert.ok(card.stroke, 'border lost');

    // Inline SVG is carried through as vector, not drawn as a black box.
    assert.ok(vector.nodes.some((n) => n.kind === 'svg'), 'inline svg dropped');
    // The mask-icon must not become a solid square.
    assert.ok(
      !vector.nodes.some((n) => n.kind === 'rect' && Math.round(n.w) === 24 && Math.round(n.h) === 24),
      'masked icon exported as a black square',
    );
  } finally {
    await page.close();
    server.close();
  }
});

test('the emitted SVG is well-formed and escapes page text', async (t) => {
  const b = await getBrowser();
  if (!b) return t.skip('no chromium available');
  const { server, port } = await serve(PAGE);
  const page = await b.newPage({ viewport: { width: 900, height: 600 } });
  try {
    await page.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded' });
    const vector = await extractVector(page);
    const svg = wrapSvg(pageToSvgGroup(vector, 'home', 0, 0), vector.width, vector.height);

    assert.ok(svg.startsWith('<svg xmlns='), 'missing svg root');
    assert.ok(svg.includes('<text '), 'no editable text layers');
    // Page content containing markup characters must be escaped.
    assert.ok(svg.includes('&amp;') && svg.includes('&lt;world&gt;'), 'text not escaped');

    // It must actually parse as XML — Figma will reject anything else.
    const parsed = await page.evaluate((markup: string) => {
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
      return doc.querySelector('parsererror') ? 'invalid' : 'ok';
    }, svg);
    assert.equal(parsed, 'ok', 'generated SVG is not valid XML');
  } finally {
    await page.close();
    server.close();
  }
});

test.after(async () => {
  await browser?.close().catch(() => {});
});
