import type { DailyBar } from "./referenceClose.js";

export interface HedgeEvent {
  side: "open" | "unwind";
  usdAmount: number;
  priceUsd: number;
}

/**
 * Mark-to-price P&L of a sequence of short-hedge trades: "open" short-sells
 * `usdAmount` of the xStock at `priceUsd`, "unwind" buys `usdAmount` back.
 * Cash-plus-position accounting, so any mix of opens and partial unwinds
 * values correctly without having to pair individual fills.
 */
export function hedgePnlAt(events: HedgeEvent[], markPrice: number): { pnlUsd: number; netShares: number } {
  let cash = 0;
  let shares = 0;
  for (const e of events) {
    const qty = e.usdAmount / e.priceUsd;
    if (e.side === "open") {
      cash += e.usdAmount;
      shares -= qty;
    } else {
      cash -= e.usdAmount;
      shares += qty;
    }
  }
  return { pnlUsd: cash + shares * markPrice, netShares: shares };
}

export interface PricePoint {
  ts: number;
  price: number;
}

/** Last price at or before `ts` from an ascending tape, or null if the tape starts later. */
export function priceAt(points: PricePoint[], ts: number): number | null {
  let latest: number | null = null;
  for (const point of points) {
    if (point.ts > ts) break;
    latest = point.price;
  }
  return latest;
}

export interface ReopenWindow {
  /** The session whose close started the gap. */
  closed: DailyBar & { close: number };
  /** The session whose official open ended it. */
  reopened: DailyBar & { open: number };
}

/**
 * The most recent close->open window from daily bars (oldest first) whose
 * reopen has already printed an official open. Null if the latest started
 * session hasn't printed its open yet, or there aren't two usable bars.
 */
export function pickReopenWindow(bars: DailyBar[], now: number): ReopenWindow | null {
  const started = bars.filter((b) => b.sessionStartTs <= now);
  const reopened = started[started.length - 1];
  const closed = started[started.length - 2];
  if (!reopened || !closed || reopened.open === null || closed.close === null) return null;
  return { closed: { ...closed, close: closed.close }, reopened: { ...reopened, open: reopened.open } };
}
