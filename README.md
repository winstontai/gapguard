# Gap Guard

A weekend/overnight gap-risk guard for a **real** stock portfolio, built for the
[Stocklana hackathon](https://hackathons.solana.com/hackathons/stocklana).

Your broker is only open ~6.5 hours a day, Monday-Friday. The rest of the time (nights, weekends,
holidays) your real positions sit there exposed, with no way to react until the market reopens.
[xStocks](https://docs.xstocks.fi/docs) are tokenized US equities on Solana, 1:1 backed and trading
24/7. They don't have that problem: price discovery for AAPL, TSLA, NVDA and the rest keeps happening
around the clock.

Gap Guard turns that into a tool:
- You tell it what you actually hold.
- It watches the matching xStock drift from the real market's last close while your broker is dark,
  and alerts you past a threshold.
- It hedges with a **real on-chain short**: borrow the xStock from Kamino, sell it.
- After the open, it reconciles what really happened: how far the stock gapped, what your position
  moved while you couldn't act, how well the 24/7 market called the open, and what the hedge was
  worth.

It runs as a **local dashboard**, a **Telegram bot**, or both — Telegram is optional, so you can try
the whole thing with no accounts and no money.

## Quickstart

```bash
npm install && cp .env.example .env
npm run dev                # dashboard on http://127.0.0.1:8788
```

That's the whole setup. No account, no key, no money: dry-run mode uses live xStock and stock prices
and simulates hedges. From there:

```bash
npm run backtest           # score the core claim against real historical gaps
npm test                   # unit tests, no network needed
npm run fork:e2e           # the real hedge path on a local mainnet fork, with fake funds
```

## Does the tape actually predict the open?

`npm run backtest` scores the core claim. For every close → open window it compares how far the
xStock moved while the market was shut against how far the stock actually gapped, in percentage
points. The baseline is assuming no gap at all — which is what you're stuck with when your broker
is closed.

248 windows across 3 months (to Sept 2026):

| Ticker | Windows | Mean abs error | Baseline | Direction called |
| --- | --- | --- | --- | --- |
| SPY | 62 | 0.29pp | 0.40pp | 42/51 (82%) |
| QQQ | 62 | 0.49pp | 0.81pp | 48/56 (86%) |
| NVDA | 62 | 0.92pp | 1.14pp | 47/60 (78%) |
| TSLA | 62 | 1.22pp | 1.06pp | 42/54 (78%) |
| **All** | **248** | **0.73pp** | **0.85pp** | **179/221 (81%)** |

Read honestly:
- **Direction is the real signal.** 81% of the time the tape called which way the stock would open.
- **Magnitude overshoots.** Predicted moves run consistently larger than the realised gap, so sizing
  a hedge off the raw predicted move would over-hedge.
- **It fails on TSLA** — 1.22pp error against a 1.06pp baseline. TSLAx's thinner off-hours liquidity
  overshoots badly (one weekend predicted +3.66% against a −0.44% actual). The index xStocks are
  where this works, and they're also the ones Kamino lends at the lowest borrow factor.
- **xStocks carry a small persistent premium** to the underlying (SPYx +0.56%, QQQx +0.28% on
  average). That's why the report measures move-vs-move rather than comparing price levels, which
  would silently bake the premium into every "error".

## Status

Implemented and verified against live data:
- **Live xStock pricing** via Jupiter Price API v3.
- **Real-market prices and official daily open/close** via Yahoo Finance's chart endpoint (free,
  no key).
- **NYSE market clock** with an algorithmic holiday calendar.
- **Gap per holding and a background monitor.** It records a price snapshot every poll and sends one
  alert per ticker per closed session.
- **Close → open reconciliation** (`/report`, also pushed automatically once the official open
  prints). If the monitor wasn't running for that window, it backfills the tape once from DEX
  history, so the report works without days of prior uptime.
- **Real shorts on Kamino** in `mainnet-live` (see "How a hedge works").
- **Local dashboard** on `http://127.0.0.1:8788` with the same state and actions as the bot.
- **Risk limits**: per-hedge cap, daily cap, minimum interval, `/pause`, and an LTV ceiling.

### Verified end to end on a mainnet fork

The whole hedge cycle has been run against a local [surfpool](https://github.com/solana-foundation/surfpool)
fork of mainnet — real Kamino and Jupiter programs, real signed transactions, fake funds. Reproduce
it with `npm run fork:e2e` (see "Testing without money"). A $50 QQQ short:

| Step | Result |
| --- | --- |
| `/hedge QQQ 50` | Deposited $207.50 USDC collateral, borrowed 0.0698 QQQx, sold it on Jupiter. LTV landed on exactly 40.0%, debt $83.06 (= $50 × the 1.66 borrow factor). 2 transactions. |
| `/unwind QQQ all` | Bought the xStock back, repaid Kamino, withdrew all collateral. 3 transactions. |
| Round trip | USDC $500 → $498.31 with 0.0023 QQQx (~$1.66) of buyback dust left over, so about $0.03 in fees, price impact and interest. |
| SOL | 5.0 → 4.966 for first-time account rent, refunded to 4.990 when the accounts closed. |

That run covered the first-time Kamino account setup, which is the path a plain mainnet simulation
can't reach. What a fork can't prove: real fills at real depth, and oracle behaviour on a real
weekend.

## Dashboard

```bash
npm run dev          # then open http://127.0.0.1:8788
```

It shows, and refreshes every 20 seconds:
- **Market state** — open or closed, with a countdown and your total exposure while it's shut.
- **Holdings** — shares, the real market's last close, exposure, the live xStock price, and the gap
  between them. Add or remove holdings inline.
- **Open shorts** — Kamino collateral, borrow-factor-adjusted debt and an LTV bar against the
  liquidation threshold in `mainnet-live`; net simulated shorts with their P&L otherwise. One-click
  unwind.
- **Close → open reconciliation** — the same report the bot posts after the open.
- **Recent hedges** — the ledger, with Solscan links for real transactions.
- **Limits** — caps, 24h usage, and the kill switch.

The server binds to loopback only, and action routes additionally require a loopback client, because
in `mainnet-live` those buttons sign transactions. Refusals from the risk limits surface in the UI
exactly as they do in Telegram (e.g. asking for a $150 short against a $100 per-hedge cap).

## How a hedge works

**Opening a short** (`/hedge QQQ 50`):
1. Checks spending caps, the kill switch, and that Kamino will lend the xStock. As of Sept 2026 that's
   SPYx, QQQx, NVDAx, and TSLAx. AAPLx and the others are collateral-only, so hedge those holdings
   through SPY or QQQ.
2. Sizes USDC collateral so the loan sits at `HEDGE_TARGET_LTV` after the borrow, including Kamino's
   borrow factor. Refuses anything that would open above 60% LTV.
3. Deposits any collateral shortfall and borrows the xStock, in one transaction.
4. Sells the borrowed xStock for USDC through Jupiter. If this leg fails you're flat, not short
   (the wallet holds what it borrowed), and `/unwind <TICKER> all` repays it.

**Closing a short** (`/unwind QQQ all`, or a USD amount):
1. Buys the xStock back through Jupiter. It adds 0.5% for accrued interest and subtracts anything
   already in the wallet.
2. Repays Kamino.
3. On a full close with no other debt, withdraws all USDC collateral.

Dry-run modes record the same trades at the live price without signing. `/report`'s P&L math is
identical in both modes.

## Funding the hot wallet

You don't need any money to try Gap Guard: dry-run mode uses live prices without signing, and
`npm run fork:e2e` exercises the real hedge path with fake funds. The numbers below only matter for
`mainnet-live` with real money.

Kamino weights xStock debt by a borrow factor, so collateral is several times the short's size.
These are live values from Sept 2026, at the default 40% target LTV:

| Short on | Borrow factor | USDC collateral for a $50 short |
| --- | --- | --- |
| SPY, QQQ | 1.66 | $207.50 |
| NVDA, TSLA | 2.25 | $281.25 |

Also keep:
- **~0.04 SOL** for first-time account rent (mostly refunded when the position closes), plus fees.
- **Spare USDC**, about 20% of the short's size, beyond the collateral. If the stock rises, the
  buyback costs more than the sale brought in, and the collateral stays locked until the loan is
  repaid.

`/wallet`, or the dashboard header, shows the address and balances.

## Telegram commands

Optional — leave the token blank to run dashboard-only.

| Command | What it does |
| --- | --- |
| `/holdings add <TICKER> <SHARES>` | Track a real position, e.g. `/holdings add AAPL 100` |
| `/holdings`, `/holdings remove <id>`, `/holdings clear` | List or remove tracked positions |
| `/status` | Market state, live gap and exposure per holding, and open shorts |
| `/hedge <TICKER> <USD>` | Open a short: real in `mainnet-live`, simulated otherwise |
| `/unwind <TICKER> <USD\|all>` | Close some or all of a short |
| `/report` | Reconciliation for the most recent close → open |
| `/wallet` | Hot wallet address, SOL and USDC balances |
| `/pause`, `/resume` | Kill switch |
| `/limits maxPerHedge <USD>`, `/limits maxDaily <USD>`, `/limits gapThreshold <PCT>` | Adjust limits |

## Real-market ticker coverage

Only xStocks with a **confidently verified** mapping to a real, publicly listed ticker are tracked
(see the `_comment` in `data/underlying-map.json`).

**Supported now:** AAPL, TSLA, NVDA, GOOGL, AMZN, META, MSFT, SPY, QQQ, GLD, COIN, HOOD, PLTR, MSTR,
GME, MCD, KO, INTC. Shorting additionally depends on Kamino lending the xStock (see "How a hedge works").

**Deliberately excluded:**
- BRKX, SPCXX, STRCX: the mapping isn't verified.
- The Tessera/PreStocks/Sunrise entries in `data/xstocks.json`: private companies or non-equity
  instruments with no real NYSE/Nasdaq close to gap against.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Every value in `.env.example` has a working default, so the file runs as-is. Worth setting:
- `WALLET_KEYPAIR_PATH`: a **dedicated burner keypair** stored outside the repo, and outside
  OneDrive or any other synced folder. **Only `mainnet-live` requires one** - dry-run never signs,
  so leave it blank to look around.
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_OWNER_CHAT_ID`: **optional**. Leave blank for dashboard-only;
  fill them in (free, via [@BotFather](https://t.me/BotFather) and
  [@userinfobot](https://t.me/userinfobot)) to get push alerts and bot commands.
- `SOLANA_RPC_URL` / `SOLANA_WS_URL`: a paid provider (Helius, Triton, etc.) for `mainnet-live`.
  Public RPC rate-limits Kamino market loads.
- `WEB_PORT`: dashboard port, default 8788.
- `HEDGE_TARGET_LTV`: defaults to 0.4; code refuses anything above 0.6.
- `RUN_MODE`: start in `mainnet-dry-run`.

## Run modes

- `mainnet-dry-run` is the default. It does real reads and gap math, and simulates hedges.
- `mainnet-live` opens and closes real Kamino shorts.
- `devnet` covers generic Solana plumbing only, since xStocks, Kamino and Jupiter are mainnet-only.

## Testing without money (mainnet fork)

[surfpool](https://github.com/solana-foundation/surfpool) runs a local validator that lazily copies
real mainnet accounts, so Kamino, Jupiter and the xStock mints all behave like the real thing while
the funds are fake.

```bash
# 1. Download surfpool for your platform from the releases page, then start a fresh fork:
surfpool start --network mainnet --no-tui --no-studio --no-deploy -y \
  --airdrop <YOUR_WALLET_PUBKEY> --airdrop-amount 5000000000

# 2. Run the full open -> unwind cycle against it (mints its own fake USDC):
RUN_MODE=mainnet-live SOLANA_RPC_URL=http://127.0.0.1:8899 SOLANA_WS_URL=ws://127.0.0.1:8900 \
  DATABASE_PATH=./data/fork-e2e.sqlite npm run fork:e2e
```

**Start the fork immediately before running.** It snapshots each mainnet account the first time it's
touched while its own clock keeps advancing, so a fork left idle for a few minutes serves oracle
prices that Kamino rejects as stale (`PriceTooOld` / `ObligationStale`). The script refuses to run
against any non-local RPC, since it signs and sends real transactions.

## Safety rails

- **Kill switch:** `/pause`, or the dashboard button, blocks every hedge and unwind until resumed.
- **Spending caps are enforced in code.** Editing `.env` only changes the cap values; the
  enforcement lives in `src/hedge/riskLimits.ts`. Unwinds skip the caps because closing a short only
  reduces risk.
- **LTV ceiling:** a short can't open above 60% LTV, regardless of config.
- **The dashboard is loopback-only**, since its buttons can sign transactions.
- Never commit `.env` or any wallet keypair JSON. Both are already gitignored.

## Security

This thing holds a hot wallet and can sign transactions, so the threat model is taken seriously.

**The dashboard is the sharpest edge.** Binding to loopback is not enough on its own: a malicious
page in your own browser can also reach `127.0.0.1`, and a "simple" cross-origin POST (a `text/plain`
body) skips the CORS preflight entirely — so a website you happen to visit could fire a hedge without
ever reading the response. `src/web/guard.ts` closes that:

| Check | Stops |
| --- | --- |
| Socket must be loopback | Anything off-box |
| `Host` must name loopback | DNS rebinding (the attacker's domain shows up here) |
| `Origin`, when sent, must be this dashboard | Cross-origin calls |
| Mutating requests need `X-Gap-Guard: 1` | CSRF — a custom header forces a preflight this server never approves |

All four are unit-tested in `test/guard.test.ts`. Everything the page renders through `innerHTML` is
escaped, since error text comes from upstream APIs rather than from this app.

**Wallet and secrets.** Use a dedicated burner keypair kept outside the repo and outside any synced
folder. `.env` and `wallet*.json` are gitignored, and the logger redacts key-shaped values so a
secret can't leak through a log line. Nothing ever prints a private key.

**Spending.** Per-hedge and daily caps, a minimum interval, an LTV ceiling and the `/pause` kill
switch are enforced in `src/hedge/riskLimits.ts`, not in config — editing `.env` changes the numbers,
not whether they're checked. Unwinds deliberately skip the caps, since closing a short only reduces
risk, but still respect the kill switch.

**Database.** Every query is a parameterized prepared statement; no SQL is built by string
concatenation. There is no `eval`, no shell execution, and no user-controlled file path anywhere in
the codebase.

**Dependencies.** `npm audit` reports 20 advisories (12 high, 8 moderate), every one of them
transitive through `@kamino-finance/klend-sdk` and `@solana/web3.js` — mostly `bigint-buffer`,
`toml`, `uuid` and `stream-json`. None are reachable from untrusted input in this app's usage, and
`npm audit fix --force` downgrades the Kamino SDK past the API this project is built on. They're
documented rather than silently "fixed".

## Known limitations

- **The signal is directional, not a magnitude.** See the backtest: the tape overshoots how far the
  stock will gap, and on TSLA it's worse than assuming no gap at all.
- **Holdings are manual entry:** a ticker plus a share count, with no brokerage API.
- **A short's legs are separate transactions, not atomic.** Opening is borrow then sell; closing is
  buy then repay. Each failure leaves the position flat, or reports how to finish it.
- **Closing leaves dust.** The buyback adds 0.5% for accrued interest, so a full unwind leaves a
  small xStock balance in the wallet (~$1.66 on a $50 short). Kamino's flash-loan "repay with
  collateral" isn't integrated.
- **Closing needs USDC in the wallet for the buyback**, since collateral is locked until the loan is
  repaid.
- **Weekend oracle risk.** Kamino accepts off-hours xStock prices only within a band around the last
  close, so a large weekend move could stall its oracle exactly when a hedge is wanted. Gap Guard
  detects that failure and explains it rather than surfacing a raw program error.
- **Backfilled history is one pool's tape** (the deepest DEX pool), while the live path uses
  Jupiter's aggregate price. Close, but not identical.
- **Dividend multiplier.** xStocks apply a dividend multiplier to UI amounts, while Kamino and
  Jupiter work in base units. Gap Guard uses base units throughout, so sizing a short from the
  Jupiter USD price can be off by that multiplier.
- **`/report` uses current share counts**, not your holdings as they were during the closed session.
  It counts a hedge only in the close → open window where it was placed.
- **Early-close half days aren't modeled.**
- **The automatic post-open report lives in memory** — after a restart, run `/report` manually.

## Tests

```bash
npm test           # unit tests, no network or wallet needed
npm run backtest   # score the tape against real gaps (see above); accepts tickers, e.g. -- QQQ SPY
npm run fork:e2e   # full hedge cycle against a local mainnet fork
```

Unit tests cover:
- the dashboard request guard (CSRF, DNS rebinding, cross-origin, loopback)
- the market clock (session boundaries, holiday observance)
- hedge P&L accounting
- close → open window selection and tape lookups
- short sizing: collateral top-up through the borrow factor, buyback headroom, and base-unit
  rounding

## Project layout

**Market data and signal**
- `src/market/clock.ts`: NYSE open/closed state and holiday calendar.
- `src/market/priceFeed.ts`: live xStock USD price (Jupiter Price API v3).
- `src/market/referenceClose.ts`: real-market reference price and official daily bars (Yahoo).
- `src/market/priceHistory.ts`: historical xStock tape from DEX pools (GeckoTerminal), rate-limited.
- `src/market/gap.ts`: combines those into a `GapReading` per ticker.
- `src/market/monitor.ts`: background poll, threshold alerts, and the post-open report.
- `src/market/reconcile.ts`, `src/market/reconcileMath.ts`: close → open reconciliation and its
  pure math.

**Hedging**
- `src/hedge/executor.ts`: opens and closes shorts (live) or records them (dry-run).
- `src/hedge/kamino.ts`: Kamino xStocks Market reads, transaction building, simulation, and sending.
- `src/hedge/jupiter.ts`: Jupiter Swap API v1 quote/sign/send.
- `src/hedge/shortMath.ts`: collateral sizing, buyback headroom, base-unit conversion.
- `src/hedge/riskLimits.ts`: spending caps, kill switch, and LTV ceiling.

**Interfaces, wallet, tickers, storage**
- `src/web/server.ts`, `src/web/index.html`: the local dashboard and its JSON API.
- `src/telegram/`: bot (optional), commands, and message formatting.
- `src/wallet/`: keypair, RPC connection, balances, and send/confirm/simulate helpers.
- `src/xstocks/`: xStock ticker → mint registry and xStock ↔ real ticker mapping.
- `src/portfolio/db.ts`: holdings, hedge ledger, and price snapshots (SQLite).
- `scripts/backtest.ts`: scores the tape against real gaps.
- `scripts/fork-e2e.ts`: the mainnet-fork end-to-end check.
- `scripts/copy-assets.mjs`: copies runtime assets (SQL schema, dashboard HTML) into `dist` on build.
