import { logger } from "../logger.js";
import { isMarketOpen } from "./clock.js";

export interface ReferenceClose {
  ticker: string;
  closePrice: number;
  /** Trading-session date (YYYY-MM-DD, America/New_York) this price belongs to. */
  closeDate: string;
  fetchedAt: Date;
}

export interface DailyBar {
  /** Session date, YYYY-MM-DD in America/New_York. */
  date: string;
  /** Session start (09:30 ET) as epoch ms - Yahoo stamps daily bars at the open. */
  sessionStartTs: number;
  open: number | null;
  close: number | null;
}

const CHART_BASE_URL = "https://query2.finance.yahoo.com/v8/finance/chart";
const CACHE_TTL_MS = 15 * 60 * 1000; // a settled daily close doesn't change more often than this

interface CacheEntry {
  value: ReferenceClose;
  marketOpenAtFetch: boolean;
}

const cache = new Map<string, CacheEntry>();

// en-CA happens to format as YYYY-MM-DD, which saves manually assembling the string.
const nyDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

interface YahooChartResult {
  meta: { regularMarketPrice?: number; regularMarketTime?: number };
  timestamp?: number[];
  indicators?: { quote?: Array<{ open?: Array<number | null>; close?: Array<number | null> }> };
}

interface YahooChartResponse {
  chart: {
    result?: YahooChartResult[];
    error?: { code: string; description: string } | null;
  };
}

async function fetchDailyChart(ticker: string, range: string): Promise<YahooChartResult> {
  const url = new URL(`${CHART_BASE_URL}/${encodeURIComponent(ticker)}`);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("range", range);

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; GapGuard/0.1)" } });
  if (!res.ok) {
    throw new Error(`Yahoo Finance chart API returned ${res.status} for ${ticker}`);
  }
  const body = (await res.json()) as YahooChartResponse;
  const result = body.chart.result?.[0];
  if (body.chart.error || !result) {
    throw new Error(`Yahoo Finance has no data for ${ticker}: ${JSON.stringify(body.chart.error ?? "empty result")}`);
  }
  return result;
}

/**
 * Most recent regular-session price for a real, publicly-listed US ticker,
 * from Yahoo Finance's unofficial (but free, no-key) chart endpoint. This is
 * the "what your broker still thinks it's worth" anchor Gap Guard compares
 * the live 24/7 xStock price against.
 *
 * `regularMarketPrice` tracks the last regular-session trade: while the real
 * market is open that's the live price, while it's closed that's the settled
 * close of the most recent session.
 */
export async function getReferenceClose(ticker: string): Promise<ReferenceClose> {
  const marketOpen = isMarketOpen();
  const cached = cache.get(ticker);
  // A price cached while open is intraday, not a close - never carry it across the open/closed boundary.
  if (
    cached &&
    cached.marketOpenAtFetch === marketOpen &&
    Date.now() - cached.value.fetchedAt.getTime() < CACHE_TTL_MS
  ) {
    return cached.value;
  }

  const result = await fetchDailyChart(ticker, "5d");
  const price = result.meta.regularMarketPrice;
  const timeSec = result.meta.regularMarketTime;
  if (price === undefined || timeSec === undefined) {
    throw new Error(`Yahoo Finance returned no regular-market price for ${ticker}`);
  }

  const value: ReferenceClose = {
    ticker,
    closePrice: price,
    closeDate: nyDateFormatter.format(new Date(timeSec * 1000)),
    fetchedAt: new Date(),
  };
  cache.set(ticker, { value, marketOpenAtFetch: marketOpen });
  logger.debug({ ticker, value }, "fetched reference close");
  return value;
}

/**
 * Official daily open/close per session, oldest first. The newest bar's
 * close is still moving while that session is open; its open is final once
 * printed.
 */
export async function getDailyBars(ticker: string, range = "10d"): Promise<DailyBar[]> {
  const result = await fetchDailyChart(ticker, range);
  const quote = result.indicators?.quote?.[0];
  return (result.timestamp ?? []).map((t, i) => ({
    date: nyDateFormatter.format(new Date(t * 1000)),
    sessionStartTs: t * 1000,
    open: quote?.open?.[i] ?? null,
    close: quote?.close?.[i] ?? null,
  }));
}
