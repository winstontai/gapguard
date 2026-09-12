import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, isLiveMode } from "../config.js";
import { logger } from "../logger.js";
import type { SettingsStore } from "../settings.js";
import { formatCountdown, getMarketState } from "../market/clock.js";
import { getGapReading } from "../market/gap.js";
import { getLivePrice } from "../market/priceFeed.js";
import { reconcile, type Reconciliation } from "../market/reconcile.js";
import { hedgePnlAt } from "../market/reconcileMath.js";
import {
  addHolding,
  getRollingHedgeUsd,
  listHedgeFillsBetween,
  listHedgedTickers,
  listHoldings,
  listRecentHedges,
  removeHolding,
} from "../portfolio/db.js";
import { recordHedge } from "../hedge/executor.js";
import { RiskLimitError } from "../hedge/riskLimits.js";
import { getKaminoAccount } from "../hedge/kamino.js";
import { checkRequest } from "./guard.js";
import { USDC_MINT } from "../hedge/jupiter.js";
import { resolveTicker, type XStockEntry } from "../xstocks/resolver.js";
import { listMappedXStockTickers, listSupportedUnderlyingTickers, resolveXStockFor } from "../xstocks/underlying.js";
import { getRawTokenBalance, getSolBalance } from "../wallet/balances.js";
import { loadKeypair } from "../wallet/keypair.js";
import { telegramEnabled } from "../telegram/bot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4096;

