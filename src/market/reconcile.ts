import { insertBackfilledSnapshots, listHedgeFillsBetween, listHoldings, listLivePricesBetween } from "../portfolio/db.js";
import { logger } from "../logger.js";
import { resolveTicker } from "../xstocks/resolver.js";
import { resolveUnderlying } from "../xstocks/underlying.js";
import { getDailyBars } from "./referenceClose.js";
import { getHourlyPrices } from "./priceHistory.js";
import { hedgePnlAt, pickReopenWindow, priceAt, type PricePoint } from "./reconcileMath.js";

const REGULAR_SESSION_MS = 6.5 * 60 * 60 * 1000;

function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

export interface Reconciliation {
  xstockTicker: string;
  underlyingTicker: string;
  closeDate: string;
  reopenDate: string;
  priorClose: number;
  realOpen: number;
  actualGapPct: number;
  shares: number;
  /** What the real position gained/lost between the close and the reopen - the move the broker couldn't act on. */
  exposureChangeUsd: number;
  /** Last xStock price recorded before the reopen. */
  lastXStockPrice: number | null;
  /**
   * How far the xStock moved while the market was closed, measured from its own price at the
   * close. Compared against the real gap this is basis-free: xStocks trade at a small persistent
   * premium/discount to the underlying, so comparing raw price levels would bake that in.
   */
  predictedGapPct: number | null;
  /** predictedGapPct - actualGapPct, in percentage points. */
  predictionErrorPp: number | null;
  /** xStock price at the close vs the real close, i.e. the premium the token carries. */
  basisPct: number | null;
  /** Largest move away from the xStock's close price while shut, and when. */
  peakMovePct: number | null;
  peakMoveTs: number | null;
  /** True when the tape came from DEX history rather than the monitor's own polls. */
  pricesBackfilled: boolean;
  hedgeCount: number;
  /** Hedges placed from the closed session's start up to the reopen, marked at the official open. */
  hedgePnlUsd: number;
  netChangeUsd: number;
  simulated: boolean;
}

/**
 * What happened across the most recent close->open window for one holding: how far the
 * real stock gapped, how well the 24/7 xStock tape called it, and what any hedges were
 * worth at the official open. Uses current share counts, not a historical snapshot.
 *
 * If the monitor wasn't running for that window, the tape is backfilled from DEX history
 * once and stored, so the report works without days of prior uptime.
 */
export async function reconcile(xstockTicker: string, now = Date.now()): Promise<Reconciliation> {
  const underlyingTicker = resolveUnderlying(xstockTicker);
  if (!underlyingTicker) throw new Error(`${xstockTicker} has no verified real-market mapping`);

  const window = pickReopenWindow(await getDailyBars(underlyingTicker), now);
  if (!window) throw new Error(`${underlyingTicker}: the latest session's official open hasn't printed yet`);
  const { closed, reopened } = window;
  const closeTs = closed.sessionStartTs + REGULAR_SESSION_MS;
  const reopenTs = reopened.sessionStartTs;

  let tape: PricePoint[] = listLivePricesBetween(xstockTicker, closeTs, reopenTs).map((row) => ({
    ts: row.ts,
    price: row.livePrice,
  }));
  let pricesBackfilled = false;

  if (tape.length === 0) {
    const xstock = resolveTicker(xstockTicker);
    if (xstock) {
      try {
        const history = await getHourlyPrices(xstock.mint, closeTs, reopenTs);
        if (history.length > 0) {
          insertBackfilledSnapshots(xstockTicker, closed.close, history);
          tape = history;
          pricesBackfilled = true;
        }
      } catch (err) {
        logger.warn({ err, xstockTicker }, "could not backfill xStock price history");
      }
    }
  }

  const shares = listHoldings()
    .filter((h) => h.xstockTicker === xstockTicker)
    .reduce((sum, h) => sum + h.shares, 0);

  const atClose = priceAt(tape, closeTs) ?? tape[0]?.price ?? null;
  const last = tape.at(-1);
  const actualGapPct = pctChange(closed.close, reopened.open);
  const predictedGapPct = atClose !== null && last ? pctChange(atClose, last.price) : null;

  let peak: { movePct: number; ts: number } | null = null;
  if (atClose !== null) {
    for (const point of tape) {
      const movePct = pctChange(atClose, point.price);
      if (!peak || Math.abs(movePct) > Math.abs(peak.movePct)) peak = { movePct, ts: point.ts };
    }
  }

  const hedges = listHedgeFillsBetween(xstockTicker, closed.sessionStartTs, reopenTs);
  const hedgePnlUsd = hedgePnlAt(hedges, reopened.open).pnlUsd;
  const exposureChangeUsd = shares * (reopened.open - closed.close);

  return {
    xstockTicker,
    underlyingTicker,
    closeDate: closed.date,
    reopenDate: reopened.date,
    priorClose: closed.close,
    realOpen: reopened.open,
    actualGapPct,
    shares,
    exposureChangeUsd,
    lastXStockPrice: last?.price ?? null,
    predictedGapPct,
    predictionErrorPp: predictedGapPct === null ? null : predictedGapPct - actualGapPct,
    basisPct: atClose === null ? null : pctChange(closed.close, atClose),
    peakMovePct: peak?.movePct ?? null,
    peakMoveTs: peak?.ts ?? null,
    pricesBackfilled,
    hedgeCount: hedges.length,
    hedgePnlUsd,
    netChangeUsd: exposureChangeUsd + hedgePnlUsd,
    simulated: hedges.some((h) => h.status === "dry-run"),
  };
}
