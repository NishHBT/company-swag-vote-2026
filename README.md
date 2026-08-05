# Company Swag Vote 2026 — ballot site

Static, no-login ballot for the Hoffman Building Technologies swag vote, plus a
deployable Cloudflare Worker + D1 backend that collects the anonymous ballots and
exports an Excel-ready CSV.

```
site/                      static GitHub Pages bundle (plain HTML/CSS/vanilla JS)
  index.html
  css/styles.css
  js/config.js             public config — VOTE_API_URL (blank by default)
  js/app.js                ballot client
  data/catalog.json        60 products: id, name, category, approx. price, image
  assets/products/         the 9 supplied product photographs, verbatim
  favicon.svg
worker/                    Cloudflare Worker + D1 backend (see worker/README.md)
  src/index.js
  src/catalog.js           server-side catalog copy used to validate submissions
  schema.sql
  wrangler.toml.example
.github/workflows/deploy-pages.yml   deploys site/ to GitHub Pages
tools/build_catalog.py     regenerates catalog.json + worker/src/catalog.js
```

## Catalog

60 products (`P01`–`P60`) in 12 category groups, normalized from the wide
`New-Swag-Products.xlsx` sheet. Only product name, approximate price, and
category are carried through — **no vendor links and no colors** appear in the
data or the UI. 9 of the 60 items have a supplied photograph; the other 51 render
a designed "Image coming soon" card rather than a scraped or invented image.

| Category                | Items | Photographed |
| ----------------------- | ----- | ------------ |
| Duffle Bags             | 7     | 1            |
| Office Bags             | 7     | 0            |
| Heavy-Duty Bags         | 2     | 1            |
| Bottles & Mugs          | 5     | 0            |
| Notebooks & Office      | 3     | 1            |
| Coolers & Lunch         | 3     | 1            |
| Desk & Field Essentials | 7     | 1            |
| Tech & Tools            | 8     | 1            |
| Gifts & Recreation      | 5     | 1            |
| Outerwear               | 3     | 1            |
| Men's Apparel           | 5     | 1            |
| Women's Apparel         | 5     | 0            |

To regenerate after a catalog change, re-export the workbook rows and run
`python3 tools/build_catalog.py` (paths at the top of the script), which rewrites
both `site/data/catalog.json` and `worker/src/catalog.js` from the same source so
they cannot drift apart.

## Voting model

- Each product offers an optional radio group: **Like**, **Love**, **Don't Like**.
  Blank means no opinion.
- No login, no email, no name. The browser generates a random identifier the
  first time a ballot is submitted.
- The vote-lock is written **only after the server accepts the ballot**. A failed
  or unconfigured submission leaves the ballot open.
- Vote choices and results are never written into this repository — they live only
  in D1.
- One ballot per browser can be bypassed by clearing site data or using
  incognito; see the honest-limits section in `worker/README.md`.

## Local preview

```bash
cd site && python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy

1. **Pages:** push to `main`, then set Settings → Pages → Source to
   **GitHub Actions**. The workflow publishes `site/`.
2. **API:** follow `worker/README.md` (create D1, apply `schema.sql`, set
   `ADMIN_TOKEN` as a Wrangler secret, deploy).
3. **Wire them together:** set `VOTE_API_URL` in `site/js/config.js` to the
   Worker URL and set `ALLOWED_ORIGIN` in `wrangler.toml` to the Pages origin.
   Both are required before any vote can be recorded.
