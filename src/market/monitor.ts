import { listHoldings, insertGapSnapshot } from "../portfolio/db.js";
import { getGapReading } from "./gap.js";
import { getMarketState, formatCountdown } from "./clock.js";
import { reconcile } from "./reconcile.js";
import { notifyOwner } from "../telegram/bot.js";
import { formatReconciliation, pct, usd } from "../telegram/format.js";
import { logger } from "../logger.js";
import type { SettingsStore } from "../settings.js";
import { config } from "../config.js";

// The official open can take a few minutes to appear, and Yahoo occasionally rate-limits.
const REPORT_ATTEMPTS = 30;

/**
 * Polls every tracked holding on an interval. Each tick records a price
 * snapshot (the raw material for /report); while the real market is closed it
 * alerts once per ticker per closed session when the gap crosses the
 * threshold. On the closed -> open transition it resets that cooldown and
 * pushes the reconciliation report as soon as the official open has printed.
 */
export function startGapMonitor(settingsStore: SettingsStore): () => void {
  const intervalMs = config.GAP_POLL_INTERVAL_SECONDS * 1000;
  const alertedThisClosedSession = new Set<string>();
  let wasOpen: boolean | null = null;
  let reportAttemptsLeft = 0;

  async function tick(): Promise<void> {
    const market = getMarketState();
    if (wasOpen === false && market.isOpen) {
      alertedThisClosedSession.clear();
      reportAttemptsLeft = REPORT_ATTEMPTS;
      logger.info("market reopened - alert cooldown reset, reconciliation report queued");
    }
    wasOpen = market.isOpen;

    const tickers = [...new Set(listHoldings().map((h) => h.xstockTicker))];
    const threshold = settingsStore.get().gapAlertThresholdPct;

    // Per-ticker try/catch: one ticker's API failure shouldn't skip the rest of the portfolio this tick.
    for (const ticker of tickers) {
      try {
        const gap = await getGapReading(ticker);
        insertGapSnapshot(gap);

        if (!market.isOpen && Math.abs(gap.gapPct) >= threshold && !alertedThisClosedSession.has(ticker)) {
          alertedThisClosedSession.add(ticker);
          await notifyOwner(
            [
              `*Gap alert: ${gap.xstockTicker}*`,
              `${gap.underlyingTicker} last close ${usd(gap.referenceClose)}, live ${usd(gap.livePrice)} (${pct(gap.gapPct)})`,
              `Market reopens in ${formatCountdown(market.msUntilNextTransition)}.`,
              `/hedge ${gap.underlyingTicker} <USD> to hedge it.`,
            ].join("\n")
          );
        }
      } catch (err) {
        logger.error({ err, ticker }, "gap check failed");
      }
    }

    if (reportAttemptsLeft > 0 && tickers.length > 0) {
      reportAttemptsLeft--;
      try {
        const reports = await Promise.all(tickers.map((t) => reconcile(t)));
        await notifyOwner(
          ["*Market's open — here's what happened while it was closed*", ...reports.map(formatReconciliation)].join("\n\n")
        );
        reportAttemptsLeft = 0;
      } catch (err) {
        logger.warn({ err, attemptsLeft: reportAttemptsLeft }, "reconciliation report not ready, will retry");
      }
    }
  }

  const timer = setInterval(() => {
    tick().catch((err) => logger.error({ err }, "gap monitor tick failed"));
  }, intervalMs);

  return () => clearInterval(timer);
}
