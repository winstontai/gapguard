export interface ShortSizing {
  collateralUsd: number;
  debtUsdBorrowFactorAdjusted: number;
  newDebtUsd: number;
  borrowFactor: number;
  targetLtv: number;
}

/** USDC to add so borrow-factor-adjusted debt, including the new short, sits at `targetLtv`. */
export function collateralTopUpUsd(s: ShortSizing): number {
  const required = (s.debtUsdBorrowFactorAdjusted + s.newDebtUsd * s.borrowFactor) / s.targetLtv;
  return Math.max(0, required - s.collateralUsd);
}

export function projectedLtv(s: ShortSizing & { topUpUsd: number }): number {
  return (s.debtUsdBorrowFactorAdjusted + s.newDebtUsd * s.borrowFactor) / (s.collateralUsd + s.topUpUsd);
}

/** Base units to buy so `repayRaw` clears, with `bufferBps` of headroom for interest accrued before the repay lands. */
export function buybackRaw(repayRaw: bigint, walletRaw: bigint, bufferBps: bigint): bigint {
  const target = repayRaw + (repayRaw * bufferBps + 9_999n) / 10_000n;
  return target > walletRaw ? target - walletRaw : 0n;
}

export function toRaw(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

export function toRawCeil(amount: number, decimals: number): bigint {
  return BigInt(Math.ceil(amount * 10 ** decimals));
}
