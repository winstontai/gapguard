/**
 * NYSE regular-session market clock (9:30-16:00 America/New_York, Mon-Fri,
 * minus federal-market holidays). Holidays are computed algorithmically
 * (nth-weekday-of-month / Easter) rather than hardcoded per year, so this
 * doesn't silently go stale in 2027+.
 *
 * Known simplification: does not model early-close half days (day before
 * July 4th, day after Thanksgiving, Christmas Eve when on a weekday) - those
 * are treated as full sessions. Fine for a gap-risk demo, worth fixing before
 * anything that trades on the close print.
 */

const NY_TZ = "America/New_York";

const nyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

/** Reads a Date's wall-clock parts as they'd appear in America/New_York. */
function nyParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = Object.fromEntries(nyFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday as string] ?? 0,
  };
}

function ymdKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Nth weekday of a month, e.g. 3rd Monday of January. weekday: 0=Sun..6=Sat, n: 1-based. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Last weekday of a month, e.g. last Monday of May. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay));
  const lastWeekday = last.getUTCDay();
  const offset = (lastWeekday - weekday + 7) % 7;
  return new Date(Date.UTC(year, month - 1, lastDay - offset));
}

/** Anonymous Gregorian algorithm for the date of Easter Sunday. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Shifts a fixed holiday to its observed weekday: Sat -> preceding Fri, Sun -> following Mon. */
function observed(date: Date): Date {
  const weekday = date.getUTCDay();
  if (weekday === 6) return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1));
  if (weekday === 0) return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return date;
}

function addDaysUTC(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

const holidayCache = new Map<number, Set<string>>();

function marketHolidaysForYear(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const easter = easterSunday(year);
  const goodFriday = addDaysUTC(easter, -2);

  const dates = [
    observed(new Date(Date.UTC(year, 0, 1))), // New Year's Day
    nthWeekdayOfMonth(year, 1, 1, 3), // MLK Day - 3rd Mon of Jan
    nthWeekdayOfMonth(year, 2, 1, 3), // Presidents Day - 3rd Mon of Feb
    goodFriday,
    lastWeekdayOfMonth(year, 5, 1), // Memorial Day - last Mon of May
    observed(new Date(Date.UTC(year, 5, 19))), // Juneteenth
    observed(new Date(Date.UTC(year, 6, 4))), // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1), // Labor Day - 1st Mon of Sep
    nthWeekdayOfMonth(year, 11, 4, 4), // Thanksgiving - 4th Thu of Nov
    observed(new Date(Date.UTC(year, 11, 25))), // Christmas
  ];

  const set = new Set(dates.map((d) => ymdKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())));
  holidayCache.set(year, set);
  return set;
}

function isMarketHoliday(year: number, month: number, day: number): boolean {
  return marketHolidaysForYear(year).has(ymdKey(year, month, day));
}

export interface MarketState {
  isOpen: boolean;
  /** The next time the market's open/closed state flips. */
  nextTransition: Date;
  msUntilNextTransition: number;
}

/** True if `now` (default: current time) falls within a regular NYSE session. */
export function isMarketOpen(now: Date = new Date()): boolean {
  const p = nyParts(now);
  if (p.weekday === 0 || p.weekday === 6) return false;
  if (isMarketHoliday(p.year, p.month, p.day)) return false;
  const minutesSinceMidnight = p.hour * 60 + p.minute;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight < 16 * 60;
}

const MAX_LOOKAHEAD_MINUTES = 8 * 24 * 60; // 8 days - covers even a holiday-adjacent long weekend

/**
 * Full open/closed state including when it next flips, by walking forward
 * minute by minute (bounded to 8 days - markets never stay in one state
 * longer than a holiday-adjacent long weekend).
 */
export function getMarketState(now: Date = new Date()): MarketState {
  const open = isMarketOpen(now);
  let cursor = new Date(now);

  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++) {
    cursor = new Date(cursor.getTime() + 60_000);
    if (isMarketOpen(cursor) !== open) {
      return { isOpen: open, nextTransition: cursor, msUntilNextTransition: cursor.getTime() - now.getTime() };
    }
  }

  throw new Error("could not resolve next market transition within 8 days - check holiday calendar logic");
}

export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}
