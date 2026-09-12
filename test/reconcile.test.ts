import { describe, expect, it } from "vitest";
import { hedgePnlAt, pickReopenWindow, priceAt } from "../src/market/reconcileMath.js";

describe("priceAt", () => {
  const tape = [
    { ts: 1000, price: 10 },
    { ts: 2000, price: 20 },
    { ts: 3000, price: 30 },
  ];

  it("returns the price at an exact timestamp", () => {
    expect(priceAt(tape, 2000)).toBe(20);
  });

  it("returns the last price before a timestamp between points", () => {
    expect(priceAt(tape, 2500)).toBe(20);
  });

  it("returns the final price for a timestamp past the tape", () => {
    expect(priceAt(tape, 9999)).toBe(30);
  });

  it("returns null when the tape starts after the timestamp", () => {
    expect(priceAt(tape, 500)).toBeNull();
  });

  it("returns null for an empty tape", () => {
    expect(priceAt([], 1000)).toBeNull();
  });
});

describe("hedgePnlAt", () => {
  it("profits when the stock falls after a short", () => {
    // short $1,000 at $100 = 10 sh, marked at $90 -> +$100
    const { pnlUsd, netShares } = hedgePnlAt([{ side: "open", usdAmount: 1000, priceUsd: 100 }], 90);
    expect(pnlUsd).toBeCloseTo(100);
    expect(netShares).toBeCloseTo(-10);
  });

  it("loses when the stock rises after a short", () => {
    expect(hedgePnlAt([{ side: "open", usdAmount: 1000, priceUsd: 100 }], 110).pnlUsd).toBeCloseTo(-100);
  });

  it("locks in P&L on a full unwind, independent of the mark price", () => {
    // short 10 sh at $100, buy 10 sh back at $95 -> +$50 no matter where it opens
    const events = [
      { side: "open" as const, usdAmount: 1000, priceUsd: 100 },
      { side: "unwind" as const, usdAmount: 950, priceUsd: 95 },
    ];
    expect(hedgePnlAt(events, 50).pnlUsd).toBeCloseTo(50);
    expect(hedgePnlAt(events, 200).pnlUsd).toBeCloseTo(50);
  });

  it("is zero with no hedges", () => {
    expect(hedgePnlAt([], 123).pnlUsd).toBe(0);
  });
});

describe("pickReopenWindow", () => {
  const bar = (date: string, iso: string, open: number | null, close: number | null) => ({
    date,
    sessionStartTs: Date.parse(iso),
    open,
    close,
  });
  // Real AAPL daily bars around Labor Day 2026 (Mon 2026-09-07 closed); 09:30 EDT = 13:30 UTC.
  const bars = [
    bar("2026-09-03", "2026-09-03T13:30:00Z", 324.87, 328.21),
    bar("2026-09-04", "2026-09-04T13:30:00Z", 328.31, 319.97),
    bar("2026-09-08", "2026-09-08T13:30:00Z", 317.1, 316.22),
  ];

  it("spans a long weekend: Friday's close to Tuesday's open", () => {
    const w = pickReopenWindow(bars, Date.parse("2026-09-08T15:00:00Z"));
    expect(w?.closed.date).toBe("2026-09-04");
    expect(w?.closed.close).toBe(319.97);
    expect(w?.reopened.date).toBe("2026-09-08");
    expect(w?.reopened.open).toBe(317.1);
  });

  it("ignores bars for sessions that haven't started yet", () => {
    const w = pickReopenWindow(bars, Date.parse("2026-09-05T15:00:00Z"));
    expect(w?.closed.date).toBe("2026-09-03");
    expect(w?.reopened.date).toBe("2026-09-04");
  });

  it("returns null while the latest session's open hasn't printed", () => {
    const pending = [...bars.slice(0, 2), bar("2026-09-08", "2026-09-08T13:30:00Z", null, null)];
    expect(pickReopenWindow(pending, Date.parse("2026-09-08T13:30:05Z"))).toBeNull();
  });
});
