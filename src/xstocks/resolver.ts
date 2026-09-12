import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const xstockEntrySchema = z.object({
  ticker: z.string(),
  mint: z.string(),
  decimals: z.number().int().nonnegative(),
  issuer: z.string(),
  stonkfunEligible: z.boolean().default(false),
});

const xstocksFileSchema = z.object({
  xstocks: z.array(xstockEntrySchema),
});

export type XStockEntry = z.infer<typeof xstockEntrySchema>;

let cachedRegistry: Map<string, XStockEntry> | null = null;

/**
 * Loads the ticker -> xStock mint registry from data/xstocks.json (copied from
 * stonkfun-companion's Phase 0 findings - sourced live from StonkFun's own
 * GET /pairs on 2026-09-09). Re-fetch periodically rather than treating this
 * as permanently authoritative; never hand-add entries by guessing a mint.
 */
function loadRegistry(): Map<string, XStockEntry> {
  if (cachedRegistry) return cachedRegistry;

  const raw = readFileSync(join(__dirname, "..", "..", "data", "xstocks.json"), "utf-8");
  const parsed = xstocksFileSchema.parse(JSON.parse(raw));

  cachedRegistry = new Map(parsed.xstocks.map((e) => [e.ticker.toUpperCase(), e]));
  if (cachedRegistry.size === 0) {
    logger.warn("xstocks registry is empty - populate data/xstocks.json before use");
  }
  return cachedRegistry;
}

export function resolveTicker(ticker: string): XStockEntry | undefined {
  return loadRegistry().get(ticker.toUpperCase());
}

export function resolveMint(mint: string): XStockEntry | undefined {
  for (const entry of loadRegistry().values()) {
    if (entry.mint === mint) return entry;
  }
  return undefined;
}

export function listTickers(): string[] {
  return [...loadRegistry().values()].map((e) => e.ticker);
}

/** Clears the in-memory cache - test-only, so a test can swap in fixture data. */
export function _resetRegistryCache(): void {
  cachedRegistry = null;
}
