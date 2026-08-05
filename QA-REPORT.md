# QA report — Swag Vote 2026 site + worker

Environment: local static server (`python3 -m http.server` over `site/`), Playwright
Chromium at 1440x950 desktop, 375x812 and 320x700 mobile. Worker handler tested
offline via `worker/test/smoke.test.mjs`.

## Catalog / data

| Check | Result |
| --- | --- |
| Products in `site/data/catalog.json` | 60 (P01–P60) |
| Categories | 12, in the mapping supplied by the requester |
| Products with an exact supplied photograph | 9 |
| Products with the designed "Image coming soon" fallback | 51 |
| Photo files copied to `site/assets/products/` | 9, byte-identical to the uploads, 0 unmatched |
| Vendor URLs / colors present in any shipped file | none (grep for vendor domains, `vendor`, product URLs returned nothing) |
| Fabricated product imagery | none — every image is a supplied file |

## Static checks

- `node --check` passes on `site/js/app.js`, `site/js/config.js`, `worker/src/index.js`, `worker/src/catalog.js`.
- `catalog.json` parses; no `url`/`link`/`vendor`/`color` keys on any product.
- `.github/workflows/deploy-pages.yml` parses as YAML.
- `worker/schema.sql` applied to sqlite enforces `ballots.browser_id` UNIQUE,
  `votes(ballot_id, product_id)` UNIQUE and the vote-value CHECK.

## Worker smoke test — 11/11 pass (`npm test` in `worker/`)

health catalog size (60) · OPTIONS preflight 204 with CORS · disallowed origin 403 ·
unknown productId 400 · unknown vote value 400 · short browserId / empty ballot 400 ·
valid ballot 201 with `recorded` count · duplicate browserId 409 `already_voted` ·
export 401 without/with wrong admin token · export CSV has UTF-8 BOM, expected header
`ballot_id,submitted_utc,product_id,product_name,category,price,vote`, one row per
product vote, attachment filename · unknown route 404.

## Browser functional QA

| Check | Result |
| --- | --- |
| Render | 60 cards, 12 category sections, 9 photos, 51 fallbacks, no console or page errors |
| Rating a product | progress text, closer count, `aria-valuenow` and bar width all update |
| "Clear my rating" | unchecks the group and decrements the count |
| Category filter chip | shows only that section (Outerwear → 1 section, 3 cards); "All products" restores 12 |
| Submit with blank `VOTE_API_URL` | inline "endpoint not configured" error, form stays open, **no vote-lock stored** |
| Submit with mock API returning 201 | payload `{browserId, votes:[{productId, vote}]}`, confirmation shown, form and progress bar hidden, lock stored; lock survives reload |
| Network failure on submit | "could not reach the voting service", no lock, button re-enabled |
| API returns 409 | confirmation explains a ballot was already recorded, shows the server's count |
| Catalog fetch fails (HTTP 500) | error state with detail message; "Try again" recovers and renders 60 cards |
| Theme toggle | sets `data-theme="dark"`, `aria-pressed="true"`; dark palette verified by screenshot |
| Horizontal overflow | 0px at 375px and at 320px |
| Vote targets at 320px | ~63x55px (above the 44px touch minimum) |
| Skip link | first tab stop, slides into view on focus, Enter moves to `#ballot` |
| Radio keyboard nav | arrow keys move and select within a product's group; 3px visible focus ring |
| Images without alt text | 0 |
| `prefers-reduced-motion` | animations and smooth scrolling disabled |

## Fixes made during QA

1. Desktop hero left a dead right-hand column — `.intro__body` becomes a 2-column grid at ≥64rem.
2. Supplied photographs are shot on white — photo figures now get a true white plate so the product edge reads cleanly in both themes.
3. Category heading and item count were cramped on phones — the head stacks below 34rem and sits on one baseline above it.

## Not tested here

- Real Cloudflare D1 / deployed Worker (requires an account; see `worker/README.md` step 7).
- Real GitHub Pages serving and the Actions workflow run (no GitHub commands were run).
- `localStorage` on a true `https://` origin — verified only against the local
  http origin, where it is available; the client has an in-memory fallback and
  surfaces a storage warning when it is blocked.
