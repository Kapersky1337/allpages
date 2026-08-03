import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chromeVersion,
  desktopUserAgent,
  httpHeaders,
  looksLikeBotCheck,
  userAgentFor,
} from '../src/identity.ts';

test('the user agent never says Headless', () => {
  // This is the whole reason identity.ts exists: Playwright's own UA gets a
  // 403 challenge page from a default Cloudflare rule, and the sheet fills
  // with error screenshots instead of the site.
  for (const ua of [desktopUserAgent('141.0.7390.37'), userAgentFor({ mobile: true }, '141.0.7390.37')]) {
    assert.ok(!/headless/i.test(ua), `"${ua}" must not advertise a headless build`);
    assert.match(ua, /Chrome\/141\.0\.0\.0/);
    assert.match(ua, /^Mozilla\/5\.0 \(/);
  }
});

test('the version comes from the browser that is actually rendering', () => {
  assert.equal(chromeVersion('141.0.7390.37'), '141.0.0.0');
  assert.equal(chromeVersion('99.1.2.3'), '99.0.0.0');
  // Garbage in still has to produce a usable UA rather than "undefined".
  assert.match(chromeVersion('nonsense'), /^\d+\.0\.0\.0$/);
});

test('a phone viewport asks for the mobile site', () => {
  const phone = userAgentFor({ mobile: true }, '141.0.0.0');
  const desktop = userAgentFor({ mobile: false }, '141.0.0.0');
  assert.match(phone, /Mobile Safari/);
  assert.ok(!/Mobile/.test(desktop), 'a 1440px viewport must not claim to be a phone');
});

test('plain fetches introduce themselves the same way the browser does', () => {
  const headers = httpHeaders();
  assert.ok(!/headless/i.test(headers['user-agent'] ?? ''));
  assert.equal(headers['accept-language'], 'en-US,en;q=0.9');
});

test('a bot check is told apart from an ordinary 403', () => {
  assert.ok(looksLikeBotCheck(403, 'Just a moment...'));
  assert.ok(looksLikeBotCheck(503, 'Checking your browser before accessing'));
  assert.ok(looksLikeBotCheck(429, 'Attention Required! | Cloudflare'));

  // A real 403 is a permissions answer and deserves to be reported as one.
  assert.ok(!looksLikeBotCheck(403, 'Forbidden'));
  assert.ok(!looksLikeBotCheck(404, 'Just a moment...'), 'a 404 is not a challenge');
  // A page may legitimately be titled this and still have rendered.
  assert.ok(!looksLikeBotCheck(200, 'Access denied'));
});
