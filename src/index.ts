export { discoverRoutes, allpages, normalizeUrl, outDirFor, selectRoutes, GROUP_ABOVE } from './api.ts';
export type {
  DiscoverResult,
  AllpagesOptions,
  AllpagesResult,
  SelectOptions,
  SelectResult,
} from './api.ts';

export { captureAll, looksLikeAuthWall, slugsFor } from './capture.ts';
export {
  chromeVersion,
  desktopUserAgent,
  httpHeaders,
  looksLikeBotCheck,
  userAgentFor,
} from './identity.ts';
export { exportFigma, wrapSvg } from './figma.ts';
export type { FigmaOptions, FigmaResult } from './figma.ts';
export { extractVector, pageToSvgGroup, primaryFont } from './vector.ts';
export type { VectorNode, VectorPage } from './vector.ts';
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
