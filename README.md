# everypage

**Every page of a website — phone and desktop, light and dark — as one image.**

```bash
npx everypage https://yoursite.com
```

![every page of vite.dev, as one contact sheet](https://raw.githubusercontent.com/kapersky1337/everypage/main/example.png)

<sub>`npx everypage https://vite.dev` — 10 routes, 28 screens, 15.6s. The three `HTTP 404` chips at the bottom are stale sitemap entries; everypage reports them instead of showing you blank tiles.</sub>

No config. No list of URLs. No test file. It finds the pages itself.

## Why

You built a dozen pages over a few weeks and you have never seen them next to each other — you definitely never opened half of them on a phone.

Neither has your agent. When Claude or Cursor wants to look at your app, it screenshots one page at a time, burning a tool call and a thousand vision tokens per screen.

`everypage` shoots all of them at once and hands you a single image. Look at it yourself, then drag it into your agent and say **"make these consistent."**

## Install

```bash
npx everypage https://yoursite.com    # nothing to install
npm i -g everypage                    # or keep it around
```

Uses Playwright's Chromium if you have it, otherwise the Chrome or Edge already on your machine. If neither exists: `npx playwright install chromium`.

## It works on anything with a URL

```bash
npx everypage https://stripe.com          # a public site
npx everypage localhost:3000              # your dev server
npx everypage https://staging.acme.dev    # a preview deploy
```

Pages are found from whatever the site actually offers, all merged:

| Source | What it catches |
|---|---|
| **Your route files** | `app/**/page.tsx`, `pages/**`, `src/routes/**/+page.svelte` — including pages nothing links to yet |
| **`sitemap.xml`** | the canonical list, when the site publishes one |
| **Crawling links** | anything reachable from the homepage |
| **Crawling *in a browser*** | links that only exist after JavaScript runs |

That last row is the one that makes this work everywhere. On a client-rendered app (Vite, CRA, React Router) the HTML is an empty `<div id="root">` — the links appear when the framework boots. everypage notices the HTML had nothing in it and looks again in a real browser.

Big sites get sampled toward the **shallow** pages: `playwright.dev` has 357 routes, and the alphabetically-first 20 are all one API section. Depth-first ordering gives you the map of the site instead.

## What real websites throw at you

A localhost demo needs none of this. A real site needs all of it, and without it every tile is a cookie banner over a grey box.

- **Cookie and consent dialogs** are clicked away — OneTrust, Cookiebot, Didomi, Usercentrics, Osano, TrustArc, HubSpot, plus a text-matched fallback that only ever clicks short, button-shaped elements. (Clicking beats hiding: consent walls often freeze scrolling until you answer.)
- **Chat widgets and floating overlays** — Intercom, Drift, Crisp, reCAPTCHA badges — are hidden, so they don't appear in all forty tiles.
- **Lazy images** are loaded by scrolling the page before the shot.
- **`robots.txt` is respected.** `--no-robots` if it's your own site and you don't care.
- **Anything else:** `--hide '.promo-bar, #newsletter'`, `--wait '.chart-loaded'`, `--delay 500`.

## Pages behind a login

Without a session, half your app redirects and you get a sheet of identical login screens. everypage detects the redirect, tells you which routes hit it, and takes a session:

```
✓ 36 screens in 5.4s
  2 pages redirected to a login (/dashboard, /settings)
  re-run with --auth <storageState.json> to shoot them as you
```

```bash
npx playwright codegen --save-storage=session.json   # log in once
npx everypage localhost:3000 --auth session.json     # → 44 screens
```

## Dynamic routes

`/orders/[id]` is not a URL — screenshotting it literally puts a 404 in your sheet. everypage matches the template against real links found while crawling, so it shoots `/orders/42` instead. If it never finds a real one, the route appears in a **not captured** strip with the reason:

```
NOT CAPTURED  3 routes
/dashboard  redirected to /login    /orders/[id]  dynamic route, no example URL found
```

A map with a labeled hole beats a map that quietly lies.

## Options

```
--devices phone,desktop     which sizes (phone, tablet, desktop)
--themes light,dark         which color schemes
--routes /a,/b              shoot exactly these, skip discovery
--auth <state.json>         Playwright storageState — shoot private pages as you
--max <n>                   cap discovered routes (default: 20)
--depth <n>                 link levels to follow (default: 2)
--project <dir>             where your code lives, for route files (default: cwd)
--out <dir>                 output directory (default: ./everypage)
--full-page                 whole scroll height into shots/
--hide <sel,sel>            CSS selectors to hide
--wait <selector>           wait for this element before shooting
--delay <ms>                extra settle time per page
--timeout <seconds>         per-page load budget (default: 15)
--columns <n>               tiles per row on the sheet
--concurrency <n>           parallel browser contexts (default: cpu count)
--user-agent <ua>           override the browser user agent
--no-lazy                   skip the scroll that loads lazy images
--no-banners                don't dismiss cookie dialogs
--no-robots                 crawl paths robots.txt disallows
--insecure                  accept self-signed certs (local https)
--force                     write into a directory that has other files
--no-open                   don't open the sheet when it's done
```

You get `everypage/everypage.png` (the sheet) and `everypage/shots/` (each screenshot, named `route--device--theme.png`).

## Use it as a library

```bash
npm i everypage
```

```ts
import { everypage } from 'everypage';

const { sheet, shots, routes, authWalled } = await everypage({
  url: 'https://yoursite.com',
  devices: ['phone', 'desktop'],
  themes: ['light', 'dark'],
  outDir: './snapshots',
  max: 20,
  onProgress: (done, total) => console.log(`${done}/${total}`),
});

console.log(sheet);                          // → /abs/path/snapshots/everypage.png
console.log(shots.filter((s) => s.file));    // every captured screenshot
console.log(routes.map((r) => r.path));      // what it decided to shoot
```

Pass an existing `browser` to reuse one you already launched, or `skipSheet: true` to get only the individual shots. `discoverRoutes()` is exported separately if you just want the list of pages.

## For agents

The sheet is one image; the shots are plain files. Instead of 44 screenshot tool calls:

```
> drag everypage.png into Claude Code
"three of these have the wrong header, and /pricing is broken on mobile. fix them."
```

## Honest limits

- **Chromium only.** Safari and Firefox rendering differences aren't covered.
- **Navigation without links stays invisible.** If a page is only reachable by submitting a form or clicking a JS handler, no crawler finds it — `--routes` is the escape hatch.
- **Client-rendered pages** get a settle window (network-idle, then a short pause). Apps that stream forever still shoot, but may catch a spinner; `--wait` and `--delay` fix it.
- **Above the fold by default.** `--full-page` captures the whole scroll height into `shots/`, but sheet tiles stay uniform and show the top of each page — a grid where one tile is ten times taller than its neighbour stops being readable.
- **No dark mode?** If every dark shot is byte-identical to its light one, the dark tiles are dropped and the sheet says so.
- Auth-walled and undiscoverable routes are listed, never silently dropped.
- everypage only ever writes `everypage.png` and `shots/`. If `--out` points at a directory with anything else in it, it refuses rather than deleting your files.
- Be a good citizen on sites you don't own: `robots.txt` is respected by default and the crawl is depth- and count-limited.

## Build

```bash
npm install && npm run build
npm test                                    # 27 tests
node demo-app/server.js &                   # a small app with a login wall
node dist/cli.js localhost:4173 --project demo-app
```

## License

MIT © [kapersky1337](https://github.com/kapersky1337)
