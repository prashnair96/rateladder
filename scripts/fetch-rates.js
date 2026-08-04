/**
 * fetch-rates.js
 * ----------------
 * Pulls the latest SSB / T-bill / bank FD rates and writes them to
 * data/rates.json in a shape the app can consume directly.
 *
 * Run weekly by .github/workflows/update-rates.yml
 *
 * ⚠️ IMPORTANT — READ BEFORE RUNNING:
 * Confirmed as of the first real run: MAS's own pages (mas.gov.sg and
 * eservices.mas.gov.sg) actively block automated/bot-like requests. The
 * bank-rates call (data.gov.sg) works fine — it's a proper public API.
 * The SSB/T-bill scrapers may keep failing no matter how the headers are
 * tuned, if MAS is running real bot-detection (e.g. Cloudflare). This
 * script now falls back to the last-known-good value instead of writing
 * null when a source fails, and flags stale entries with `_stale: true`
 * so the app can show "may be outdated" instead of a wrong number.
 *
 * If SSB/T-bill scraping keeps failing after you've tried adjusting
 * headers/selectors, the honest fallback is: update data/rates.json by
 * hand once a month when a new SSB is announced (takes under a minute —
 * see README "Manual update" section). SSB rates only change monthly
 * anyway, so this isn't as bad a compromise as it sounds.
 */

const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "..", "data", "rates.json");

// A realistic browser-like header set. This does NOT reliably beat proper
// bot-detection (e.g. Cloudflare challenges), but it fixes the common case
// where a site rejects requests purely for looking like a bare script.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-SG,en;q=0.9",
};

// Loads the previously-committed rates.json (if any) so a failed fetch
// can fall back to the last known-good value instead of writing null and
// clobbering a perfectly good number.
function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

// ---- 1. Bank fixed deposit rates (confirmed working API) ----
// Dataset: "Current Banks Interest Rates (End Of Period), Monthly"
// https://data.gov.sg/datasets/d_5fe5a4bb4a1ecc4d8a56a095832e2b24/view
async function fetchBankRates() {
  const resourceId = "d_5fe5a4bb4a1ecc4d8a56a095832e2b24";
  // IMPORTANT: build the query string properly instead of interpolating
  // raw text with a space in it — that literal space in the old version
  // is what caused the 409 you saw.
  const params = new URLSearchParams({
    resource_id: resourceId,
    limit: "50",
    sort: "end_of_month desc",
  });
  const url = `https://data.gov.sg/api/action/datastore_search?${params.toString()}`;

  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Bank rates fetch failed: ${res.status}`);
  const json = await res.json();
  const records = json.result?.records ?? [];

  // TODO: once you've printed `records[0]` and confirmed the real field
  // names, map them properly. This is a best-guess mapping based on
  // SingStat's typical column naming (verify against actual response).
  const latest = records[0] || {};
  return {
    fd12: parseFloat(latest.fixed_deposit_12_months ?? latest["12_months"] ?? NaN),
    fd3: parseFloat(latest.fixed_deposit_3_months ?? latest["3_months"] ?? NaN),
    asOf: latest.end_of_month ?? null,
    raw: latest, // keep raw record around for debugging until mapping is confirmed
  };
}

// ---- 2. Singapore Savings Bonds ----
// Source page: https://www.mas.gov.sg/bonds-and-bills/savings-bonds-statistics
// MAS also exposes issue-specific SSB data for download (check the page for
// a direct CSV/XLSX link — that will be far more reliable than scraping
// rendered HTML, which can break silently if MAS changes their frontend).
async function fetchSSBRates() {
  const url = "https://www.mas.gov.sg/bonds-and-bills/savings-bonds-statistics";
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`SSB page fetch failed: ${res.status}`);
  const html = await res.text();

  // PLACEHOLDER PARSING — replace with a real selector once you've
  // inspected the page. Look for the current issue code (e.g. "SBJUL26")
  // and its Year 1 / 10-year average rates.
  const codeMatch = html.match(/SB[A-Z]{3}\d{2}/);
  const year1Match = html.match(/Year\s*1[^%]*?([\d.]+)\s*%/i);
  const avg10Match = html.match(/10[- ]year average[^%]*?([\d.]+)\s*%/i);

  return {
    code: codeMatch ? codeMatch[0] : null,
    rate1y: year1Match ? parseFloat(year1Match[1]) : null,
    rate10y: avg10Match ? parseFloat(avg10Match[1]) : null,
  };
}

// ---- 3. T-bill auction results ----
// Source: https://eservices.mas.gov.sg/statistics/fdanet/BondPricesAndYields.aspx
// This page may render via JS or require form params for the auction
// calendar — inspect network requests in a browser devtools "Network" tab
// while the page loads to find the underlying data endpoint, which is
// almost always cleaner to call directly than scraping rendered HTML.
async function fetchTBillRates() {
  const url = "https://eservices.mas.gov.sg/statistics/fdanet/BondPricesAndYields.aspx";
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`T-bill page fetch failed: ${res.status}`);
  const html = await res.text();

  // PLACEHOLDER — same caveat as above, confirm against real markup.
  const sixMonthMatch = html.match(/6[- ]?month[^%]*?([\d.]+)\s*%/i);
  const oneYearMatch = html.match(/1[- ]?year[^%]*?([\d.]+)\s*%/i);

  return {
    rate6m: sixMonthMatch ? parseFloat(sixMonthMatch[1]) : null,
    rate1y: oneYearMatch ? parseFloat(oneYearMatch[1]) : null,
  };
}

async function main() {
  const previous = loadPrevious();
  const results = await Promise.allSettled([
    fetchBankRates(),
    fetchSSBRates(),
    fetchTBillRates(),
  ]);

  const keys = ["bank", "ssb", "tbill"];
  const payload = { generatedAt: new Date().toISOString() };
  const problems = [];

  results.forEach((r, i) => {
    const key = keys[i];
    if (r.status === "fulfilled") {
      // Even a "successful" fetch can come back with all-null fields if a
      // page loaded but the regex found nothing — treat that as a soft
      // failure too, not a real update.
      const gotRealData = Object.values(r.value).some(
        (v) => typeof v === "number" && !isNaN(v)
      );
      if (gotRealData) {
        payload[key] = r.value;
      } else {
        problems.push(`${key}: fetched OK but parsed no usable numbers (site structure likely changed, or blocked)`);
        payload[key] = previous?.[key] ?? r.value;
        payload[key]._stale = true;
      }
    } else {
      problems.push(`${key}: ${r.reason?.message}`);
      payload[key] = previous?.[key] ?? { error: r.reason?.message };
      if (previous?.[key]) payload[key]._stale = true;
    }
  });

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log("Wrote", OUTPUT_PATH);
  console.log(JSON.stringify(payload, null, 2));

  if (problems.length) {
    console.warn(`${problems.length} source(s) had issues (kept last-known-good value where possible):`);
    problems.forEach((p) => console.warn("  -", p));
    // Only hard-fail the workflow if we had NO previous data to fall back
    // on for a source — otherwise this would fail every single week even
    // though the app is still serving a reasonable (if stale) number.
    const noFallbackAvailable = keys.some((k) => payload[k]?.error);
    if (noFallbackAvailable) process.exitCode = 1;
  }
}

main();
