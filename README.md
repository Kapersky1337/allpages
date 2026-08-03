# everypage

**Every page of a website — phone and desktop, light and dark — as one image.**

```bash
npx everypage https://yoursite.com
```

![every page of a demo app, as one contact sheet](https://raw.githubusercontent.com/kapersky1337/everypage/main/example.png)

<sub>The bundled demo app: 12 routes, 44 screens, 5.9s — including two pages behind a login. Run it yourself with `node demo-app/server.js`.</sub>

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

## A big site is not a big design

A 267-page marketing site is usually about nine layouts and a few hundred blog posts. Shooting twenty arbitrary pages is an apology; shooting **one page per layout** is a truer picture of the site than all 267 tiles would be — and it's free, because the grouping comes from the URLs before a browser opens.

```
$ npx everypage https://acme.com

  267 pages, 9 layouts — shooting one page from each
  ✓ 36 screens in 7.3s → everypage/everypage.png
  /blog/:slug 186 pages · /customers/:slug 74 pages
  --only '/blog/*' to open one up · --all for every page
```

Tiles say what they stand for:

```
/blog/:slug
one of 186 · /blog/post-1
```

Nothing is hidden. Every URL lands in `everypage/routes.txt`, with a `*` next to the ones in the sheet:

```
# acme.com — 267 pages, 9 shot — 2026-08-03
# * = in the sheet
* /
* /blog
  /blog/post-2
  /blog/post-3
```

**No prompt, ever.** You can't choose which of 267 pages matter *before* you've seen them — that's why you ran the command. So the choice comes after the picture, as the exact line to copy, printed at the moment it's useful. It also means everypage never blocks: it's a pure function of its arguments, safe inside CI and inside an agent's subshell.

Below 25 pages nothing changes — no grouping, no extra output, same magic as a small app.

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
--max <n>                   cap pages shot (default: 20)
--all                       shoot every page, not one per layout
--only <glob,glob>          only pages matching these (e.g. '/blog/*')
--exclude <glob,glob>       skip pages matching these
--no-group                  don't collapse pages that share a layout
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

## Export to Figma

```bash
npx everypage figma https://yoursite.com
```

Same discovery, vector output. You get `everypage.svg` — every page side by side as a group — plus `pages/*.svg` for importing one at a time. Drag either into Figma.

```
  ✓ 11 pages · 1,240 editable layers in 6.2s
    everypage/everypage.svg  ← drag into Figma
    everypage/pages/ one SVG per page
```

**These are real layers, not a screenshot in a wrapper.** Text arrives as editable text with its own font, size, weight and colour. Boxes arrive as rects with their real corner radii and borders. Inline SVG icons are carried through as vector, so a logo stays a logo. Only genuinely raster things — photos, `<img>` — stay raster.

It also skips what shouldn't be there: screen-reader-only text, `display:none`, off-screen elements, and CSS-mask icons that would otherwise import as black squares. Font stacks are resolved to the first *real* family, because Figma can't match `ui-sans-serif`.

```bash
npx everypage figma localhost:3000 --devices phone   # mobile canvas
npx everypage figma https://site.com --only '/blog/*' --max 5
```

Fidelity is high but not perfect — gradients, shadows, transforms and pseudo-elements aren't reproduced. It's for taking a real site into Figma to redesign, not for pixel-exact archival. Use the PNG sheet for that.

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
  only: ['/blog/*'],       // optional: same globs as the CLI
  group: true,             // one page per layout above 24 pages
  onProgress: (done, total) => console.log(`${done}/${total}`),
});

console.log(sheet);                          // → /abs/path/snapshots/everypage.png
console.log(shots.filter((s) => s.file));    // every captured screenshot
console.log(routes.map((r) => r.path));      // what it decided to shoot
console.log(routes.filter((r) => r.standsFor));  // tiles standing for a family
```

Pass an existing `browser` to reuse one you already launched, or `skipSheet: true` to get only the individual shots. `discoverRoutes()` is exported separately if you just want the list of pages.

## In CI

Point it at a preview deploy and upload the sheet as an artifact, so every PR gets a picture of the whole site:

```yaml
- uses: kapersky1337/everypage@main
  id: shots
  with:
    url: ${{ steps.deploy.outputs.preview-url }}
    max: 20
- uses: actions/upload-artifact@v4
  with:
    name: everypage
    path: everypage/
```

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

## Using this responsibly

everypage drives a real browser against whatever URL you give it. On your own sites that's just tooling. On sites you don't own, a few things are worth knowing, and the defaults are set so you don't have to think about them:

- **`robots.txt` is respected by default.** `--no-robots` exists for your own sites; using it elsewhere is on you.
- **The crawl is bounded** — same-origin only, two link levels, 500 pages of discovery — so it behaves like a person browsing, not a scraper.
- **Nothing is uploaded.** Every file stays on your machine; there is no account, no telemetry, no server.
- **Cookie dialogs are clicked** so pages render normally. If you'd rather not interact with a site at all, `--no-banners`. Sessions live only for the run.
- **What you capture belongs to the site's owner.** Screenshots and SVG exports contain someone else's design, content and trademarks. everypage gives you no rights to them — check you have permission before capturing, republishing, or shipping a design derived from a site you don't own.
- Many sites' terms restrict automated access. That agreement is between you and them.

## Licensing

MIT — see [LICENSE](./LICENSE). One runtime dependency, [`playwright-core`](https://github.com/microsoft/playwright) (Apache-2.0, © Microsoft). Full attribution in [NOTICE](./NOTICE).

## Build

```bash
npm install && npm run build
npm test                                    # 49 tests
node demo-app/server.js &                   # a small app with a login wall
node dist/cli.js localhost:4173 --project demo-app
```

## License

MIT © [kapersky1337](https://github.com/kapersky1337)
