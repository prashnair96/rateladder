/**
 * fetch-rates.js
 * ----------------
 * Pulls the latest SSB / T-bill / bank FD rates and writes them to
 * data/rates.json in a shape the app can consume directly.
 *
 * Run weekly by .github/workflows/update-rates.yml
 *
 * ⚠️ IMPORTANT — READ BEFORE RUNNING:
 * This was written without the ability to test live network calls against
 * mas.gov.sg (only npm/GitHub domains were reachable while building it).
 * The data.gov.sg bank-rates call is against a *confirmed real* dataset ID,
 * so that part should work as-is. The SSB and T-bill sections scrape MAS's
 * public pages — you MUST run this once locally, print the raw HTML/JSON,
 * and confirm the selectors/paths below still match before trusting it.
 * MAS occasionally restructures these pages.
 */

const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "..", "data", "rates.json");

// ---- 1. Bank fixed deposit rates (confirmed working API) ----
// Dataset: "Current Banks Interest Rates (End Of Period), Monthly"
// https://data.gov.sg/datasets/d_5fe5a4bb4a1ecc4d8a56a095832e2b24/view
async function fetchBankRates() {
  const resourceId = "d_5fe5a4bb4a1ecc4d8a56a095832e2b24";
  const url = `https://data.gov.sg/api/action/datastore_search?resource_id=${resourceId}&limit=50&sort=end_of_month desc`;

  const res = await fetch(url);
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
  const res = await fetch(url);
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
  const res = await fetch(url);
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
  const results = await Promise.allSettled([
    fetchBankRates(),
    fetchSSBRates(),
    fetchTBillRates(),
  ]);

  const [bank, ssb, tbill] = results.map((r) =>
    r.status === "fulfilled" ? r.value : { error: r.reason?.message }
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    bank,
    ssb,
    tbill,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log("Wrote", OUTPUT_PATH);
  console.log(JSON.stringify(payload, null, 2));

  // Surface partial failures loudly so a bad scrape doesn't silently ship
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.error(`${failed.length} source(s) failed:`, failed.map((f) => f.reason?.message));
    process.exitCode = 1;
  }
}

main();
