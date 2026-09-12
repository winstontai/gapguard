import { getLastHedgeTs, getRollingHedgeUsd } from "../portfolio/db.js";
import type { Settings } from "../settings.js";
import { logger } from "../logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class RiskLimitError extends Error {}

export interface HedgeRequest {
  /** USD notional this hedge would move, not a SOL amount - sizing is off real dollar stock exposure. */
  usdAmount: number;
  ticker: string;
  triggeredBy: string;
}

/**
 * The single choke point every hedge call MUST pass through before building a
 * transaction. Settings only supply the *values* of the limits; this function
 * is what actually refuses the spend, so a config edit alone can never bypass
 * enforcement (bypassing it requires editing this code).
 */
export function assertHedgeAllowed(req: HedgeRequest, settings: Settings, now = Date.now()): void {
  if (settings.paused) {
    throw new RiskLimitError("hedging is paused (kill switch active)");
  }

  if (req.usdAmount <= 0) {
    throw new RiskLimitError(`invalid hedge amount: ${req.usdAmount}`);
  }

  if (req.usdAmount > settings.maxUsdPerHedge) {
    throw new RiskLimitError(`requested $${req.usdAmount} exceeds per-hedge cap of $${settings.maxUsdPerHedge}`);
  }

  const lastHedgeTs = getLastHedgeTs();
  if (lastHedgeTs !== null) {
    const secondsSinceLastHedge = (now - lastHedgeTs) / 1000;
    if (secondsSinceLastHedge < settings.minSecondsBetweenHedges) {
      throw new RiskLimitError(
        `only ${secondsSinceLastHedge.toFixed(1)}s since last hedge, minimum interval is ${settings.minSecondsBetweenHedges}s`
      );
    }
  }

  const rollingUsd = getRollingHedgeUsd(DAY_MS, now);
  if (rollingUsd + req.usdAmount > settings.maxDailyUsd) {
    throw new RiskLimitError(
      `hedge of $${req.usdAmount} would exceed daily cap: $${rollingUsd.toFixed(2)} already hedged in trailing 24h, cap is $${settings.maxDailyUsd}`
    );
  }

  logger.info({ req, rollingUsd }, "hedge allowed");
}

/** Closing a short only reduces risk, so spending caps don't apply - but the kill switch still stops all signing. */
export function assertUnwindAllowed(settings: Settings): void {
  if (settings.paused) {
    throw new RiskLimitError("hedging is paused (kill switch active)");
  }
}

/** Ceiling independent of config: a short opened above this LTV could be liquidated by the very gap it's hedging. */
export const MAX_HEDGE_LTV = 0.6;

export function assertLtvAllowed(projectedLtv: number): void {
  if (!(projectedLtv <= MAX_HEDGE_LTV)) {
    throw new RiskLimitError(
      `projected LTV ${(projectedLtv * 100).toFixed(1)}% exceeds the ${(MAX_HEDGE_LTV * 100).toFixed(0)}% ceiling`
    );
  }
}
