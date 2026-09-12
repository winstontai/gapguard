import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fileSchema = z.object({ map: z.record(z.string(), z.string()) });

let cached: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (cached) return cached;
  const raw = readFileSync(join(__dirname, "..", "..", "data", "underlying-map.json"), "utf-8");
  const parsed = fileSchema.parse(JSON.parse(raw));
  cached = new Map(Object.entries(parsed.map));
  return cached;
}

/**
 * Real, publicly-listed ticker (e.g. "AAPL") for an xStock ticker (e.g.
 * "APPLX"), or undefined if we don't have a confidently-verified mapping.
 * Callers MUST treat undefined as "cannot compute a gap for this one" rather
 * than falling back to a guess - see data/underlying-map.json's _comment.
 */
export function resolveUnderlying(xstockTicker: string): string | undefined {
  return load().get(xstockTicker.toUpperCase());
}

export function listMappedXStockTickers(): string[] {
  return [...load().keys()];
}

/** Real tickers a user can add as holdings (e.g. "AAPL") - not the xStock symbols like "APPLX". */
export function listSupportedUnderlyingTickers(): string[] {
  return [...load().values()];
}

let reverseCached: Map<string, string> | null = null;

/** xStock ticker (e.g. "APPLX") for a real underlying ticker (e.g. "AAPL"), if mapped. */
export function resolveXStockFor(underlyingTicker: string): string | undefined {
  if (!reverseCached) {
    reverseCached = new Map([...load().entries()].map(([xstock, underlying]) => [underlying, xstock]));
  }
  return reverseCached.get(underlyingTicker.toUpperCase());
}
