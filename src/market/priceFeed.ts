import { config } from "../config.js";
import { logger } from "../logger.js";

export interface LivePrice {
  mint: string;
  usdPrice: number;
  priceChange24h: number | null;
  updatedAt: Date;
}

interface PriceV3Entry {
  usdPrice: number;
  priceChange24h?: number | null;
}

type PriceV3Response = Record<string, PriceV3Entry>;

/** Live on-chain USD price for one or more mints, from Jupiter's Price API v3. */
export async function getLivePrices(mints: string[]): Promise<Map<string, LivePrice>> {
  if (mints.length === 0) return new Map();

  const url = new URL(config.JUPITER_PRICE_BASE_URL);
  url.searchParams.set("ids", mints.join(","));

  const headers: Record<string, string> = {};
  if (config.JUPITER_API_KEY) headers["x-api-key"] = config.JUPITER_API_KEY;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Jupiter price API returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as PriceV3Response;

  const out = new Map<string, LivePrice>();
  for (const mint of mints) {
    const entry = body[mint];
    if (!entry) {
      logger.warn({ mint }, "no price returned for mint (no liquidity, or not yet indexed)");
      continue;
    }
    out.set(mint, {
      mint,
      usdPrice: entry.usdPrice,
      priceChange24h: entry.priceChange24h ?? null,
      updatedAt: new Date(),
    });
  }
  return out;
}

export async function getLivePrice(mint: string): Promise<LivePrice | undefined> {
  const map = await getLivePrices([mint]);
  return map.get(mint);
}
