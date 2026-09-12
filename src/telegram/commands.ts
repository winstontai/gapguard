import type { CommandContext, Context } from "grammy";
import { getBot } from "./bot.js";
import { config, isLiveMode } from "../config.js";
import type { SettingsStore } from "../settings.js";
import {
  addHolding,
  clearHoldings,
  getRollingHedgeUsd,
  listHedgedTickers,
  listHedgeFillsBetween,
  listHoldings,
  removeHolding,
} from "../portfolio/db.js";
import { getMarketState, formatCountdown } from "../market/clock.js";
import { getGapReading } from "../market/gap.js";
import { getLivePrice } from "../market/priceFeed.js";
import { reconcile } from "../market/reconcile.js";
import { hedgePnlAt } from "../market/reconcileMath.js";
import { resolveXStockFor, listMappedXStockTickers, listSupportedUnderlyingTickers } from "../xstocks/underlying.js";
import { resolveTicker, type XStockEntry } from "../xstocks/resolver.js";
import { recordHedge, type HedgeOutcome, type HedgeSide } from "../hedge/executor.js";
import { getKaminoAccount } from "../hedge/kamino.js";
import { USDC_MINT } from "../hedge/jupiter.js";
import { getRawTokenBalance, getSolBalance } from "../wallet/balances.js";
import { loadKeypair } from "../wallet/keypair.js";
import { escapeMd, formatReconciliation, pct, signedUsd, usd } from "./format.js";
import { logger } from "../logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeHedge(o: HedgeOutcome): string {
  const verb = o.side === "open" ? "Shorted" : "Bought back";
  const head = `${o.live ? "" : "[dry-run] "}${verb} ${usd(o.usdAmount)} of ${o.ticker} at ${usd(o.priceUsd)} (gap ${pct(o.gapPct)})`;
  if (!o.live) {
    return o.side === "open"
      ? `${head}. Nothing was signed — /report after the next open shows what it would have made.`
      : `${head}. Nothing was signed.`;
  }
  return [`${head} — ${o.detail}`, ...o.signatures.map((sig) => `https://solscan.io/tx/${sig}`)].join("\n");
}

/** Open shorts: Kamino's actual position in live mode, the ledger's net simulated shorts otherwise. */
async function shortLines(): Promise<string[]> {
  if (isLiveMode) {
    const xstocks = listMappedXStockTickers()
      .map((t) => resolveTicker(t))
      .filter((x): x is XStockEntry => x !== undefined);
    const account = await getKaminoAccount(
      loadKeypair().publicKey.toBase58(),
      xstocks.map((x) => x.mint)
    );
    if (!account.obligationExists) return ["*Kamino:* no position"];
    return [
      `*Kamino:* ${usd(account.collateralUsd)} collateral, LTV ${(account.ltv * 100).toFixed(1)}% (liquidates at ${(account.liquidationLtv * 100).toFixed(1)}%)`,
      ...xstocks.filter((x) => account.debts.has(x.mint)).map((x) => `  short ${account.debts.get(x.mint)?.toFixed(4)} ${x.ticker}`),
    ];
  }

  const lines: string[] = [];
  for (const ticker of listHedgedTickers()) {
    const xstock = resolveTicker(ticker);
    const price = xstock ? (await getLivePrice(xstock.mint))?.usdPrice : undefined;
    if (!price) continue;
    const { netShares, pnlUsd } = hedgePnlAt(listHedgeFillsBetween(ticker, 0, Date.now() + 1), price);
    if (netShares < -1e-9) {
      lines.push(`*Simulated short:* ${(-netShares).toFixed(4)} ${ticker} (${usd(-netShares * price)}, P&L ${signedUsd(pnlUsd)})`);
    }
  }
  return lines;
}

