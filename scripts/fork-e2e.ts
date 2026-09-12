/**
 * End-to-end check of the live hedge path against a local mainnet fork, with fake funds:
 * open a real Kamino short (deposit USDC -> borrow xStock -> sell on Jupiter), then unwind it
 * (buy back -> repay -> withdraw collateral). Real programs, real signatures, no real money.
 *
 *   1. Download surfpool (https://github.com/solana-foundation/surfpool/releases)
 *   2. surfpool start --network mainnet --no-tui --no-studio --no-deploy -y \
 *        --airdrop <YOUR_WALLET_PUBKEY> --airdrop-amount 5000000000
 *   3. RUN_MODE=mainnet-live SOLANA_RPC_URL=http://127.0.0.1:8899 \
 *      SOLANA_WS_URL=ws://127.0.0.1:8900 DATABASE_PATH=./data/fork-e2e.sqlite npm run fork:e2e
 *
 * Start the fork immediately before running: it snapshots mainnet accounts when first touched
 * while its clock keeps advancing, so a fork left running for minutes serves oracle prices that
 * Kamino rejects as stale (PriceTooOld / ObligationStale).
 */
import { config } from "../src/config.js";
import { recordHedge } from "../src/hedge/executor.js";
import { getShortContext } from "../src/hedge/kamino.js";
import { USDC_MINT } from "../src/hedge/jupiter.js";
import { SettingsStore } from "../src/settings.js";
import { resolveTicker } from "../src/xstocks/resolver.js";
import { getRawTokenBalance, getSolBalance } from "../src/wallet/balances.js";
import { loadKeypair } from "../src/wallet/keypair.js";
import { listHedgeFillsBetween } from "../src/portfolio/db.js";

// This script signs and sends transactions, so it must never point at a real cluster.
if (!/127\.0\.0\.1|localhost/.test(config.SOLANA_RPC_URL)) {
  throw new Error(`fork:e2e only runs against a local fork, but SOLANA_RPC_URL is ${config.SOLANA_RPC_URL}`);
}

const TICKER = process.env.FORK_TICKER ?? "QQQX";
const SIZE_USD = Number(process.env.FORK_SIZE ?? 50);
const FUND_USDC = Number(process.env.FORK_USDC ?? 500);

const owner = loadKeypair().publicKey;
const xstock = resolveTicker(TICKER);
if (!xstock) throw new Error(`unknown xStock ticker: ${TICKER}`);
const settings = new SettingsStore().get();

/** surfpool cheatcode: give the wallet fake USDC. */
async function fundWithFakeUsdc(amount: number): Promise<void> {
  const res = await fetch(config.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setTokenAccount",
      params: [owner.toBase58(), USDC_MINT, { amount: Math.round(amount * 1e6) }],
    }),
  });
  const body = (await res.json()) as { error?: unknown };
  if (body.error) throw new Error(`surfnet_setTokenAccount failed: ${JSON.stringify(body.error)}`);
}

async function snapshot(label: string): Promise<void> {
  const [sol, usdc, xtok] = await Promise.all([
    getSolBalance(owner),
    getRawTokenBalance(owner, USDC_MINT),
    getRawTokenBalance(owner, xstock.mint),
  ]);
  const ctx = await getShortContext(owner.toBase58(), xstock.mint, xstock.decimals);
  console.log(`\n--- ${label} ---`);
  console.log(
    `wallet: SOL ${sol.toFixed(4)} | USDC $${(Number(usdc) / 1e6).toFixed(2)} | ${TICKER} ${(Number(xtok) / 10 ** xstock.decimals).toFixed(6)}`
  );
  console.log(
    `kamino: collateral $${ctx.account.collateralUsd.toFixed(2)} | debt(BF-adj) $${ctx.account.debtUsdBorrowFactorAdjusted.toFixed(2)} | ` +
      `LTV ${(ctx.account.ltv * 100).toFixed(1)}% | debts ${JSON.stringify(Object.fromEntries(ctx.account.debts))}`
  );
}

await fundWithFakeUsdc(FUND_USDC);
await snapshot("before");

console.log(`\n>>> /hedge ${TICKER} ${SIZE_USD}`);
console.log(JSON.stringify(await recordHedge("open", TICKER, SIZE_USD, settings, "fork:e2e"), null, 2));
await snapshot("after opening the short");

console.log(`\n>>> /unwind ${TICKER} all`);
console.log(JSON.stringify(await recordHedge("unwind", TICKER, "all", settings, "fork:e2e"), null, 2));
await snapshot("after unwinding");

console.log("\nledger:", JSON.stringify(listHedgeFillsBetween(TICKER, 0, Date.now() + 1)));
