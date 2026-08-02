export { discoverRoutes, everypage, normalizeUrl } from './api.ts';
export type { DiscoverResult, EverypageOptions, EverypageResult } from './api.ts';

export { captureAll, looksLikeAuthWall, slugsFor } from './capture.ts';
export { crawlWithBrowser, fetchRobots, isAllowed, isCrawlable } from './crawl.ts';
export {
  byImportance,
  isDynamic,
  mergeRoutes,
  normalizePath,
  routesFromCrawl,
  routesFromDisk,
  routesFromSitemap,
  sampleRoutes,
} from './discover.ts';
export { dismissConsent, hideNoise, preparePage, triggerLazyLoad } from './prepare.ts';
export { buildHtml, chooseSheetWidth, renderSheet } from './sheet.ts';
export { DEVICES } from './types.ts';
export type { CaptureOptions, Device, Route, RouteSource, Shot, Theme } from './types.ts';
