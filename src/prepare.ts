import type { Page } from 'playwright-core';

/**
 * Everything that has to happen to a real website before it is worth
 * photographing. A local dev app needs none of this; stripe.com needs all
 * of it, and without it every tile is a cookie banner over a grey box.
 */

export interface PrepareOptions {
  /** CSS selectors to hide before shooting (chat widgets, banners, …). */
  hide: string[];
  /** Wait for this selector before shooting. */
  waitFor?: string;
  /** Extra settle time in ms after everything else. */
  delayMs: number;
  /** Scroll the page to trigger lazy-loaded images, then return to the top. */
  lazyLoad: boolean;
  /** Try to dismiss cookie/consent dialogs. */
  dismissBanners: boolean;
}

// Known consent frameworks, in the order they're worth trying. Clicking the
// real "accept" button beats hiding the banner: many sites block scrolling
// until consent is given, and a hidden-but-unconsented page is still frozen.
const CONSENT_BUTTONS = [
  '#onetrust-accept-btn-handler',
  '#onetrust-reject-all-handler',
  '.onetrust-close-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  'button[mode="primary"][data-testid="uc-accept-all-button"]',
  '#didomi-notice-agree-button',
  '.cc-btn.cc-allow',
  '.cookie-consent-accept',
  '[data-cky-tag="accept-button"]',
  '#hs-eu-confirmation-button',
  'button[aria-label="Accept cookies"]',
  'button[aria-label="Accept all cookies"]',
  '#truste-consent-button',
  '.osano-cm-accept-all',
  '[data-testid="cookie-policy-manage-dialog-accept-button"]',
];

// Text used by the long tail of hand-rolled banners. Matched case-insensitively
// against short, button-like elements only, so a blog post about "accepting
// cookies" never gets clicked.
const CONSENT_TEXT = [
  'accept all',
  'accept all cookies',
  'allow all',
  'accept cookies',
  'i accept',
  'i agree',
  'agree and continue',
  'got it',
  'okay',
  'ok',
  'accept',
  'continue',
];

// Overlays worth removing outright: things that survive consent, or that
// float over every page and would otherwise appear in all 40 tiles.
const NOISE_SELECTORS = [
  '#onetrust-consent-sdk',
  '#CybotCookiebotDialog',
  '#CybotCookiebotDialogBodyUnderlay',
  '#usercentrics-root',
  '#didomi-host',
  '.osano-cm-window',
  '#hs-eu-cookie-confirmation',
  '[id^="sp_message_container"]',
  '.grecaptcha-badge',
  '#intercom-container',
  '.intercom-lightweight-app',
  '#drift-widget-container',
  '#hubspot-messages-iframe-container',
  '#crisp-chatbox',
  '#launcher',
  'div[class*="cookie-banner"]',
  'div[class*="CookieBanner"]',
  'div[id*="cookie-banner"]',
];

/** Click a consent button if one is on screen. Returns what it clicked. */
export async function dismissConsent(page: Page): Promise<string | null> {
  for (const selector of CONSENT_BUTTONS) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 250 })) {
        await button.click({ timeout: 1500, noWaitAfter: true });
        await page.waitForTimeout(250);
        return selector;
      }
    } catch {
      // not present, hidden, or detached mid-click — try the next one
    }
  }

  // Text-matched fallback for hand-rolled banners.
  try {
    const clicked = await page.evaluate((phrases: string[]) => {
      const isButtonish = (el: Element): boolean => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'button' || tag === 'a') return true;
        const role = el.getAttribute('role');
        return role === 'button' || (el as HTMLElement).onclick !== null;
      };
      const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
      for (const phrase of phrases) {
        for (const el of candidates) {
          const text = (el.textContent ?? '').trim().toLowerCase();
          // Button-length text only: never a paragraph that mentions cookies.
          if (text.length > 24 || text !== phrase || !isButtonish(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          (el as HTMLElement).click();
          return phrase;
        }
      }
      return null;
    }, CONSENT_TEXT);
    if (clicked) {
      await page.waitForTimeout(250);
      return `text:${clicked}`;
    }
  } catch {
    // evaluation blocked (CSP, navigation) — fall through to hiding
  }
  return null;
}

/** Hide overlays and any user-supplied selectors, and unfreeze scrolling. */
export async function hideNoise(page: Page, extra: string[]): Promise<void> {
  const selectors = [...NOISE_SELECTORS, ...extra];
  try {
    await page.addStyleTag({
      content:
        `${selectors.join(',\n')} { display: none !important; }\n` +
        // Consent walls routinely lock the page; undo that so full-page
        // captures and lazy-loading work.
        `html, body { overflow: auto !important; position: static !important; }`,
    });
  } catch {
    // CSP can forbid injected styles; the click path above usually sufficed
  }
}

/** Scroll through the page so lazy images load, then return to the top. */
export async function triggerLazyLoad(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const step = Math.max(320, window.innerHeight * 0.9);
      const limit = Math.min(document.body.scrollHeight, 20000);
      for (let y = 0; y < limit; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 120));
    });
    // Give decoded images a moment to paint after the scroll back up.
    await page.waitForTimeout(150);
  } catch {
    // navigation during scroll; the shot is still worth taking
  }
}

/** Run the full preparation pass. Returns notes for the report. */
export async function preparePage(page: Page, opts: PrepareOptions): Promise<{ consent: string | null }> {
  let consent: string | null = null;
  if (opts.dismissBanners) consent = await dismissConsent(page);
  await hideNoise(page, opts.hide);

  if (opts.waitFor) {
    try {
      await page.locator(opts.waitFor).first().waitFor({ state: 'visible', timeout: 8000 });
    } catch {
      // selector never appeared; shoot what rendered rather than failing
    }
  }
  if (opts.lazyLoad) await triggerLazyLoad(page);
  if (opts.delayMs > 0) await page.waitForTimeout(opts.delayMs);
  return { consent };
}
