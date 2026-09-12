import { config } from "./config.js";
import { logger } from "./logger.js";
import { SettingsStore } from "./settings.js";
import { getDb } from "./portfolio/db.js";
import { getBot, notifyOwner, telegramEnabled } from "./telegram/bot.js";
import { registerCommands } from "./telegram/commands.js";
import { startGapMonitor } from "./market/monitor.js";
import { startWebServer } from "./web/server.js";
import { getMarketState, formatCountdown } from "./market/clock.js";

async function main() {
  logger.info({ mode: config.RUN_MODE, telegram: telegramEnabled }, "starting gapguard");

  // Initializes the schema on first run.
  getDb();

  const settingsStore = new SettingsStore();
  const stopMonitor = startGapMonitor(settingsStore);
  const stopWeb = startWebServer(settingsStore);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  function shutdown() {
    logger.info("shutting down");
    stopMonitor();
    stopWeb();
    if (telegramEnabled) void getBot().stop();
    process.exit(0);
  }

  const market = getMarketState();
  const status = market.isOpen
    ? `Market is open (closes in ${formatCountdown(market.msUntilNextTransition)}).`
    : `Market is closed (reopens in ${formatCountdown(market.msUntilNextTransition)}).`;

  if (!telegramEnabled) {
    logger.warn(`Telegram not configured - running dashboard only on http://127.0.0.1:${config.WEB_PORT}. ${status}`);
    return;
  }

  registerCommands(settingsStore);
  await notifyOwner(
    [
      `Gap Guard started in *${config.RUN_MODE}* mode.`,
      status,
      `Dashboard: http://127.0.0.1:${config.WEB_PORT}`,
      "Add holdings with /holdings add <TICKER> <SHARES>.",
    ].join("\n")
  );
  await getBot().start();
}

main().catch((err) => {
  logger.error({ err }, "fatal error during startup");
  process.exit(1);
});
