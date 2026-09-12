import { resolveTicker } from "../xstocks/resolver.js";
import { resolveUnderlying } from "../xstocks/underlying.js";
import { getLivePrice } from "./priceFeed.js";
import { getReferenceClose } from "./referenceClose.js";
import { isMarketOpen } from "./clock.js";

export interface GapReading {
  xstockTicker: string;
  underlyingTicker: string;
  livePrice: number;
  referenceClose: number;
  referenceCloseDate: string;
  /** (livePrice - referenceClose) / referenceClose * 100 - positive means the xStock has run up since the real market's last close. */
  gapPct: number;
  marketOpen: boolean;
}

export class UnsupportedTickerError extends Error {}

/**
 * The core signal: how far has the 24/7 xStock price drifted from the real
 * market's last settled close, and is the real market even open right now
 * to do anything about it.
 */
export async function getGapReading(xstockTicker: string): Promise<GapReading> {
  const ticker = xstockTicker.toUpperCase();
  const xstock = resolveTicker(ticker);
  if (!xstock) throw new UnsupportedTickerError(`unknown xStock ticker: ${ticker}`);

  const underlyingTicker = resolveUnderlying(ticker);
  if (!underlyingTicker) {
    throw new UnsupportedTickerError(`${ticker} has no verified real-market mapping - see data/underlying-map.json`);
  }

  const [live, ref] = await Promise.all([getLivePrice(xstock.mint), getReferenceClose(underlyingTicker)]);
  if (!live) throw new Error(`no live price available for ${ticker} (mint ${xstock.mint})`);

  const gapPct = ((live.usdPrice - ref.closePrice) / ref.closePrice) * 100;

  return {
    xstockTicker: ticker,
    underlyingTicker,
    livePrice: live.usdPrice,
    referenceClose: ref.closePrice,
    referenceCloseDate: ref.closeDate,
    gapPct,
    marketOpen: isMarketOpen(),
  };
}
