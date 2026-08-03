/** How a route was found. Shown on the sheet so the map is honest. */
export type RouteSource = 'crawl' | 'sitemap' | 'manifest' | 'given';

export interface Route {
  /** Path only, e.g. "/pricing". Always starts with "/". */
  path: string;
  source: RouteSource;
  /** For dynamic routes: the template this concrete path came from. */
  template?: string;
  /**
   * Set when this page was shot to stand for a family of pages sharing a
   * layout: `/blog/:slug`, 186 pages. The tile says so.
   */
  standsFor?: { pattern: string; count: number };
}

export type Theme = 'light' | 'dark';

export interface Device {
  name: string;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
}

/** One captured (or deliberately not captured) cell of the sheet. */
export interface Shot {
  route: Route;
  device: Device;
  theme: Theme;
  file?: string;
  /** Set when the cell has no image, with the reason to print on the sheet. */
  skipped?: string;
  /** The page redirected somewhere else, usually a login wall. */
  redirectedTo?: string;
  title?: string;
  ms?: number;
}

export interface CaptureOptions {
  baseUrl: string;
  devices: Device[];
  themes: Theme[];
  outDir: string;
  concurrency: number;
  timeoutMs: number;
  storageState?: string;
  fullPage: boolean;
  insecure?: boolean;
  /** CSS selectors to hide before shooting. */
  hide?: string[];
  /** Wait for this selector before shooting. */
  waitFor?: string;
  /** Extra settle time per page, in ms. */
  delayMs?: number;
  /** Scroll to trigger lazy-loaded images. */
  lazyLoad?: boolean;
  /** Click cookie/consent dialogs away. */
  dismissBanners?: boolean;
  userAgent?: string;
}

export const DEVICES: Record<string, Device> = {
  phone: { name: 'phone', width: 390, height: 844, scale: 2, mobile: true },
  desktop: { name: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
  tablet: { name: 'tablet', width: 834, height: 1112, scale: 2, mobile: true },
};
