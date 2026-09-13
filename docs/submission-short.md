## The problem

Your broker is open 32 hours a week. For the other 135 — nights, weekends, holidays — your positions are frozen while the news keeps coming. Monday's open has already priced it in. That jump is the **gap**, and retail has no tool for it: futures are institution-sized, weekend puts cost a full weekend of time value, and extended hours don't cover weekends at all.

## The insight

xStocks are tokenized US equities on Solana — 1:1 backed, trading 24/7. While the NYSE is dark they are the only live estimate of what a stock is worth. So the information exists. The question is whether it predicts the open.

I measured that before building anything.

## The signal, measured

`npm run backtest` scores it against real historical gaps — 248 close→open windows over 3 months. The baseline is assuming no gap at all, which is exactly what you're stuck with today. It compares move-vs-move rather than price levels, because xStocks carry a persistent premium (SPYx +0.56%) that would otherwise be baked into every "error".

| Ticker | Error | Baseline | Direction |
| --- | --- | --- | --- |
| SPY | 0.29pp | 0.40pp | 82% |
| QQQ | 0.49pp | 0.81pp | 86% |
| NVDA | 0.92pp | 1.14pp | 78% |
| TSLA | 1.22pp | 1.06pp | 78% |
| **All** | **0.73pp** | **0.85pp** | **81%** |

**Direction is the signal — 81% across 248 windows.** Magnitude overshoots, so sizing off the raw predicted move would over-hedge. And it **fails on TSLA**: 1.22pp against a 1.06pp baseline, worse than doing nothing, because TSLAx's off-hours book is too thin. That's stated up front rather than buried.

## What it does

1. You enter what you hold at your real broker — a ticker and a share count. No brokerage API, no credentials.
2. While the market is shut it tracks the matching xStock's drift from the last real close, and alerts past your threshold.
3. It hedges with a **real on-chain short**: borrow the xStock from Kamino against USDC collateral, sell it on Jupiter.
4. After the open it reconciles — actual gap, what your frozen position moved, how wrong the prediction was, what the hedge earned.

Runs as a local dashboard, a Telegram bot, or both.

## Why a short

A spot sell can't hedge shares sitting at a broker — you'd just be spending money. A hedge has to gain when the stock falls. Kamino's xStocks market lends the token against USDC, so: size collateral for the borrow factor (1.66x SPYx/QQQx, 2.25x NVDAx/TSLAx), borrow, sell. Unwind reverses it. If the sell leg fails you're flat, not short.

## Proven with real transactions

No money to test with, so the full cycle ran against a local **surfpool mainnet fork** — real Kamino and Jupiter programs, real signed transactions, fake funds. Reproducible: `npm run fork:e2e`.

A $50 QQQ short deposited $207.50 collateral, borrowed 0.0698 QQQx and sold it. LTV landed on exactly **40.0%**. Unwind bought back, repaid, withdrew. **5 transactions, ~$0.03 round trip.** That covers first-time Kamino account setup, which a plain simulation can't reach.

## Safety

Per-hedge and trailing-24h caps, a hard 60% LTV ceiling (a short near liquidation could be liquidated by the very gap it's hedging) and a kill switch — enforced in code, not config, so editing `.env` changes the numbers, not whether they're checked.

It holds a hot wallet, so the dashboard is loopback-only plus Host, Origin and custom-header checks that close CSRF and DNS rebinding — a cross-origin `text/plain` POST skips the CORS preflight entirely, so loopback alone isn't enough. All unit-tested. 38 tests.

## Honest limits

Directional signal, not a magnitude. Manual holdings entry. Short legs aren't atomic. Kamino's weekend oracle can stall on a large move. Only SPYx, QQQx, NVDAx and TSLAx are shortable today.

## Why it matters

The usual case for tokenized equities is access — trade US stocks anywhere. That competes with brokers that are already free. This argues something different: the 24/7 tape is **infrastructure**. It's a continuously published, machine-readable estimate of what a US equity is worth during the 135 hours a week when no other estimate exists. Gap hedging is the first application; overnight VaR and weekend risk alerting sit on the same base. And the hedge leg composes Kamino and Jupiter — the primitive is already deployed, it just needed something pointed at it.

## Stack

TypeScript · web3.js + @solana/kit · klend-sdk · Jupiter Price v3 + Swap v1 · SQLite · grammy · vitest · surfpool. The dashboard is one dependency-free HTML file — no CDN, no framework.

```
npm install && cp .env.example .env && npm run dev
```

No account, key or money needed — dry-run uses live prices and simulates hedges.

**github.com/winstontai/gapguard**
