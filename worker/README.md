# Swag Vote API — Cloudflare Worker + D1

Backend for the **Company Swag Vote 2026** ballot at `../site`. It accepts one
anonymous ballot per browser identifier and gives the administrator an
Excel-ready CSV export. No login, no email addresses, no personal data.

- Runtime: Cloudflare Workers (ES modules)
- Storage: Cloudflare D1 (SQLite)
- Files: `src/index.js`, `src/catalog.js` (server-side catalog copy), `schema.sql`,
  `wrangler.toml.example`, `package.json`

---

## What it stores

| Table     | Columns                                    | Notes                                            |
| --------- | ------------------------------------------ | ------------------------------------------------ |
| `ballots` | `id`, `browser_id` (UNIQUE), `submitted_utc` | One row per accepted ballot. `browser_id` is a random client-generated UUID — not a person, not an email. |
| `votes`   | `id`, `ballot_id`, `product_id`, `vote`    | One row per product rating. `UNIQUE(ballot_id, product_id)`. |

The `UNIQUE` constraint on `ballots.browser_id` is what enforces
"one ballot per browser" on the server, including under concurrent requests.

Every posted `productId` is validated against `src/catalog.js`, a server-side
copy of the 60-product catalog, and every `vote` must be exactly `Like`, `Love`,
or `Don't Like`. Anything else is rejected with `400`.

---

## API

### `POST /votes`

Only accepted from an origin listed in `ALLOWED_ORIGIN`.

Request body:

```json
{
  "browserId": "3f2b1c9e-6a11-4b0d-9a3a-77d2f7b3f001",
  "votes": [
    { "productId": "P01", "vote": "Love" },
    { "productId": "P17", "vote": "Don't Like" }
  ]
}
```

Responses:

| Status | Body                                                              | Meaning                                          |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------ |
| `201`  | `{ "accepted": true, "ballotId": "...", "recorded": 2, "submittedUtc": "..." }` | Ballot stored. The client stores its vote-lock only after this. |
| `409`  | `{ "accepted": false, "error": "already_voted", "recorded": n }`   | This `browserId` already has a ballot. Nothing changed. |
| `400`  | `{ "accepted": false, "error": "unknown productId: PXX" }`        | Validation failure against the server catalog.   |
| `403`  | `{ "accepted": false, "error": "origin not allowed" }`            | Origin is not in `ALLOWED_ORIGIN`.                |
| `413` / `415` | error object                                               | Body too large / wrong `Content-Type`.            |

### `GET /admin/export.csv`

Requires the request header `X-Admin-Token: <ADMIN_TOKEN>`. Returns one row per
product vote with a UTF-8 BOM and CRLF line endings so Excel opens it cleanly:

```
ballot_id,submitted_utc,product_id,product_name,category,price,vote
```

### `GET /health`

`{ "ok": true, "products": 60 }` — quick check that the Worker and catalog loaded.

---

## Deploy

### 0. Prerequisites

- Node.js 18+
- A Cloudflare account
- `npx wrangler login` (opens a browser to authorize)

```bash
cd worker
npm install
npx wrangler login
```

### 1. Create the D1 database

```bash
npx wrangler d1 create swag_vote_2026
```

Wrangler prints a `database_id`. Copy it.

### 2. Configure wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml`:

- `database_id` → the id printed in step 1
- `ALLOWED_ORIGIN` → the exact origin of the published ballot, no trailing slash.
  For GitHub Pages this is `https://<org-or-user>.github.io` (the origin only —
  not the `/repo/` path). Add a custom domain as a second comma-separated value
  if you use one.

Do **not** put `ADMIN_TOKEN` in `wrangler.toml`. `wrangler.toml` is gitignored
here on purpose.

### 3. Create the tables

```bash
# local dev database
npm run db:init:local

# production database
npm run db:init:remote
```

(Equivalent to `npx wrangler d1 execute swag_vote_2026 --remote --file=./schema.sql`.)

### 4. Set the admin token secret

Generate a long random token and store it in your password manager, then:

```bash
openssl rand -base64 32          # copy the output
npx wrangler secret put ADMIN_TOKEN
# paste the token when prompted
```

For `wrangler dev` only, you may put it in an untracked `.dev.vars` file:

```
ADMIN_TOKEN=some-local-only-value
```

### 5. Deploy

```bash
npm run deploy
```

Wrangler prints the public URL, e.g.
`https://swag-vote-api.<your-subdomain>.workers.dev`.

### 6. Point the ballot at the Worker

Edit `../site/js/config.js`:

```js
window.SWAG_VOTE_CONFIG = {
  VOTE_API_URL: 'https://swag-vote-api.<your-subdomain>.workers.dev',
};
```

