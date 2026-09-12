import { logger } from "../logger.js";
import type { PricePoint } from "./reconcileMath.js";

const GECKOTERMINAL = "https://api.geckoterminal.com/api/v2";
const HEADERS = { Accept: "application/json;version=20230302" };
const MAX_PAGES = 6; // 1000 hourly candles per page, so up to ~8 months
// The free tier allows roughly 30 requests a minute and answers 429 past that, so requests are
// serialized and spaced rather than burst - a backtest would otherwise trip it immediately.
const MIN_REQUEST_INTERVAL_MS = 2200;
const MAX_RETRIES = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

async function requestJson(url: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) return (await res.json()) as Record<string, unknown>;

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000 * (attempt + 1);
      logger.debug({ url, attempt, backoffMs }, "GeckoTerminal rate-limited, backing off");
      await sleep(backoffMs);
      continue;
    }
    throw new Error(`GeckoTerminal returned ${res.status} for ${url}`);
  }
}

/** Queues every call so concurrent callers can't burst past the rate limit. */
function fetchJson(url: string): Promise<Record<string, unknown>> {
  const result = queue.then(
    () => requestJson(url),
    () => requestJson(url)
  );
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

interface PoolTape {
  poolAddress: string;
  /** Newest first, as the API returns them. */
  candles: PricePoint[];
}

const tapes = new Map<string, PoolTape>();

/** The deepest pool for a mint - its tape is the best single-venue proxy for the xStock's price. */
async function deepestPool(mint: string): Promise<string> {
  const body = await fetchJson(`${GECKOTERMINAL}/networks/solana/tokens/${mint}/pools?page=1`);
  const pools = (body.data ?? []) as Array<{ attributes?: { address?: string; reserve_in_usd?: string } }>;
  const best = pools
    .map((p) => ({ address: p.attributes?.address, liquidity: Number(p.attributes?.reserve_in_usd ?? 0) }))
    .filter((p): p is { address: string; liquidity: number } => typeof p.address === "string")
    .sort((a, b) => b.liquidity - a.liquidity)[0];
  if (!best) throw new Error(`no DEX pools found for mint ${mint}`);
  return best.address;
}

/**
 * Hourly xStock prices from its deepest DEX pool, ascending, covering [fromTs, toTs]
 * where history exists. This is the off-hours tape the monitor would have recorded had
 * it been running, so reports and backtests work without days of uptime first.
 *
 * It's one pool's price where the live path uses Jupiter's aggregate - close, but not
 * identical, so treat it as the tape's shape rather than an exact fill price.
 */
export async function getHourlyPrices(mint: string, fromTs: number, toTs: number): Promise<PricePoint[]> {
  let tape = tapes.get(mint);
  if (!tape) {
    tape = { poolAddress: await deepestPool(mint), candles: [] };
    tapes.set(mint, tape);
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const oldest = tape.candles.at(-1)?.ts;
    if (oldest !== undefined && oldest <= fromTs) break;

    const before = oldest === undefined ? "" : `&before_timestamp=${Math.floor(oldest / 1000)}`;
    const body = await fetchJson(
      `${GECKOTERMINAL}/networks/solana/pools/${tape.poolAddress}/ohlcv/hour?aggregate=1&limit=1000&currency=usd${before}`
    );
    const attributes = (body.data as { attributes?: { ohlcv_list?: number[][] } } | undefined)?.attributes;
    const list = attributes?.ohlcv_list ?? [];
    if (list.length === 0) break;

    for (const candle of list) {
      const ts = candle[0];
      const close = candle[4];
      if (ts === undefined || close === undefined) continue;
      tape.candles.push({ ts: ts * 1000, price: close });
    }
  }

  const window = tape.candles.filter((p) => p.ts >= fromTs && p.ts <= toTs).sort((a, b) => a.ts - b.ts);
  logger.debug({ mint, from: fromTs, to: toTs, points: window.length }, "fetched xStock price history");
  return window;
}
