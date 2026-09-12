import { z } from "zod";
import { config } from "./config.js";
import { getSettingsOverrides, setSettingOverride } from "./portfolio/db.js";

/**
 * Tunable operating parameters, distinct from config.ts (secrets/env plumbing).
 * Adjustable at runtime via Telegram /limits commands; persisted overrides
 * live in portfolio/db.ts and are merged over these defaults at boot.
 */
export const settingsSchema = z.object({
  maxUsdPerHedge: z.number().positive(),
  maxDailyUsd: z.number().positive(),
  minSecondsBetweenHedges: z.number().nonnegative(),
  gapAlertThresholdPct: z.number().nonnegative(),
  paused: z.boolean().default(false),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({
    maxUsdPerHedge: config.MAX_USD_PER_HEDGE,
    maxDailyUsd: config.MAX_DAILY_USD,
    minSecondsBetweenHedges: config.MIN_SECONDS_BETWEEN_HEDGES,
    gapAlertThresholdPct: config.GAP_ALERT_THRESHOLD_PCT,
    paused: false,
  });
}

/**
 * Merges persisted overrides on top of defaults, and exposes a mutator that
 * both updates the in-memory value and persists it, so a restart doesn't
 * silently revert a /limits change or a /pause.
 */
export class SettingsStore {
  private current: Settings;

  constructor() {
    const overrides = getSettingsOverrides();
    this.current = settingsSchema.parse({ ...defaultSettings(), ...overrides });
  }

  get(): Settings {
    return this.current;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const updated = settingsSchema.parse({ ...this.current, [key]: value });
    this.current = updated;
    setSettingOverride(key, value);
  }
}
