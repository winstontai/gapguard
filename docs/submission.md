# Gap Guard

**Hedging the hours your broker is closed, using stocks that never stop trading.**

## The problem

A US brokerage account is open six and a half hours a day, five days a week. That is 32 of the 168
hours in a week. For the other **135 hours** — every night, every weekend, every holiday — your
positions are frozen and the world is not.

Earnings leak on a Friday evening. A supplier blows up on a Saturday. A central bank moves on a
Sunday night. You watch it happen, you know roughly what it means for your portfolio, and you can do
exactly nothing until 9:30am Monday, when the stock opens at a price that already reflects all of
it. That jump is the **gap**, and retail has no tool for it. Institutions hedge overnight risk with
futures and swaps; a person holding 100 shares of NVDA does not.

## The insight

[xStocks](https://docs.xstocks.fi/docs) are tokenized US equities on Solana — 1:1 backed by the real
shares, and trading **24/7** on DEXs. While the NYSE is dark, NVDAx, SPYx and QQQx keep finding a
price.

So the information exists. Somebody is trading the weekend news. The question is whether that
off-hours tape actually predicts where the real stock opens — and if it does, whether you can act on
it.

I measured it first, then built the tool.

## What Gap Guard does

1. **You tell it what you actually hold** at your real broker — a ticker and a share count. No
   brokerage API, no account linking, no credentials.
2. **While the market is closed, it watches** the matching xStock drift away from the real market's
   last close, and alerts you past a threshold you set.
3. **It hedges with a real on-chain short**: borrow the xStock from Kamino against USDC collateral,
   sell it on Jupiter. If the stock gaps down, the short gains roughly what your real shares lose.
4. **After the open, it reconciles.** How far did the stock actually gap? How much did your frozen
   position move? How well did the 24/7 tape call it? What was the hedge worth? Every number, after
   the fact.

It runs as a **local dashboard**, a **Telegram bot**, or both. Telegram is optional, so the whole
thing can be tried with no accounts and no money.

## Does the tape actually predict the open?

This is the load-bearing claim, so it is measured rather than asserted. `npm run backtest` scores it
against real historical gaps: for every close → open window it compares how far the xStock moved
while the market was shut against how far the stock actually gapped, in percentage points. The
baseline is **assuming no gap at all** — which is what you are stuck with today.

**248 windows across 3 months (to Sept 2026):**

| Ticker | Windows | Mean abs error | Baseline | Direction called |
| --- | --- | --- | --- | --- |
| SPY | 62 | 0.29pp | 0.40pp | 42/51 (82%) |
| QQQ | 62 | 0.49pp | 0.81pp | 48/56 (86%) |
| NVDA | 62 | 0.92pp | 1.14pp | 47/60 (78%) |
| TSLA | 62 | 1.22pp | 1.06pp | 42/54 (78%) |
| **All** | **248** | **0.73pp** | **0.85pp** | **179/221 (81%)** |

Read honestly:

- **Direction is the real signal.** 81% of the time, the off-hours tape called which way the stock
  would open.
- **Magnitude overshoots.** Predicted moves run consistently larger than the realised gap, so sizing
  a hedge off the raw predicted move would over-hedge.
- **It fails on TSLA** — 1.22pp error against a 1.06pp baseline, worse than doing nothing. TSLAx's
  thinner off-hours liquidity overshoots badly; one weekend it predicted +3.66% against a −0.44%
  actual. The index xStocks are where this works, and they are also the ones Kamino lends at the
  lowest borrow factor.
- **xStocks carry a small persistent premium** to the underlying (SPYx +0.56%, QQQx +0.28% on
  average). The report measures move-vs-move rather than comparing price levels, which would
  silently bake that premium into every "error".

## How it works

### The signal

- **Live xStock price** from Jupiter Price API v3.
- **Real-market reference close and official daily open/close bars** from Yahoo Finance's chart
  endpoint (free, no key).
- **NYSE market clock** with an algorithmic holiday calendar — nth-weekday rules and a computed
  Easter for Good Friday — rather than a hardcoded list that silently expires.
- **Historical off-hours tape** from GeckoTerminal's free API, rate-limited through a serialized
  request queue. Used both for the backtest and to backfill a reconciliation when the monitor was
  not running, so the report works without days of prior uptime.
- A background monitor polls, records a price snapshot each cycle, and sends **one alert per ticker
  per closed session** rather than spamming a threshold as it oscillates.

### The hedge

A spot sell cannot hedge shares sitting at a broker. A hedge has to be a **short**, so Gap Guard
uses Kamino's xStocks lending market (`5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua`).

**Opening** (`/hedge QQQ 50`):

1. Check spending caps, the kill switch, and that Kamino will lend that xStock.
2. Size USDC collateral so the loan sits at the target LTV *after* the borrow, including Kamino's
   borrow factor. Kamino weights xStock debt heavily — 1.66x for SPYx/QQQx, 2.25x for NVDAx/TSLAx —
   so a $50 short needs $207.50 of collateral at a 40% target.
3. Deposit the collateral shortfall and borrow the xStock, in one transaction.
4. Sell the borrowed xStock for USDC through Jupiter.

If the sell leg fails you are flat, not short — the wallet simply holds what it borrowed — and
`/unwind <TICKER> all` repays it.

**Closing** (`/unwind QQQ all`):

1. Buy the xStock back through Jupiter, adding 0.5% headroom for accrued interest and subtracting
   anything already in the wallet.
2. Repay Kamino.
3. On a full close with no other debt, withdraw all USDC collateral.

Dry-run mode records the identical trades at live prices without ever signing, and the P&L math is
the same in both modes.

### Verified end to end on a mainnet fork

I had no money to test this with, so the whole hedge cycle was run against a local
[surfpool](https://github.com/solana-foundation/surfpool) fork of mainnet — **real Kamino programs,
real Jupiter routes, real signed transactions, fake funds**. Reproducible with `npm run fork:e2e`.

A $50 QQQ short:

| Step | Result |
| --- | --- |
| `/hedge QQQ 50` | Deposited $207.50 USDC collateral, borrowed 0.0698 QQQx, sold it on Jupiter. LTV landed on exactly **40.0%**, debt $83.06 (= $50 x the 1.66 borrow factor). 2 transactions. |
| `/unwind QQQ all` | Bought the xStock back, repaid Kamino, withdrew all collateral. 3 transactions. |
| Round trip | USDC $500 → $498.31, with ~$1.66 of buyback dust left over — about **$0.03** in fees, price impact and interest. |
| SOL | 5.0 → 4.966 for first-time account rent, refunded to 4.990 when the accounts closed. |

That run covered first-time Kamino account setup, which a plain mainnet simulation cannot reach.
What a fork cannot prove: real fills at real depth, and oracle behaviour on a real weekend.

## Security

This holds a hot wallet and can sign transactions, so the threat model is taken seriously.

**The dashboard is the sharpest edge.** Binding to loopback is not enough on its own: a malicious
page in your own browser can also reach `127.0.0.1`, and a "simple" cross-origin POST with a
`text/plain` body skips the CORS preflight entirely — so a site you happen to visit could fire a
hedge without ever reading the response. Four layers close that, all unit-tested:

| Check | Stops |
| --- | --- |
| Socket must be loopback | Anything off-box |
| `Host` must name loopback | DNS rebinding — the attacker's domain shows up here |
| `Origin`, when sent, must be this dashboard | Cross-origin calls |
| Mutating requests need `X-Gap-Guard: 1` | CSRF — a custom header forces a preflight this server never approves |

Everything rendered through `innerHTML` is escaped, since error text comes from upstream APIs rather
than from this app. Spending caps, the minimum interval between hedges, a hard 60% LTV ceiling and
the `/pause` kill switch are enforced in `src/hedge/riskLimits.ts` — editing `.env` changes the
numbers, not whether they are checked. Every SQL query is a parameterized prepared statement. There
is no `eval`, no shell execution, and no user-controlled file path anywhere in the codebase. The
logger redacts key-shaped values so a secret cannot leak through a log line.

Known dependency advisories are documented rather than silently "fixed": all are transitive through
the Kamino SDK and web3.js, none are reachable from untrusted input in this app's usage, and
`npm audit fix --force` downgrades the Kamino SDK past the API this is built on.

## Honest limitations

- **The signal is directional, not a magnitude.** The tape overshoots how far the stock will gap,
  and on TSLA it is worse than assuming no gap at all.
- **Holdings are manual entry** — a ticker and a share count, with no brokerage API.
- **A short's legs are separate transactions, not atomic.** Each failure mode leaves the position
  flat, or reports how to finish it.
- **Closing leaves dust** (~$1.66 on a $50 short), because the buyback adds interest headroom.
  Kamino's flash-loan "repay with collateral" is not integrated.
- **Weekend oracle risk.** Kamino accepts off-hours xStock prices only within a band around the last
  close, so a large weekend move could stall its oracle exactly when a hedge is wanted. Gap Guard
  detects that and explains it rather than surfacing a raw program error.
- **Only some xStocks are shortable.** Kamino lends SPYx, QQQx, NVDAx and TSLAx as of Sept 2026;
  AAPLx and the rest are collateral-only, so those holdings hedge through SPY or QQQ.
- **Early-close half days are not modeled.**

## Tech

TypeScript (ESM/NodeNext) · Solana web3.js + `@solana/kit` · `@kamino-finance/klend-sdk` · Jupiter
Price v3 and Swap v1 · better-sqlite3 · grammy (Telegram) · zod · pino · vitest · surfpool for the
mainnet fork.

The dashboard is a single dependency-free HTML file served from `node:http` — no CDN, no build step,
no framework. 38 unit tests cover the request guard, the market clock, hedge P&L accounting,
close → open window selection, and short sizing math.

## Try it

```bash
npm install && cp .env.example .env
npm run dev                # dashboard on http://127.0.0.1:8788
```

No account, no key, no money — dry-run uses live prices and simulates hedges.

```bash
npm run backtest           # score the core claim against real historical gaps
npm test                   # unit tests, no network needed
npm run fork:e2e           # the real hedge path on a local mainnet fork, with fake funds
```

**Repo:** https://github.com/winstontai/gapguard