export function registerCommands(settingsStore: SettingsStore): void {
  const bot = getBot();

  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "*Gap Guard* — protects your real stock portfolio during the hours your broker is closed but the xStock market isn't.",
        `Mode: ${config.RUN_MODE}`,
        `Dashboard: http://127.0.0.1:${config.WEB_PORT}`,
        "",
        "/holdings — tell it what you own",
        "/status — live gap, exposure, and open shorts",
        "/hedge, /unwind — short an xStock through Kamino (real in mainnet-live, simulated otherwise)",
        "/report — what happened across the last close → open",
        "/wallet — hot wallet address and balances",
      ].join("\n"),
      { parse_mode: "Markdown" }
    )
  );

  bot.command("holdings", async (ctx) => {
    const [sub, ...rest] = ctx.match.trim().split(/\s+/);

    if (sub === "add") {
      const ticker = rest[0]?.toUpperCase();
      const shares = Number(rest[1]);
      if (!ticker || !Number.isFinite(shares) || shares <= 0) {
        return ctx.reply("Usage: /holdings add <TICKER> <SHARES>  e.g. /holdings add AAPL 100");
      }
      const xstockTicker = resolveXStockFor(ticker);
      if (!xstockTicker) {
        return ctx.reply(`No verified xStock mapping for ${ticker}. Supported: ${listSupportedUnderlyingTickers().join(", ")}`);
      }
      addHolding(ticker, xstockTicker, shares);
      return ctx.reply(`Added: ${shares} sh ${ticker} (tracked via ${xstockTicker}).`);
    }

    if (sub === "remove") {
      const id = Number(rest[0]);
      if (!Number.isFinite(id)) return ctx.reply("Usage: /holdings remove <id>  (see /holdings for ids)");
      return ctx.reply(removeHolding(id) ? `Removed holding #${id}.` : `No active holding with id ${id}.`);
    }

    if (sub === "clear") {
      return ctx.reply(`Cleared ${clearHoldings()} holding(s).`);
    }

    const holdings = listHoldings();
    if (holdings.length === 0) {
      return ctx.reply("No holdings tracked yet. Add one: /holdings add AAPL 100");
    }
    return ctx.reply(holdings.map((h) => `#${h.id}  ${h.shares} sh ${h.ticker} (${h.xstockTicker})`).join("\n"));
  });

  bot.command("status", async (ctx) => {
    const market = getMarketState();
    const holdings = listHoldings();
    const s = settingsStore.get();

    const lines: string[] = [
      market.isOpen
        ? `*Market:* 🟢 OPEN (closes in ${formatCountdown(market.msUntilNextTransition)})`
        : `*Market:* 🔴 CLOSED (reopens in ${formatCountdown(market.msUntilNextTransition)}) — your broker can't act until then`,
      "",
    ];

    if (holdings.length === 0) {
      lines.push("No holdings tracked. Add one: /holdings add AAPL 100");
    } else {
      let totalExposure = 0;
      for (const h of holdings) {
        try {
          const gap = await getGapReading(h.xstockTicker);
          const exposure = h.shares * gap.referenceClose;
          totalExposure += exposure;
          lines.push(
            `*${h.ticker}* ${h.shares} sh — ${market.isOpen ? "real" : "last close"} ${usd(gap.referenceClose)} (${usd(exposure)}) — ${
              gap.xstockTicker
            } ${usd(gap.livePrice)} (${pct(gap.gapPct)})`
          );
        } catch (err) {
          lines.push(`*${h.ticker}* — gap unavailable: ${escapeMd(errMessage(err))}`);
        }
      }
      lines.push("", `*Total exposure:* ${usd(totalExposure)}`);
    }

    try {
      const shorts = await shortLines();
      if (shorts.length > 0) lines.push("", ...shorts);
    } catch (err) {
      lines.push("", `*Shorts:* unavailable — ${escapeMd(errMessage(err))}`);
    }

    lines.push(
      "",
      `*Hedged (24h):* ${usd(getRollingHedgeUsd(DAY_MS))} / ${usd(s.maxDailyUsd)}`,
      `*Paused:* ${s.paused ? "yes (kill switch active)" : "no"}`
    );

    return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  async function handleHedge(ctx: CommandContext<Context>, side: HedgeSide): Promise<void> {
    const [tickerRaw, amountRaw] = ctx.match.trim().split(/\s+/);
    const ticker = tickerRaw?.toUpperCase();
    const amount = side === "unwind" && amountRaw?.toLowerCase() === "all" ? "all" : Number(amountRaw);
    if (!ticker || (amount !== "all" && (!Number.isFinite(amount) || amount <= 0))) {
      await ctx.reply(
        side === "open" ? "Usage: /hedge <TICKER> <USD>  e.g. /hedge QQQ 100" : "Usage: /unwind <TICKER> <USD|all>  e.g. /unwind QQQ all"
      );
      return;
    }

    // A live hedge is several transactions and can take 20-30s; acknowledge before it starts.
    if (isLiveMode) await ctx.reply(`Executing ${side === "open" ? "short" : "unwind"} on ${ticker}…`);

    try {
      const outcome = await recordHedge(side, resolveXStockFor(ticker) ?? ticker, amount, settingsStore.get(), "manual:telegram");
      await ctx.reply(describeHedge(outcome));
    } catch (err) {
      logger.warn({ err, ticker, amount, side }, "hedge command refused");
      await ctx.reply(`Refused: ${errMessage(err)}`);
    }
  }

  bot.command("hedge", (ctx) => handleHedge(ctx, "open"));
  bot.command("unwind", (ctx) => handleHedge(ctx, "unwind"));

  bot.command("report", async (ctx) => {
    const tickers = [...new Set(listHoldings().map((h) => h.xstockTicker))];
    if (tickers.length === 0) {
      return ctx.reply("No holdings tracked. Add one: /holdings add AAPL 100");
    }
    const sections: string[] = [];
    for (const ticker of tickers) {
      try {
        sections.push(formatReconciliation(await reconcile(ticker)));
      } catch (err) {
        sections.push(`*${ticker}* — report unavailable: ${escapeMd(errMessage(err))}`);
      }
    }
    return ctx.reply(sections.join("\n\n"), { parse_mode: "Markdown" });
  });

  bot.command("wallet", async (ctx) => {
    const owner = loadKeypair().publicKey;
    const [sol, usdcRaw] = await Promise.all([getSolBalance(owner), getRawTokenBalance(owner, USDC_MINT)]);
    return ctx.reply(
      [`Hot wallet: ${owner.toBase58()}`, `SOL: ${sol.toFixed(4)}`, `USDC: ${usd(Number(usdcRaw) / 1e6)}`, `Mode: ${config.RUN_MODE}`].join("\n")
    );
  });

  bot.command("pause", async (ctx) => {
    settingsStore.set("paused", true);
    logger.warn("kill switch activated via telegram");
    await ctx.reply("Paused. No hedge will be recorded or signed until /resume.");
  });

  bot.command("resume", async (ctx) => {
    settingsStore.set("paused", false);
    logger.warn("kill switch deactivated via telegram");
    await ctx.reply("Resumed.");
  });

  bot.command("limits", async (ctx) => {
    const [sub, ...rest] = ctx.match.trim().split(/\s+/);
    const n = Number(rest.join(" "));

    switch (sub) {
      case "maxPerHedge":
        if (!Number.isFinite(n) || n <= 0) return ctx.reply("Usage: /limits maxPerHedge <USD>");
        settingsStore.set("maxUsdPerHedge", n);
        return ctx.reply(`Per-hedge cap set to ${usd(n)}.`);
      case "maxDaily":
        if (!Number.isFinite(n) || n <= 0) return ctx.reply("Usage: /limits maxDaily <USD>");
        settingsStore.set("maxDailyUsd", n);
        return ctx.reply(`Daily cap set to ${usd(n)}.`);
      case "gapThreshold":
        if (!Number.isFinite(n) || n < 0) return ctx.reply("Usage: /limits gapThreshold <PCT>");
        settingsStore.set("gapAlertThresholdPct", n);
        return ctx.reply(`Gap alert threshold set to ${n}%.`);
      default:
        return ctx.reply(
          `Mode: ${config.RUN_MODE}\nUsage:\n/limits maxPerHedge <USD>\n/limits maxDaily <USD>\n/limits gapThreshold <PCT>`
        );
    }
  });
}