interface ShortPositionView {
  ticker: string;
  qty: number;
  usd: number | null;
  pnlUsd?: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

async function walletView(): Promise<{ address: string; sol: number; usdc: number } | null> {
  try {
    const owner = loadKeypair().publicKey;
    const [sol, usdc] = await Promise.all([getSolBalance(owner), getRawTokenBalance(owner, USDC_MINT)]);
    return { address: owner.toBase58(), sol, usdc: Number(usdc) / 1e6 };
  } catch (err) {
    logger.debug({ err }, "wallet view unavailable");
    return null;
  }
}

/** Open shorts: Kamino's real position in live mode, the ledger's net simulated shorts otherwise. */
async function shortsView(): Promise<{
  kind: "live" | "simulated";
  collateralUsd?: number;
  debtUsd?: number;
  ltv?: number;
  liquidationLtv?: number;
  positions: ShortPositionView[];
  error?: string;
}> {
  try {
    if (isLiveMode) {
      const xstocks = listMappedXStockTickers()
        .map((ticker) => resolveTicker(ticker))
        .filter((x): x is XStockEntry => x !== undefined);
      const account = await getKaminoAccount(
        loadKeypair().publicKey.toBase58(),
        xstocks.map((x) => x.mint)
      );
      const positions: ShortPositionView[] = [];
      for (const xstock of xstocks) {
        const qty = account.debts.get(xstock.mint);
        if (!qty) continue;
        const price = (await getLivePrice(xstock.mint))?.usdPrice ?? null;
        positions.push({ ticker: xstock.ticker, qty, usd: price === null ? null : qty * price });
      }
      return {
        kind: "live",
        collateralUsd: account.collateralUsd,
        debtUsd: account.debtUsdBorrowFactorAdjusted,
        ltv: account.ltv,
        liquidationLtv: account.liquidationLtv,
        positions,
      };
    }

    const positions: ShortPositionView[] = [];
    for (const ticker of listHedgedTickers()) {
      const xstock = resolveTicker(ticker);
      const price = xstock ? (await getLivePrice(xstock.mint))?.usdPrice : undefined;
      if (!price) continue;
      const { netShares, pnlUsd } = hedgePnlAt(listHedgeFillsBetween(ticker, 0, Date.now() + 1), price);
      if (netShares < -1e-9) {
        positions.push({ ticker, qty: -netShares, usd: -netShares * price, pnlUsd });
      }
    }
    return { kind: "simulated", positions };
  } catch (err) {
    return { kind: isLiveMode ? "live" : "simulated", positions: [], error: errMessage(err) };
  }
}

async function buildState(settingsStore: SettingsStore): Promise<unknown> {
  const market = getMarketState();
  const settings = settingsStore.get();

  const holdings = await Promise.all(
    listHoldings().map(async (holding) => {
      try {
        const gap = await getGapReading(holding.xstockTicker);
        return {
          ...holding,
          refClose: gap.referenceClose,
          exposure: holding.shares * gap.referenceClose,
          livePrice: gap.livePrice,
          gapPct: gap.gapPct,
        };
      } catch (err) {
        return { ...holding, refClose: null, exposure: null, livePrice: null, gapPct: null, error: errMessage(err) };
      }
    })
  );

  const [shorts, wallet] = await Promise.all([shortsView(), walletView()]);

  return {
    mode: config.RUN_MODE,
    live: isLiveMode,
    telegram: telegramEnabled,
    market: {
      isOpen: market.isOpen,
      countdown: formatCountdown(market.msUntilNextTransition),
      nextTransition: market.nextTransition.toISOString(),
    },
    holdings,
    totalExposure: holdings.reduce((sum, h) => sum + (h.exposure ?? 0), 0),
    shorts,
    wallet,
    limits: {
      maxUsdPerHedge: settings.maxUsdPerHedge,
      maxDailyUsd: settings.maxDailyUsd,
      hedged24h: getRollingHedgeUsd(DAY_MS),
      gapAlertThresholdPct: settings.gapAlertThresholdPct,
      paused: settings.paused,
    },
    hedges: listRecentHedges(12),
    supportedTickers: listSupportedUnderlyingTickers(),
  };
}

async function buildReport(): Promise<Array<Reconciliation | { xstockTicker: string; error: string }>> {
  const tickers = [...new Set(listHoldings().map((h) => h.xstockTicker))];
  return Promise.all(
    tickers.map(async (ticker) => {
      try {
        return await reconcile(ticker);
      } catch (err) {
        return { xstockTicker: ticker, error: errMessage(err) };
      }
    })
  );
}

/**
 * Local dashboard: the same state and actions as the Telegram bot, for demoing without a bot token.
 * Binds to 127.0.0.1 only, and mutating routes additionally require a loopback client, because
 * these endpoints can sign transactions in mainnet-live.
 */
export function startWebServer(settingsStore: SettingsStore): () => void {
  const page = join(__dirname, "index.html");

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.WEB_PORT}`);
      const route = `${req.method} ${url.pathname}`;

      const guard = checkRequest({
        method: req.method ?? "GET",
        host: header(req, "host"),
        origin: header(req, "origin"),
        guardHeader: header(req, "x-gap-guard"),
        remoteAddress: req.socket.remoteAddress ?? undefined,
        port: config.WEB_PORT,
      });
      if (!guard.ok) {
        logger.warn({ route, host: header(req, "host"), origin: header(req, "origin") }, "dashboard request refused");
        return json(res, guard.status, { error: guard.error });
      }

      try {
        if (route === "GET /") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(readFileSync(page, "utf-8"));
          return;
        }
        if (route === "GET /api/state") return json(res, 200, await buildState(settingsStore));
        if (route === "GET /api/report") return json(res, 200, await buildReport());

        if (req.method === "POST") {
          const body = await readJsonBody(req);

          if (url.pathname === "/api/hedge" || url.pathname === "/api/unwind") {
            const side = url.pathname === "/api/hedge" ? "open" : "unwind";
            const ticker = String(body.ticker ?? "").toUpperCase();
            const amount = body.amount === "all" ? "all" : Number(body.amount);
            if (!ticker || (amount !== "all" && (!Number.isFinite(amount) || amount <= 0))) {
              return json(res, 400, { error: "ticker and a positive amount (or 'all' to unwind) are required" });
            }
            const outcome = await recordHedge(side, resolveXStockFor(ticker) ?? ticker, amount, settingsStore.get(), "manual:web");
            return json(res, 200, outcome);
          }

          if (url.pathname === "/api/holdings") {
            const ticker = String(body.ticker ?? "").toUpperCase();
            const shares = Number(body.shares);
            if (!Number.isFinite(shares) || shares <= 0) return json(res, 400, { error: "shares must be a positive number" });
            const xstockTicker = resolveXStockFor(ticker);
            if (!xstockTicker) return json(res, 400, { error: `no verified xStock mapping for ${ticker}` });
            return json(res, 200, { id: addHolding(ticker, xstockTicker, shares) });
          }

          if (url.pathname === "/api/holdings/remove") {
            const id = Number(body.id);
            if (!Number.isFinite(id)) return json(res, 400, { error: "id is required" });
            return json(res, 200, { removed: removeHolding(id) });
          }

          if (url.pathname === "/api/pause") {
            const paused = Boolean(body.paused);
            settingsStore.set("paused", paused);
            logger.warn({ paused }, "kill switch toggled from dashboard");
            return json(res, 200, { paused });
          }
        }

        json(res, 404, { error: "no such route" });
      } catch (err) {
        // Refusals and bad input are the caller's problem; anything else is ours.
        const status = err instanceof RiskLimitError || err instanceof SyntaxError ? 400 : 500;
        logger.warn({ err, route, status }, "dashboard request failed");
        json(res, status, { error: errMessage(err) });
      }
    })();
  });

  server.listen(config.WEB_PORT, "127.0.0.1", () => {
    logger.info(`dashboard on http://127.0.0.1:${config.WEB_PORT}`);
  });

  return () => server.close();
}
