/**
 * Does the 24/7 xStock tape actually call the next open?
 *
 * For every close -> open window in the range, this compares:
 *   predicted = how far the xStock moved from the closing hour to just before the reopen
 *   actual    = how far the real stock gapped, prior close -> official open
 * and scores the error in percentage points. The baseline is assuming no gap at all
 * (what you're stuck with when your broker is shut), so "mean |error| vs mean |gap|"
 * is the number that says whether the tape carries real information.
 *
 *   npm run backtest                 # default tickers, 3 months
 *   npm run backtest -- QQQ SPY      # specific tickers
 */
import { getDailyBars } from "../src/market/referenceClose.js";
import { getHourlyPrices } from "../src/market/priceHistory.js";
import { priceAt } from "../src/market/reconcileMath.js";
import { resolveTicker } from "../src/xstocks/resolver.js";
import { resolveXStockFor } from "../src/xstocks/underlying.js";

const REGULAR_SESSION_MS = 6.5 * 60 * 60 * 1000;
const RANGE = process.env.BACKTEST_RANGE ?? "3mo";
const tickers = process.argv.slice(2).length > 0 ? process.argv.slice(2).map((t) => t.toUpperCase()) : ["QQQ", "SPY", "NVDA", "TSLA"];

const pctChange = (from: number, to: number) => ((to - from) / from) * 100;
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
};

interface WindowResult {
  closeDate: string;
  reopenDate: string;
  spanHours: number;
  actualGapPct: number;
  predictedGapPct: number;
  errorPp: number;
  basisPct: number;
}

async function backtest(underlying: string): Promise<WindowResult[]> {
  const xstockTicker = resolveXStockFor(underlying);
  const xstock = xstockTicker ? resolveTicker(xstockTicker) : undefined;
  if (!xstock) throw new Error(`no verified xStock for ${underlying}`);

  const bars = (await getDailyBars(underlying, RANGE)).filter((b) => b.open !== null && b.close !== null);
  const results: WindowResult[] = [];

  for (let i = 1; i < bars.length; i++) {
    const closed = bars[i - 1];
    const reopened = bars[i];
    if (!closed?.close || !reopened?.open) continue;

    const closeTs = closed.sessionStartTs + REGULAR_SESSION_MS;
    const reopenTs = reopened.sessionStartTs;
    const tape = await getHourlyPrices(xstock.mint, closeTs, reopenTs);
    const atClose = priceAt(tape, closeTs) ?? tape[0]?.price;
    const last = tape.at(-1);
    // Need a tape that actually spans the window, not one stray candle.
    if (!atClose || !last || tape.length < 3) continue;

    const actualGapPct = pctChange(closed.close, reopened.open);
    const predictedGapPct = pctChange(atClose, last.price);
    results.push({
      closeDate: closed.date,
      reopenDate: reopened.date,
      spanHours: (reopenTs - closeTs) / 3_600_000,
      actualGapPct,
      predictedGapPct,
      errorPp: predictedGapPct - actualGapPct,
      basisPct: pctChange(closed.close, atClose),
    });
  }
  return results;
}

function report(underlying: string, rows: WindowResult[]): void {
  if (rows.length === 0) {
    console.log(`\n${underlying}: no usable windows`);
    return;
  }
  const errors = rows.map((r) => Math.abs(r.errorPp));
  const gaps = rows.map((r) => Math.abs(r.actualGapPct));
  // Only score direction where the real move was big enough for direction to mean anything.
  const directional = rows.filter((r) => Math.abs(r.actualGapPct) >= 0.1);
  const hits = directional.filter((r) => Math.sign(r.predictedGapPct) === Math.sign(r.actualGapPct)).length;
  const weekends = rows.filter((r) => r.spanHours > 48);

  console.log(`\n=== ${underlying} — ${rows.length} windows (${weekends.length} weekend/holiday) ===`);
  console.log("  close date   reopen      span   predicted     actual      error");
  for (const r of rows.slice(-10)) {
    console.log(
      `  ${r.closeDate}   ${r.reopenDate}  ${String(Math.round(r.spanHours)).padStart(3)}h  ` +
        `${r.predictedGapPct.toFixed(2).padStart(8)}%  ${r.actualGapPct.toFixed(2).padStart(8)}%  ${r.errorPp.toFixed(2).padStart(7)}pp`
    );
  }
  console.log(
    `  mean |error| ${mean(errors).toFixed(2)}pp | median ${median(errors).toFixed(2)}pp | ` +
      `baseline (assume no gap) ${mean(gaps).toFixed(2)}pp | direction ${hits}/${directional.length} | mean basis ${mean(
        rows.map((r) => r.basisPct)
      ).toFixed(2)}%`
  );
}

const all: WindowResult[] = [];
for (const ticker of tickers) {
  try {
    const rows = await backtest(ticker);
    report(ticker, rows);
    all.push(...rows);
  } catch (err) {
    console.log(`\n${ticker}: ${err instanceof Error ? err.message : err}`);
  }
}

if (all.length > 0) {
  const errors = all.map((r) => Math.abs(r.errorPp));
  const gaps = all.map((r) => Math.abs(r.actualGapPct));
  const directional = all.filter((r) => Math.abs(r.actualGapPct) >= 0.1);
  const hits = directional.filter((r) => Math.sign(r.predictedGapPct) === Math.sign(r.actualGapPct)).length;
  console.log(
    `\n=== ALL: ${all.length} windows | mean |error| ${mean(errors).toFixed(2)}pp vs ${mean(gaps).toFixed(2)}pp baseline | ` +
      `direction ${hits}/${directional.length} (${((hits / Math.max(1, directional.length)) * 100).toFixed(0)}%) ===`
  );
}
