import type { Reconciliation } from "../market/reconcile.js";

export function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function signedUsd(n: number): string {
  return `${n < 0 ? "-" : "+"}${usd(Math.abs(n))}`;
}

export function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** Escapes Telegram legacy-Markdown control characters in text we don't control, like API error bodies. */
export function escapeMd(text: string): string {
  return text.replace(/[_*`[]/g, "\\$&");
}

const nyTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function formatReconciliation(r: Reconciliation): string {
  const lines = [
    `*${r.underlyingTicker}* — ${r.closeDate} close → ${r.reopenDate} open`,
    `Closed ${usd(r.priorClose)}, opened ${usd(r.realOpen)} (${pct(r.actualGapPct)})`,
    `Your ${r.shares} sh moved ${signedUsd(r.exposureChangeUsd)} while your broker was closed`,
    r.predictedGapPct === null || r.predictionErrorPp === null
      ? `No ${r.xstockTicker} prices for that window`
      : `${r.xstockTicker} moved ${pct(r.predictedGapPct)} while closed${r.pricesBackfilled ? " (backfilled)" : ""} — off by ${Math.abs(
          r.predictionErrorPp
        ).toFixed(2)}pp`,
  ];
  if (r.basisPct !== null) {
    lines.push(`Token premium at the close: ${pct(r.basisPct)}`);
  }
  if (r.peakMovePct !== null && r.peakMoveTs !== null) {
    lines.push(`Biggest swing while closed: ${pct(r.peakMovePct)} (${nyTime.format(new Date(r.peakMoveTs))} ET)`);
  }
  if (r.hedgeCount > 0) {
    lines.push(
      `${r.simulated ? "Simulated hedge" : "Hedge"} P&L at the open: ${signedUsd(r.hedgePnlUsd)} (${r.hedgeCount} trade${r.hedgeCount === 1 ? "" : "s"})`,
      `*Net:* ${signedUsd(r.netChangeUsd)}`
    );
  }
  return lines.join("\n");
}