Commit and push — the GitHub Actions workflow republishes `site/` to Pages.
While `VOTE_API_URL` is blank the ballot still renders, but submitting shows a
"voting endpoint not configured" message and stores no vote-lock.

### 7. Verify end to end

```bash
curl https://swag-vote-api.<your-subdomain>.workers.dev/health

curl -i -X POST https://swag-vote-api.<your-subdomain>.workers.dev/votes \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<org-or-user>.github.io' \
  -d '{"browserId":"test-browser-0001","votes":[{"productId":"P01","vote":"Love"}]}'
# expect 201, then repeat the same command and expect 409
```

Remove the test ballot before real voting opens:

```bash
npx wrangler d1 execute swag_vote_2026 --remote \
  --command "DELETE FROM ballots WHERE browser_id = 'test-browser-0001';"
```

---

## Offline smoke test (no Cloudflare account needed)

`test/smoke.test.mjs` runs the real `src/index.js` fetch handler against a small
in-memory stand-in for the D1 binding that reproduces the UNIQUE constraints from
`schema.sql`. It needs no dependencies and no network:

```bash
cd worker
npm test        # or: node test/smoke.test.mjs
```

It asserts routing, CORS/origin enforcement, payload validation, the 201 accept
path, the 409 duplicate-browser path, admin-token protection, and the CSV header
and row shape. It is a regression guard, not a replacement for step 7's live
`wrangler dev` / deployed check against real D1.

---

## Downloading results and opening them in Excel

1. Download the CSV (replace the URL and token):

   ```bash
   curl -H "X-Admin-Token: $ADMIN_TOKEN" \
     -o swag-vote-2026-votes.csv \
     https://swag-vote-api.<your-subdomain>.workers.dev/admin/export.csv
   ```

   In PowerShell:

   ```powershell
   curl.exe -H "X-Admin-Token: $env:ADMIN_TOKEN" `
     -o swag-vote-2026-votes.csv `
     https://swag-vote-api.<your-subdomain>.workers.dev/admin/export.csv
   ```

2. Open it in Excel. Because the file carries a UTF-8 BOM you can simply
   double-click it — accented and trademarked product names render correctly.
   If your Excel is configured for a non-comma list separator, use
   **Data → From Text/CSV**, pick **Comma** as the delimiter and **65001: Unicode (UTF-8)**
   as the file origin, then **Load**.

3. Turn it into results: select the loaded range, **Insert → PivotTable**, put
   `product_name` in Rows, `vote` in Columns, and `Count of vote` in Values.
   To reproduce the project's scoring, add a helper column
   `=IF([@vote]="Love",2,IF([@vote]="Like",1,-1))` and sum it per product; rank
   with `=COUNTIF($<score-range>,">"&<score-cell>)+1` (avoids dynamic-array
   functions, per the project's Excel constraints).

4. Sanity check: `ballot_id` values should be unique per voter, and
   `SELECT COUNT(*) FROM ballots;` equals the number of distinct `ballot_id`
   values in the CSV.

---

## Honest limits of "one ballot per browser"

This design deliberately has **no login and collects no email addresses**, which
means it cannot verify who a voter is. The one-ballot rule is enforced against a
random identifier generated and stored by the browser, so it can be bypassed by:

- clearing site data / localStorage
- using a private or incognito window
- using a different browser, device, or profile
- crafting a request with a fresh `browserId` directly against the API

It is **duplicate-submission hygiene, not person-level fraud prevention**, and it
does not guarantee one vote per employee. If the vote must be attributable or
strictly one-per-person, use an authenticated path instead (for example the
Microsoft Forms + Power Automate flow already defined for this project, which
captures the signed-in voter's identity).

Because ballots are anonymous, there is also no way to let someone edit or
withdraw a ballot after it is accepted.

---

## Operational notes

- **No secrets in this repo.** `ADMIN_TOKEN` lives only in Wrangler secrets;
  `wrangler.toml`, `.dev.vars`, and `*.csv` are gitignored.
- **CORS** is restricted to `ALLOWED_ORIGIN`. A request with no matching `Origin`
  header is refused for `POST /votes`.
- **Keep the catalog in sync.** `src/catalog.js` and `../site/data/catalog.json`
  are both generated from the source workbook. If products or prices change,
  regenerate both together, or the export will show stale names and prices.
- **Rate limiting** is not implemented. If abuse is a concern, add a Cloudflare
  WAF rate-limiting rule on `POST /votes` in the dashboard.
- **Backups:** `npx wrangler d1 export swag_vote_2026 --remote --output backup.sql`.
