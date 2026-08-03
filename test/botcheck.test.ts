import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { captureAll } from '../src/capture.ts';
import { DEVICES, type Route } from '../src/types.ts';

/** Listen on a free port and return the base URL. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * A site that answers anything calling itself headless with the interstitial
 * a real bot check serves, and answers a normal browser with the page. This
 * is exactly what ample.money did, and what made every tile an error page.
 */
function guardedSite(): Server {
  return createServer((req, res) => {
    const ua = req.headers['user-agent'] ?? '';
    if (/headless/i.test(ua)) {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><head><title>Just a moment...</title></head><body>checking</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Real page</title></head><body><h1>${req.url}</h1></body></html>`);
  });
}

const capture = async (baseUrl: string, outDir: string, userAgent?: string) => {
  const browser = await chromium.launch();
  try {
    return await captureAll(
      browser,
      [{ path: '/', source: 'given' } satisfies Route],
      {
        baseUrl,
        devices: [DEVICES.desktop!],
        themes: ['light'],
        outDir,
        concurrency: 1,
        timeoutMs: 15000,
        fullPage: false,
        hide: [],
        delayMs: 0,
        lazyLoad: false,
        dismissBanners: false,
        ...(userAgent ? { userAgent } : {}),
      },
    );
  } finally {
    await browser.close().catch(() => {});
  }
};

test('a site that turns away headless browsers is still captured', async () => {
  const server = guardedSite();
  const baseUrl = await listen(server);
  const outDir = mkdtempSync(join(tmpdir(), 'allpages-bot-'));
  try {
    const result = await capture(baseUrl, outDir);
    assert.equal(result.botChecked.length, 0, 'nothing should have been blocked');
    assert.ok(result.shots[0]?.file, 'the page should have been shot');
    assert.equal(result.shots[0]?.title, 'Real page');
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a challenge that does hold is named as one, not reported as HTTP 403', async () => {
  const server = guardedSite();
  const baseUrl = await listen(server);
  const outDir = mkdtempSync(join(tmpdir(), 'allpages-bot-'));
  try {
    // Force the interstitial by asking for it, so the difference between
    // "blocked by a bot check" and "HTTP 403" is the thing under test.
    const result = await capture(baseUrl, outDir, 'HeadlessChrome/141.0.0.0');
    assert.deepEqual(result.botChecked, ['/']);
    assert.equal(result.shots[0]?.skipped, 'blocked by a bot check');
    assert.ok(!result.shots[0]?.file, 'a challenge page is not worth a tile');
  } finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
