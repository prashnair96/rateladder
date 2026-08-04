# RateLadder — data pipeline

Fetches SG SSB / T-bill / bank FD rates weekly and commits them as static
JSON, so the app never needs a paid backend.

## How it works

1. `.github/workflows/update-rates.yml` runs every Monday (and on-demand via
   the Actions tab → "Update rates" → "Run workflow").
2. It runs `scripts/fetch-rates.js`, which fetches from MAS/data.gov.sg and
   writes `data/rates.json`.
3. If the file changed, it's committed back to the repo automatically.
4. Your app fetches the live file from:
   `https://raw.githubusercontent.com/<your-username>/<your-repo>/main/data/rates.json`

## Before you rely on this — verify the scraper

I wrote `fetch-rates.js` without the ability to test live calls to
`mas.gov.sg` in the environment I built it in. Do this once before turning
on the schedule:

```bash
npm install    # nothing to install yet, but keeps the habit
node scripts/fetch-rates.js
```

Then check the printed output:

- **Bank rates** — this hits a *confirmed real* data.gov.sg dataset, so it
  should return real records. Check the `raw` field in the output to see
  the actual field names data.gov.sg uses, then update the mapping in
  `fetchBankRates()` to use the real keys instead of the guessed ones.
- **SSB / T-bill rates** — these scrape MAS's HTML pages with regex, which
  is fragile by nature. Open the source URLs in a browser, view page
  source (or devtools → Network tab, since some MAS pages load data via a
  background request — if you find one, call that directly instead of
  scraping HTML, it'll be far more reliable), and adjust the regexes in
  `fetchSSBRates()` / `fetchTBillRates()` to match what's actually there.

## Setup

1. Create a new GitHub repo, push this folder to it.
2. In repo Settings → Actions → General → Workflow permissions, select
   "Read and write permissions" (needed for the bot to commit `rates.json`).
3. Run the workflow once manually (Actions tab → Update rates → Run
   workflow) and confirm `data/rates.json` updates correctly.
4. Point the app (see `/app` folder) at your repo's raw JSON URL.

## Why this architecture

- **No server to pay for or maintain** — GitHub Actions' free tier easily
  covers a once-a-week job.
- **Auditable** — every rate update is a git commit, so you (and users, if
  you ever open-source it) can see exactly when and how numbers changed.
- **Resilient** — if a source fails, `Promise.allSettled` means the other
  two still update, and the failure is logged loudly rather than silently
  shipping bad data.
