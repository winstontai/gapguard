import { describe, expect, it } from "vitest";
import { buybackRaw, collateralTopUpUsd, projectedLtv, toRaw, toRawCeil } from "../src/hedge/shortMath.js";

describe("collateralTopUpUsd", () => {
  // Borrow factor 1.66 is Kamino's live value for QQQx debt against USDC collateral.
  const fresh = { collateralUsd: 0, debtUsdBorrowFactorAdjusted: 0, borrowFactor: 1.66, targetLtv: 0.4 };

  it("sizes collateral for a fresh short through the borrow factor", () => {
    // $100 of debt counts as $166; at 40% LTV that needs $415 of collateral
    expect(collateralTopUpUsd({ ...fresh, newDebtUsd: 100 })).toBeCloseTo(415);
  });

  it("tops up only the shortfall when collateral already exists", () => {
    expect(collateralTopUpUsd({ ...fresh, collateralUsd: 300, newDebtUsd: 100 })).toBeCloseTo(115);
  });

  it("needs nothing when existing collateral already covers the new debt", () => {
    expect(collateralTopUpUsd({ ...fresh, collateralUsd: 1000, newDebtUsd: 100 })).toBe(0);
  });

  it("lands on the target LTV after topping up, counting existing debt", () => {
    const s = { ...fresh, collateralUsd: 50, debtUsdBorrowFactorAdjusted: 30, newDebtUsd: 100 };
    expect(projectedLtv({ ...s, topUpUsd: collateralTopUpUsd(s) })).toBeCloseTo(0.4);
  });
});

describe("buybackRaw", () => {
  it("adds headroom for interest accrued before the repay lands", () => {
    expect(buybackRaw(1_000_000n, 0n, 50n)).toBe(1_005_000n);
  });

  it("counts xStock already sitting in the wallet", () => {
    expect(buybackRaw(1_000_000n, 400_000n, 50n)).toBe(605_000n);
  });

  it("buys nothing when the wallet already covers the repay", () => {
    expect(buybackRaw(1_000_000n, 2_000_000n, 50n)).toBe(0n);
  });
});

describe("base-unit conversion", () => {
  it("floors quantities so a borrow never exceeds what was sized", () => {
    expect(toRaw(1.234567891, 8)).toBe(123456789n);
  });

  it("ceils collateral so a deposit never comes up short", () => {
    expect(toRawCeil(415.0000001, 6)).toBe(415000001n);
  });
});
