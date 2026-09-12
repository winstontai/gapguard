import pino from "pino";
import { config } from "./config.js";

/**
 * Redacts key-shaped values from every log sink (including whatever forwards
 * logs to Telegram) so a wallet secret can never leak through a log line.
 */
const SECRET_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/; // base58 secret key shape

function redactSecrets(value: unknown): unknown {
  if (typeof value === "string" && SECRET_KEY_PATTERN.test(value)) {
    return "[redacted]";
  }
  return value;
}

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ["*.privateKey", "*.secretKey", "*.WALLET_PRIVATE_KEY", "*.password"],
    censor: "[redacted]",
  },
  formatters: {
    log(obj) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = redactSecrets(v);
      }
      return out;
    },
  },
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});
