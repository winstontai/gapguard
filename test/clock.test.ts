import { describe, expect, it } from "vitest";
import { isMarketOpen, formatCountdown } from "../src/market/clock.js";

// All instants below are given in UTC but chosen to land unambiguously in
// America/New_York's local day - EDT is UTC-4 in these months.

describe("isMarketOpen", () => {
  it("is open on a weekday during regular session hours", () => {
    // Tue 2026-09-15 14:00 UTC = 10:00 ET
    expect(isMarketOpen(new Date("2026-09-15T14:00:00Z"))).toBe(true);
  });

  it("is closed before the 9:30 ET open", () => {
    // Tue 2026-09-15 13:00 UTC = 09:00 ET
    expect(isMarketOpen(new Date("2026-09-15T13:00:00Z"))).toBe(false);
  });

  it("is closed at/after the 16:00 ET close", () => {
    // Tue 2026-09-15 20:00 UTC = 16:00 ET
    expect(isMarketOpen(new Date("2026-09-15T20:00:00Z"))).toBe(false);
  });

  it("is closed on a Saturday even during would-be session hours", () => {
    // Sat 2026-09-19 15:00 UTC = 11:00 ET
    expect(isMarketOpen(new Date("2026-09-19T15:00:00Z"))).toBe(false);
  });

  it("is closed on Independence Day (observed)", () => {
    // Sat 2026-07-04 -> observed Friday 2026-07-03
    expect(isMarketOpen(new Date("2026-07-03T15:00:00Z"))).toBe(false);
  });

  it("is closed on Thanksgiving (4th Thursday of November)", () => {
    // 2026-11-26 is the 4th Thursday of November 2026
    expect(isMarketOpen(new Date("2026-11-26T15:00:00Z"))).toBe(false);
  });
});

describe("formatCountdown", () => {
  it("formats minutes only under an hour", () => {
    expect(formatCountdown(45 * 60_000)).toBe("45m");
  });

  it("formats hours and minutes", () => {
    expect(formatCountdown(3 * 60 * 60_000 + 5 * 60_000)).toBe("3h 5m");
  });

  it("formats days, hours, and minutes", () => {
    expect(formatCountdown(2 * 24 * 60 * 60_000 + 60 * 60_000 + 2 * 60_000)).toBe("2d 1h 2m");
  });
});
