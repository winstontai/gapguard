import { config, isLiveMode } from "../config.js";
import { logger } from "../logger.js";
import { resolveTicker, type XStockEntry } from "../xstocks/resolver.js";
import { getGapReading } from "../market/gap.js";
import { hedgePnlAt } from "../market/reconcileMath.js";
import { assertHedgeAllowed, assertLtvAllowed, assertUnwindAllowed, RiskLimitError } from "./riskLimits.js";
import type { Settings } from "../settings.js";
import { insertHedge, listHedgeFillsBetween } from "../portfolio/db.js";
import { executeSwap, getQuote, USDC_MINT } from "./jupiter.js";
import { executeKaminoOp, getShortContext } from "./kamino.js";
import { buybackRaw, collateralTopUpUsd, projectedLtv, toRaw, toRawCeil } from "./shortMath.js";
import { getRawTokenBalance } from "../wallet/balances.js";
import { getConnection } from "../wallet/connection.js";
import { loadKeypair } from "../wallet/keypair.js";

export type HedgeSide = "open" | "unwind";

export interface HedgeOutcome {
  side: HedgeSide;
  ticker: string;
  live: boolean;
  usdAmount: number;
  priceUsd: number;
  gapPct: number;
  signatures: string[];
  detail?: string;
}

const USDC_DECIMALS = 6;
const SLIPPAGE_BPS = 100;
// Headroom when buying back to repay: interest accrues between the quote and the repay landing.
const BUYBACK_BUFFER_BPS = 50n;

interface LiveResult {
  usdAmount: number;
  priceUsd: number;
  signatures: string[];
  detail: string;
}

function usdcFromRaw(raw: bigint): string {
  return `$${(Number(raw) / 10 ** USDC_DECIMALS).toFixed(2)}`;
}

/**
 * Opens a real short: tops USDC collateral up to HEDGE_TARGET_LTV, borrows the
 * xStock from Kamino's xStocks Market, then sells it for USDC through Jupiter.
 */
async function openShort(xstock: XStockEntry, usdAmount: number, livePrice: number): Promise<LiveResult> {
  const owner = loadKeypair().publicKey;
  const ctx = await getShortContext(owner.toBase58(), xstock.mint, xstock.decimals);
  if (!ctx.borrowable) {
    throw new RiskLimitError(`${ctx.notBorrowableReason} - hedge that exposure through SPY or QQQ instead`);
  }

  const qty = usdAmount / livePrice;
  if (qty > ctx.availableQty) {
    throw new RiskLimitError(`Kamino only has ${ctx.availableQty.toFixed(4)} ${xstock.ticker} available to borrow`);
  }

  const sizing = {
    collateralUsd: ctx.account.collateralUsd,
    debtUsdBorrowFactorAdjusted: ctx.account.debtUsdBorrowFactorAdjusted,
    newDebtUsd: usdAmount,
    borrowFactor: ctx.borrowFactor,
    targetLtv: config.HEDGE_TARGET_LTV,
  };
  const topUpUsd = collateralTopUpUsd(sizing);
  const ltvAfter = projectedLtv({ ...sizing, topUpUsd });
  assertLtvAllowed(ltvAfter);

  const depositUsdcBase = toRawCeil(topUpUsd, USDC_DECIMALS);
  const usdcHeld = await getRawTokenBalance(owner, USDC_MINT);
  if (depositUsdcBase > usdcHeld) {
    throw new RiskLimitError(
      `a $${usdAmount} short needs ${usdcFromRaw(depositUsdcBase)} more USDC collateral at ${(config.HEDGE_TARGET_LTV * 100).toFixed(0)}% LTV ` +
        `(borrow factor ${ctx.borrowFactor}); the wallet holds ${usdcFromRaw(usdcHeld)}`
    );
  }

  const qtyBase = toRaw(qty, xstock.decimals);
  const borrowSig = await executeKaminoOp({ kind: "borrow", xstockMint: xstock.mint, qtyBase, depositUsdcBase });

  try {
    const quote = await getQuote(xstock.mint, USDC_MINT, qtyBase, SLIPPAGE_BPS);
    const { signature: sellSig } = await executeSwap(getConnection(), loadKeypair(), quote);
    const priceUsd = Number(quote.outAmount) / 10 ** USDC_DECIMALS / (Number(quote.inAmount) / 10 ** xstock.decimals);
    return {
      usdAmount,
      priceUsd,
      signatures: [borrowSig, sellSig],
      detail: `deposited ${usdcFromRaw(depositUsdcBase)} USDC collateral, LTV now ${(ltvAfter * 100).toFixed(1)}%`,
    };
  } catch (err) {
    throw new Error(
      `borrowed ${qty.toFixed(6)} ${xstock.ticker} (tx ${borrowSig}) but selling it failed, so the position is flat, not short. ` +
        `/unwind ${xstock.ticker} all repays the loan. Cause: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Closes a short: buys the xStock back through Jupiter, repays Kamino, and withdraws collateral once nothing is owed. */
async function closeShort(xstock: XStockEntry, amount: number | "all", livePrice: number): Promise<LiveResult> {
  const owner = loadKeypair().publicKey;
  const ctx = await getShortContext(owner.toBase58(), xstock.mint, xstock.decimals);
  const debtQty = ctx.account.debts.get(xstock.mint) ?? 0;
  if (debtQty <= 0) throw new Error(`no open Kamino short on ${xstock.ticker}`);

  const repayQty = amount === "all" ? debtQty : Math.min(debtQty, amount / livePrice);
  const repayRaw = toRaw(repayQty, xstock.decimals);
  const needRaw = buybackRaw(repayRaw, await getRawTokenBalance(owner, xstock.mint), BUYBACK_BUFFER_BPS);

  const signatures: string[] = [];
  let priceUsd = livePrice;
  if (needRaw > 0n) {
    const needQty = Number(needRaw) / 10 ** xstock.decimals;
    let usdcBase = toRawCeil(needQty * livePrice * (1 + SLIPPAGE_BPS / 10_000), USDC_DECIMALS);
    let quote = await getQuote(USDC_MINT, xstock.mint, usdcBase, SLIPPAGE_BPS);
    // otherAmountThreshold is the worst-case output after slippage - it has to cover the repay on its own.
    if (BigInt(quote.otherAmountThreshold) < needRaw) {
      usdcBase = (usdcBase * 102n) / 100n;
      quote = await getQuote(USDC_MINT, xstock.mint, usdcBase, SLIPPAGE_BPS);
      if (BigInt(quote.otherAmountThreshold) < needRaw) {
        throw new Error(`couldn't source ${needQty.toFixed(6)} ${xstock.ticker} within ${SLIPPAGE_BPS / 100}% slippage`);
      }
    }
    const usdcHeld = await getRawTokenBalance(owner, USDC_MINT);
    if (usdcBase > usdcHeld) {
      throw new RiskLimitError(
        `buying back ${needQty.toFixed(6)} ${xstock.ticker} needs ${usdcFromRaw(usdcBase)}; the wallet holds ${usdcFromRaw(usdcHeld)}`
      );
    }
    signatures.push((await executeSwap(getConnection(), loadKeypair(), quote)).signature);
    priceUsd = Number(quote.inAmount) / 10 ** USDC_DECIMALS / (Number(quote.outAmount) / 10 ** xstock.decimals);
  }

  signatures.push(
    await executeKaminoOp({ kind: "repay", xstockMint: xstock.mint, qtyBase: amount === "all" ? "all" : repayRaw })
  );
  let detail = `repaid ${repayQty.toFixed(6)} ${xstock.ticker}`;

  if (amount === "all") {
    const after = await getShortContext(owner.toBase58(), xstock.mint, xstock.decimals);
    if (after.account.debtUsdBorrowFactorAdjusted < 0.01) {
      signatures.push(await executeKaminoOp({ kind: "withdrawCollateral", usdcBase: "all" }));
      detail += " and withdrew all USDC collateral";
    }
  }

  return { usdAmount: repayQty * priceUsd, priceUsd, signatures, detail };
}

