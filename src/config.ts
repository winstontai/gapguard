import "dotenv/config";
import { z } from "zod";

const runModeSchema = z.enum(["devnet", "mainnet-dry-run", "mainnet-live"]);

const envSchema = z
  .object({
    RUN_MODE: runModeSchema,
    SOLANA_RPC_URL: z.string().url(),
    SOLANA_WS_URL: z.string().url(),
    WALLET_PRIVATE_KEY: z.string().optional().default(""),
    WALLET_KEYPAIR_PATH: z.string().optional().default(""),
    // Optional: leave both blank to run the dashboard and monitor without a Telegram bot.
    TELEGRAM_BOT_TOKEN: z.string().default(""),
    TELEGRAM_OWNER_CHAT_ID: z.string().default(""),
    DATABASE_PATH: z.string().default("./data/gapguard.sqlite"),
    WEB_PORT: z.coerce.number().int().positive().default(8788),
    JUPITER_PRICE_BASE_URL: z.string().url().default("https://lite-api.jup.ag/price/v3"),
    JUPITER_SWAP_BASE_URL: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
    JUPITER_API_KEY: z.string().optional().default(""),
    KAMINO_XSTOCKS_MARKET: z.string().default("5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua"),
    // LTV a short is opened at. The hard 0.6 ceiling is deliberate: a weekend gap can't be hedged
    // by a position that gets liquidated on the same gap.
    HEDGE_TARGET_LTV: z.coerce.number().positive().max(0.6).default(0.4),
    MAX_USD_PER_HEDGE: z.coerce.number().positive(),
    MAX_DAILY_USD: z.coerce.number().positive(),
    MIN_SECONDS_BETWEEN_HEDGES: z.coerce.number().nonnegative(),
    GAP_ALERT_THRESHOLD_PCT: z.coerce.number().nonnegative().default(2),
    GAP_POLL_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
    LOG_LEVEL: z.string().default("info"),
  })
  // Only mainnet-live ever signs, so dry-run works with no wallet at all - that keeps the
  // "clone it and run it" path free of key generation.
  .refine((env) => env.RUN_MODE !== "mainnet-live" || env.WALLET_PRIVATE_KEY || env.WALLET_KEYPAIR_PATH, {
    message: "mainnet-live needs a wallet: set WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH",
    path: ["WALLET_PRIVATE_KEY"],
  })
  .refine((env) => env.MAX_USD_PER_HEDGE <= env.MAX_DAILY_USD, {
    message: "MAX_USD_PER_HEDGE cannot exceed MAX_DAILY_USD",
    path: ["MAX_USD_PER_HEDGE"],
  });

export type RunMode = z.infer<typeof runModeSchema>;

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();

export const isLiveMode = config.RUN_MODE === "mainnet-live";
export const isDryRunMode = config.RUN_MODE === "mainnet-dry-run";
export const isDevnetMode = config.RUN_MODE === "devnet";
