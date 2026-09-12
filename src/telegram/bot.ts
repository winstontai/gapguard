import { Bot } from "grammy";
import { config } from "../config.js";
import { logger } from "../logger.js";

/** Telegram is optional. Without a token the dashboard and monitor still run; alerts just aren't sent. */
export const telegramEnabled = config.TELEGRAM_BOT_TOKEN !== "" && config.TELEGRAM_OWNER_CHAT_ID !== "";

let cached: Bot | null = null;

export function getBot(): Bot {
  if (!telegramEnabled) {
    throw new Error("Telegram is not configured - set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID");
  }
  if (!cached) {
    const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
    // Refuses every update that isn't from the configured owner chat - this bot controls a live wallet.
    bot.use(async (ctx, next) => {
      const chatId = String(ctx.chat?.id ?? "");
      if (chatId !== config.TELEGRAM_OWNER_CHAT_ID) {
        logger.warn({ chatId, from: ctx.from?.username }, "rejected message from non-owner chat");
        return;
      }
      await next();
    });
    bot.catch((err) => {
      logger.error({ err: err.error }, "telegram bot error");
    });
    cached = bot;
  }
  return cached;
}

export async function notifyOwner(text: string): Promise<void> {
  if (!telegramEnabled) {
    logger.info({ alert: text }, "telegram not configured - alert not sent");
    return;
  }
  try {
    await getBot().api.sendMessage(config.TELEGRAM_OWNER_CHAT_ID, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "failed to notify owner via telegram");
  }
}
