/**
 * Writes site/data/closes.json: the last settled real-market close for every supported
 * ticker, plus a holiday-aware calendar of upcoming trading days.
 *
 * The hosted page can't fetch this itself - Yahoo sends no CORS headers for browser
 * origins - so this runs in CI once a day and commits the result. The page then reads
 * it same-origin and pairs it with live xStock prices from Jupiter, which does allow
 * cross-origin reads.
 *
 * Reuses the app's own referenceClose and clock modules so the site and the tool can
 * never disagree about what "Friday's close" or "a trading day" means.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const { getReferenceClose } = await import(
  path.join(root, "dist/market/referenceClose.js").replace(/\\/g, "/").replace(/^/, "file:///")
);
const { isMarketOpen } = await import(
  path.join(root, "dist/market/clock.js").replace(/\\/g, "/").replace(/^/, "file:///")
);

const { map } = readJson("data/underlying-map.json");
const { xstocks } = readJson("data/xstocks.json");
const mintOf = new Map(xstocks.map((x) => [x.ticker, x.mint]));
const decimalsOf = new Map(xstocks.map((x) => [x.ticker, x.decimals]));

const etDate = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

/** Next 28 calendar days, keeping only those the market actually trades. */
function tradingDays(from = new Date(), days = 28) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(from.getTime() + i * 86400000);
    // 17:00 UTC is mid-session in both EST (12:00) and EDT (13:00), so this probes the
    // session itself rather than an edge.
    const probe = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 17, 0, 0));
    if (isMarketOpen(probe)) out.push(etDate(probe));
  }
  return out;
}

const tickers = [];
const failures = [];

for (const [xstock, underlying] of Object.entries(map)) {
  const mint = mintOf.get(xstock);
  if (!mint) {
    failures.push(`${xstock}: no mint in data/xstocks.json`);
    continue;
  }
  try {
    const ref = await getReferenceClose(underlying);
    if (!Number.isFinite(ref.closePrice) || ref.closePrice <= 0) {
      failures.push(`${xstock}: reference close was ${ref.closePrice}`);
      continue;
    }
    tickers.push({
      xstock,
      underlying,
      mint,
      decimals: decimalsOf.get(xstock) ?? null,
      close: ref.closePrice,
      closeDate: ref.closeDate,
    });
    console.log(`ok   ${xstock.padEnd(7)} ${underlying.padEnd(6)} ${ref.closeDate}  ${ref.closePrice}`);
  } catch (err) {
    failures.push(`${xstock}: ${err?.message ?? err}`);
    console.log(`FAIL ${xstock.padEnd(7)} ${err?.message ?? err}`);
  }
}

// A partial file is worse than a stale one: the page would show a handful of tickers and
// look broken rather than simply out of date.
if (tickers.length < Object.keys(map).length / 2) {
  console.error(`\nrefusing to write: only ${tickers.length} of ${Object.keys(map).length} tickers resolved`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

tickers.sort((a, b) => a.underlying.localeCompare(b.underlying));

const payload = {
  generatedAt: new Date().toISOString(),
  source: {
    closes: "Yahoo Finance daily bars, via the app's own referenceClose module",
    livePrices: "fetched client-side from Jupiter Price API v3",
  },
  sessionHoursEt: { open: "09:30", close: "16:00" },
  tradingDays: tradingDays(),
  tickers,
};

await mkdir(path.join(root, "site/data"), { recursive: true });
await writeFile(path.join(root, "site/data/closes.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");

console.log(`\nwrote site/data/closes.json - ${tickers.length} tickers, ${payload.tradingDays.length} trading days ahead`);
if (failures.length) {
  console.log(`${failures.length} ticker(s) skipped:`);
  for (const f of failures) console.log(`  - ${f}`);
}
