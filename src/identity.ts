import type { Device } from './types.ts';

/**
 * How allpages introduces itself to a website.
 *
 * Playwright's Chromium reports `HeadlessChrome/141.0.0.0`, and a large share
 * of the web answers that token with a 403 challenge page instead of HTML.
 * That is the single most common way this tool fails on a real site: you get a
 * contact sheet of error pages and no idea why.
 *
 * The engine genuinely is Chrome, on the platform this genuinely is running
 * on. "Headless" only says no window is open, which is not a fact a server
 * needs in order to render a page. So allpages says Chrome.
 *
 * That is the whole of it. There are no stealth patches here, no
 * `navigator.webdriver` lies, no fingerprint forgery and no CAPTCHA solving.
 * A site that actually wants to challenge still wins, and allpages reports it
 * as blocked and points at `--auth`, which puts a human in the loop where one
 * belongs.
 */

/** Chrome's own reduced-UA platform tokens, matched to the real host. */
function platformToken(mobile: boolean): string {
  if (mobile) return 'Linux; Android 10; K';
  switch (process.platform) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    default:
      return 'X11; Linux x86_64';
  }
}

/**
 * Chrome freezes its UA at `<major>.0.0.0`, so reading the major off the
 * browser we actually launched keeps this honest and current without ever
 * needing a version bump here.
 */
export function chromeVersion(browserVersion: string): string {
  const major = /^(\d+)\./.exec(browserVersion)?.[1];
  return `${major ?? '141'}.0.0.0`;
}

/** The UA for a given viewport: mobile sizes ask for the mobile site. */
export function userAgentFor(device: Pick<Device, 'mobile'>, browserVersion: string): string {
  const version = chromeVersion(browserVersion);
  const platform = platformToken(device.mobile);
  const suffix = device.mobile ? 'Mobile Safari/537.36' : 'Safari/537.36';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} ${suffix}`;
}

/** Desktop UA, for crawling and for plain HTTP fetches. */
export function desktopUserAgent(browserVersion: string): string {
  return userAgentFor({ mobile: false }, browserVersion);
}

/**
 * A last-resort UA for code paths that run before a browser exists, such as
 * the sitemap and robots fetches that race the browser launch.
 */
export const FALLBACK_USER_AGENT = desktopUserAgent('141');

/** Headers a browser always sends and `fetch` never does. */
export function httpHeaders(userAgent = FALLBACK_USER_AGENT): Record<string, string> {
  return {
    'user-agent': userAgent,
    'accept-language': 'en-US,en;q=0.9',
  };
}

/**
 * Pages a bot check serves in place of the site. Matched on title because the
 * body is usually an iframe: the interstitial is the one thing every vendor
 * renders the same way.
 */
const CHALLENGE_TITLE =
  /^(just a moment|attention required|checking your browser|security check|please wait|verifying you are human|access denied|one more step)/i;

/**
 * Is this a bot-check interstitial rather than the page that was asked for?
 * Status alone is not enough (a real 403 is a permissions answer, worth
 * showing as-is) and title alone is not enough (a page may legitimately be
 * called "Access denied"), so it takes both.
 */
export function looksLikeBotCheck(status: number, title: string): boolean {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  return CHALLENGE_TITLE.test(title.trim());
}