/** USD value of the simulated short still open on a ticker, from the dry-run ledger. */
function simulatedShortUsd(xstockTicker: string, livePrice: number): number {
  const { netShares } = hedgePnlAt(listHedgeFillsBetween(xstockTicker, 0, Date.now() + 1), livePrice);
  if (netShares >= 0) throw new Error(`no simulated short open on ${xstockTicker}`);
  return -netShares * livePrice;
}

/**
 * Opens ("open") or closes ("unwind") a short hedge on an xStock. mainnet-live
 * executes it through Kamino + Jupiter; every other mode records the same
 * trade at the live xStock price without signing anything.
 */
export async function recordHedge(
  side: HedgeSide,
  ticker: string,
  amount: number | "all",
  settings: Settings,
  triggeredBy: string
): Promise<HedgeOutcome> {
  const upperTicker = ticker.toUpperCase();
  const xstock = resolveTicker(upperTicker);
  if (!xstock) throw new Error(`unknown xStock ticker: ${upperTicker}`);

  if (side === "open") {
    if (amount === "all") throw new Error("a hedge needs a USD amount");
    assertHedgeAllowed({ usdAmount: amount, ticker: upperTicker, triggeredBy }, settings);
  } else {
    assertUnwindAllowed(settings);
  }

  const gap = await getGapReading(upperTicker);
  const entry = { ts: Date.now(), xstockTicker: upperTicker, mint: xstock.mint, side, gapPctAtHedge: gap.gapPct, triggeredBy };

  if (!isLiveMode) {
    const usdAmount = amount === "all" ? simulatedShortUsd(upperTicker, gap.livePrice) : amount;
    insertHedge({ ...entry, usdAmount, priceUsd: gap.livePrice, txSignature: null, status: "dry-run", notes: null });
    logger.info({ side, ticker: upperTicker, usdAmount }, "dry-run hedge recorded, nothing signed");
    return { side, ticker: upperTicker, live: false, usdAmount, priceUsd: gap.livePrice, gapPct: gap.gapPct, signatures: [] };
  }

  try {
    const r =
      side === "open" && amount !== "all"
        ? await openShort(xstock, amount, gap.livePrice)
        : await closeShort(xstock, amount, gap.livePrice);
    insertHedge({
      ...entry,
      usdAmount: r.usdAmount,
      priceUsd: r.priceUsd,
      txSignature: r.signatures.at(-1) ?? null,
      status: "confirmed",
      notes: `${r.detail}; txs ${r.signatures.join(" ")}`,
    });
    logger.info({ side, ticker: upperTicker, ...r }, "live hedge executed");
    return { side, ticker: upperTicker, live: true, gapPct: gap.gapPct, ...r };
  } catch (err) {
    insertHedge({
      ...entry,
      usdAmount: amount === "all" ? 0 : amount,
      priceUsd: gap.livePrice,
      txSignature: null,
      status: "failed",
      notes: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
