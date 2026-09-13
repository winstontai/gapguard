# Gap Guard

**Hedging the hours your broker is closed, using stocks that never stop trading.**

Your broker is open 32 hours a week. Tokenized stocks on Solana trade all 168. Gap Guard reads the
price discovery happening in those other 135 hours, tells you what your frozen portfolio is exposed
to, and lets you hedge it with a real on-chain short — then, after the open, shows you exactly how
right or wrong it was.

The core claim is measured, not asserted: across **248 close-to-open windows**, the off-hours tape
called the direction of the next open **81% of the time**. The full hedge cycle has been executed
end to end — real Kamino programs, real Jupiter routes, real signed transactions — on a local
mainnet fork.

---

## 1. The problem

A US brokerage account is open six and a half hours a day, five days a week. That is 32 of the 168
hours in a week. For the other **135 hours** — every night, every weekend, every market holiday —
your positions are frozen and the world is not.

Earnings leak on a Friday evening. A supplier catches fire on a Saturday. A central bank moves on a
Sunday night. A regulator publishes on a holiday Monday. You watch it happen in real time, you
understand roughly what it means for the things you own, and you can do exactly nothing until 9:30am
on the next trading day — at which point the stock does not open where it closed. It opens at a price
that has already absorbed everything that happened while you were locked out.

That jump is the **gap**, and it is where a meaningful share of retail equity risk actually lives.
An investor who watches the intraday tape obsessively is managing the 32 hours and ignoring the 135.

### Why retail has nothing for this

Institutions hedge overnight and weekend exposure routinely — index futures, total-return swaps,
options, an internal book that nets exposure across desks. All of that is either inaccessible,
uneconomic, or both for someone holding 100 shares of NVDA:

- **Futures** require a separate account, a margin regime, and contract sizes far larger than a
  retail position. One ES contract is roughly $300k of notional.
- **Options** are available, but weekend gap protection through puts means paying for a full
  weekend of time value on every position you want covered, and the bid/ask on short-dated
  single-name options eats the hedge.
- **Extended-hours trading** at a retail broker covers 4am–8pm ET on weekdays. It does not cover
  weekends at all, which is where the largest unhedgeable jumps happen, and it is thin enough that
  it often cannot be transacted in size.
- **Crypto perps on equity indices** exist, but are basis-noisy, are generally unavailable or
  restricted to US persons, and hedge an index rather than the specific thing you hold.

So the practical retail answer to "the market is closed and something just happened" has always
been: wait, and find out Monday.

---

## 2. The insight

[xStocks](https://docs.xstocks.fi/docs) are tokenized US equities issued by Backed Finance on
Solana — 1:1 backed by the real underlying shares, and trading **24/7** on DEXs. While the NYSE is
dark, NVDAx, SPYx, QQQx and TSLAx keep finding a price, because somebody always wants to express a
view on the weekend news.

The usual framing for tokenized equities is access: they let people trade US stocks outside US
market hours and outside US brokerage rails. That framing undersells them. The more interesting
property is **informational**. A continuously traded, 1:1-backed claim on AAPL is a live, public,
machine-readable estimate of what AAPL is worth *right now* — including at 3am on a Sunday, when no
other price for AAPL exists anywhere in the world.

So the information exists. The open question is whether it is any good: does the off-hours tape
actually predict where the real stock opens? And if it does, can an ordinary person act on it?

I measured the first question before building anything for the second. The order matters — a tool
built on an unmeasured signal is a demo, not a product.

---

## 3. What Gap Guard does

1. **You tell it what you actually hold** at your real broker — a ticker and a share count. No
   brokerage API, no account linking, no credentials, no read access to anything you own.
2. **While the market is closed, it watches** the matching xStock drift away from the real market's
   last close, converts that into dollars of exposure across your positions, and alerts you once the
   drift crosses a threshold you set.
3. **It hedges with a real on-chain short**: it borrows the xStock from Kamino against USDC
   collateral and sells it on Jupiter. If the stock gaps down, the short gains roughly what your
   real shares lose.
4. **After the open, it reconciles.** How far did the stock actually gap? How much did your frozen
   position move? How well did the 24/7 tape call it? What was the hedge worth, marked at the
   official open? Every number, after the fact, so the tool is accountable to you rather than just
   confident at you.

It runs as a **local dashboard**, a **Telegram bot**, or both. Telegram is entirely optional, so the
whole thing can be tried with no accounts, no keys and no money.

### A worked example

It is Saturday. You hold 100 shares of NVDA, worth $18,000 at Friday's close. Something breaks in
the supply chain and the story spreads through the weekend.

- Gap Guard is polling NVDAx. By Saturday evening it is trading 2.4% below where it sat at Friday's
  close. Your exposure line reads **−$432** and the alert fires.
- You decide to cover part of it. `/hedge NVDA 100` opens a $100 short: Kamino applies a 2.25x
  borrow factor to NVDAx debt, so the bot deposits $281.25 of USDC collateral, borrows the NVDAx,
  and sells it on Jupiter. Projected LTV is checked before anything is signed, and refused above 60%.
- Monday, 9:30am. NVDA opens down 1.8%. Your real position is down $324, which you could not have
  avoided. The short gained roughly $180 against it.
- `/report` lays it out: actual gap −1.8%, predicted −2.4%, error 0.6pp, hedge P&L marked at the
  official open, net change after the hedge. Including the fact that the tape overshot.

The last line is the point. The report tells you when the signal was wrong, because a hedging tool
that only reports its wins teaches you nothing about how much to trust it next weekend.

---

## 4. Does the tape actually predict the open?

This is the load-bearing claim, so it is measured. `npm run backtest` scores it against real
historical gaps.

### Methodology

For every close → open window, the backtest compares **how far the xStock moved while the market was
shut** against **how far the stock actually gapped**, both in percentage points.

Two methodology choices matter:

**It measures move-vs-move, not level-vs-level.** xStocks trade at a small but persistent premium to
the underlying — SPYx averaged +0.56%, QQQx +0.28% over the sample. Comparing the raw xStock price
against the real close would silently bake that premium into every single "error" and make the
signal look far worse than it is. So the comparison is anchored to each instrument's own price at
the close. This was a real bug found and fixed during development, not a precaution.

**The baseline is assuming no gap at all.** That is the honest counterfactual: it is precisely what
you are stuck with when your broker is closed and you have no other information. A signal that
cannot beat "assume the stock opens where it closed" is worthless regardless of how sophisticated it
looks.

Real closes and official daily open/close bars come from Yahoo Finance's chart endpoint. The
off-hours xStock tape comes from GeckoTerminal's free API, sampled hourly from the deepest DEX pool.

### Results — 248 windows across 3 months (to Sept 2026)

| Ticker | Windows | Mean abs error | Baseline | Direction called |
| --- | --- | --- | --- | --- |
| SPY | 62 | 0.29pp | 0.40pp | 42/51 (82%) |
| QQQ | 62 | 0.49pp | 0.81pp | 48/56 (86%) |
| NVDA | 62 | 0.92pp | 1.14pp | 47/60 (78%) |
| TSLA | 62 | 1.22pp | 1.06pp | 42/54 (78%) |
| **All** | **248** | **0.73pp** | **0.85pp** | **179/221 (81%)** |

### Reading it honestly

- **Direction is the real signal.** 81% of the time the off-hours tape called which way the stock
  would open. For a hedging decision — do I want protection this weekend, yes or no — direction is
  most of what you need.
- **Magnitude overshoots, consistently.** Predicted moves run larger than the realised gap. Sizing a
  hedge off the raw predicted move would systematically over-hedge, which is why Gap Guard asks you
  for a dollar amount rather than auto-sizing from the signal.
- **It fails on TSLA.** 1.22pp error against a 1.06pp baseline — genuinely worse than doing nothing.
  TSLAx's off-hours liquidity is thin enough that it overshoots badly; one weekend it predicted
  +3.66% against a −0.44% actual. The index xStocks are where this works, and conveniently they are
  also the ones Kamino lends at the lowest borrow factor, so the instrument that hedges most cheaply
  is the one with the best signal.
- **Three months is three months.** 248 windows is enough to establish a directional edge well
  clear of a coin flip, and not enough to characterise behaviour through a genuine volatility
  regime. It has not been tested through a crash.

That TSLA row is in the README, in the demo script, and here. A judge who finds a tool's weakest
result stated plainly by its author has a reason to believe the other numbers.

---

## 5. How it works

### Architecture

Five subsystems, deliberately decoupled:

- **Market data and signal** (`src/market/`) — prices, the NYSE clock, gap computation, the
  background monitor, and reconciliation.
- **Hedging** (`src/hedge/`) — Kamino borrow/repay, Jupiter swaps, short sizing math, risk limits.
- **Interfaces** (`src/web/`, `src/telegram/`) — the local dashboard and the optional bot, sharing
  one state layer so they never disagree.
- **Wallet** (`src/wallet/`) — keypair loading, RPC connection, balances, send/confirm/simulate.
- **Storage** (`src/portfolio/db.ts`) — holdings, the hedge ledger, and price snapshots in SQLite.

The pure math is isolated in files with no I/O — `shortMath.ts`, `reconcileMath.ts`, `clock.ts` —
which is what makes the meaningful parts unit-testable without a network or a wallet.

### The signal

- **Live xStock price** from Jupiter Price API v3, which aggregates across DEX routes rather than
  trusting a single pool.
- **Real-market reference close and official daily open/close bars** from Yahoo Finance's chart
  endpoint — free, no key, and it provides the *official* open, which is what a gap must be measured
  against. (An earlier version used Stooq; it went dead mid-build, which is a good argument for
  keeping the data layer behind a narrow interface.)
- **Historical off-hours tape** from GeckoTerminal's free API, behind a serialized request queue
  with a minimum interval and 429 backoff that honours `Retry-After`. Used for the backtest, and to
  backfill a reconciliation when the monitor was not running — so `/report` works on a fresh install
  rather than requiring days of prior uptime.
- **NYSE market clock** with an algorithmic holiday calendar: nth-weekday rules for the fixed
  holidays and a computed Easter for Good Friday, rather than a hardcoded list that silently expires
  and starts reporting the market open on Thanksgiving two years from now.
- **The monitor** polls on an interval, records a price snapshot every cycle (building the tape that
  reconciliation later reads), and sends **one alert per ticker per closed session**. That last
  detail is a product decision: a naive threshold check fires repeatedly as the price oscillates
  around it, and a hedging tool that cries wolf forty times on a Saturday gets muted before the one
  alert that mattered.

### The hedge — why a short

An early version of this project sold xStocks on Jupiter and called it a hedge. It is not one. If
you do not already hold the token, selling it does nothing to your brokerage exposure — you are not
short anything, you have simply spent money. Hedging shares held at a broker requires a position
that **gains when the stock falls**, which means borrowing the asset and selling it.

Recognising that forced a redesign around **Kamino's xStocks lending market**
(`5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua`), where you can supply USDC as collateral and borrow
the xStock itself.

**Opening a short** (`/hedge QQQ 50`):

1. Check the spending caps, the kill switch, and that Kamino actually lends that xStock.
2. Size the USDC collateral so the loan sits at the target LTV *after* the borrow, including
   Kamino's borrow factor. Kamino weights xStock debt heavily — **1.66x** for SPYx/QQQx, **2.25x**
   for NVDAx/TSLAx — so a $50 short needs $207.50 of collateral at a 40% target. Getting this wrong
   in either direction is expensive: too little and the position opens near liquidation, too much
   and capital sits idle.
3. Deposit the collateral shortfall and borrow the xStock, in one transaction.
4. Sell the borrowed xStock for USDC through Jupiter.

If the sell leg fails, you are **flat, not short** — the wallet simply holds what it borrowed — and
`/unwind <TICKER> all` repays it. Every partial-failure path was worked out explicitly, because a
hedging tool that leaves an unknown position open on a Saturday night is worse than no tool.

**Closing a short** (`/unwind QQQ all`, or a USD amount):

1. Buy the xStock back through Jupiter, adding 0.5% headroom for accrued interest and subtracting
   anything already sitting in the wallet.
2. Repay Kamino.
3. On a full close with no other outstanding debt, withdraw all USDC collateral.

Dry-run mode records the identical trades at live prices without ever signing, and the P&L math is
byte-for-byte the same in both modes — so what you see in dry-run is what live would have done.

### The reconciliation report

After the official open prints, `/report` reconstructs the window and reports, per holding:

- `actualGapPct` — the real gap, prior close to official open.
- `exposureChangeUsd` — what your real position gained or lost across the window: the move your
  broker would not let you act on.
- `predictedGapPct` — how far the xStock moved while shut, measured from its own price at the close.
- `predictionErrorPp` — predicted minus actual, in percentage points. The accountability number.
- `basisPct` — the premium the token itself was carrying at the close.
- `peakMovePct` and `peakMoveTs` — the largest move away from the close price while shut, and when
  it happened. Often the most useful line: it shows whether there was a moment worth hedging into.
- `hedgePnlUsd` — hedges placed during that window, marked at the official open.
- `netChangeUsd` — exposure change plus hedge P&L. What the weekend actually cost you.
- `pricesBackfilled` — whether the tape came from the monitor's own polls or from DEX history, so
  you know how the numbers were sourced.

---

## 6. Interfaces

### Dashboard

`npm run dev`, then `http://127.0.0.1:8788`. A single dependency-free HTML file served from
`node:http` — no CDN, no build step, no framework, nothing fetched from the internet at render time.
It refreshes every 20 seconds and shows:

- **Market state** — open or closed, with a countdown to the next transition and your total exposure
  while it is shut.
- **Holdings** — shares, the real market's last close, exposure, the live xStock price, and the gap
  between them. Add or remove inline.
- **Open shorts** — Kamino collateral, borrow-factor-adjusted debt, and an LTV bar against the
  liquidation threshold in live mode; net simulated shorts with P&L otherwise. One-click unwind.
- **Close → open reconciliation** — the same report the bot posts after the open.
- **Recent hedges** — the ledger, with Solscan links for real transactions.
- **Limits** — caps, trailing 24h usage, and the kill switch.

### Telegram (optional)

| Command | What it does |
| --- | --- |
| `/holdings add <TICKER> <SHARES>` | Track a real position |
| `/holdings`, `/holdings remove <id>`, `/holdings clear` | List or remove positions |
| `/status` | Market state, live gap and exposure per holding, open shorts |
| `/hedge <TICKER> <USD>` | Open a short — real in live mode, simulated otherwise |
| `/unwind <TICKER> <USD\|all>` | Close some or all of a short |
| `/report` | Reconciliation for the most recent close → open |
| `/wallet` | Hot wallet address and balances |
| `/pause`, `/resume` | Kill switch |
| `/limits ...` | Adjust caps and the gap threshold |

---

## 7. Risk controls

Caps are enforced in `src/hedge/riskLimits.ts`, which is the **single choke point every hedge passes
through** before a transaction is built. Config supplies the *values*; this function is what refuses
the spend. Editing `.env` changes the numbers, not whether they are checked — bypassing enforcement
requires editing the code, which is a deliberate design choice rather than an accident of layering.

- **Per-hedge cap** — a maximum USD notional per hedge.
- **Daily cap** — a trailing 24-hour rolling total, computed from the ledger rather than a counter
  that a restart would reset.
- **Minimum interval** between hedges, which stops a loop or a fat-fingered repeat from stacking
  positions.
- **Hard 60% LTV ceiling**, independent of config. The reasoning: a short opened too close to
  liquidation could be liquidated *by the very gap it exists to hedge*, which is the worst possible
  failure mode — you would lose the hedge exactly when it pays out.
- **Kill switch** (`/pause`) blocks all signing.

**Unwinds deliberately skip the spending caps**, because closing a short only reduces risk and a cap
that prevents you from closing a position is a bug, not a safety feature. They still respect the
kill switch.

---

## 8. Security

This holds a hot wallet and can sign transactions, so the threat model was taken seriously rather
than waved at.

**The dashboard is the sharpest edge.** Binding to loopback is not sufficient on its own — a
malicious page in your own browser can also reach `127.0.0.1`, and a "simple" cross-origin POST with
a `text/plain` body skips the CORS preflight entirely. A site you happen to visit could therefore
fire a hedge without ever being able to read the response. Four layers close that, all unit-tested:

| Check | Stops |
| --- | --- |
| Socket must be loopback | Anything off-box |
| `Host` must name loopback | DNS rebinding — the attacker's domain shows up here |
| `Origin`, when sent, must be this dashboard | Cross-origin calls |
| Mutating requests need `X-Gap-Guard: 1` | CSRF — a custom header forces a preflight this server never approves |

The fix was verified by firing attack-shaped requests at a running instance; all were refused.

Beyond that: everything rendered through `innerHTML` is escaped, since error text originates from
upstream APIs rather than from this app. Every SQL query is a parameterized prepared statement. There
is no `eval`, no shell execution, and no user-controlled file path anywhere in the codebase. The
logger redacts key-shaped values so a secret cannot leak through a log line, and nothing ever prints
a private key. `.env` and `wallet*.json` are gitignored.

Known dependency advisories are **documented rather than silently "fixed"**: all are transitive
through the Kamino SDK and web3.js, none are reachable from untrusted input in this app's usage, and
`npm audit fix --force` downgrades the Kamino SDK past the API this is built on. Quietly breaking
the product to make a scanner green would be the wrong trade, so the reasoning is written down
instead.

---

## 9. Testing — three tiers

**Unit tests (38, no network or wallet).** The request guard, the market clock's session boundaries
and holiday observance, hedge P&L accounting, close → open window selection and tape lookups, and
short sizing — collateral top-up through the borrow factor, buyback headroom, and base-unit
rounding.

**Backtest.** Scores the product's core claim against real historical gaps. Most hackathon projects
cannot tell you whether their central premise is true; this one prints a table.

**Mainnet fork end-to-end.** I had no money to test the live path with, so the full hedge cycle was
run against a local [surfpool](https://github.com/solana-foundation/surfpool) fork of mainnet — real
Kamino programs, real Jupiter routes, real signed transactions, fake funds minted with cheatcodes.
Reproducible via `npm run fork:e2e`.

A $50 QQQ short:

| Step | Result |
| --- | --- |
| `/hedge QQQ 50` | Deposited $207.50 USDC collateral, borrowed 0.0698 QQQx, sold it on Jupiter. LTV landed on exactly **40.0%**, debt $83.06 (= $50 x the 1.66 borrow factor). 2 transactions. |
| `/unwind QQQ all` | Bought the xStock back, repaid Kamino, withdrew all collateral. 3 transactions. |
| Round trip | USDC $500 → $498.31, with ~$1.66 of buyback dust left over — about **$0.03** in fees, price impact and interest. |
| SOL | 5.0 → 4.966 for first-time account rent, refunded to 4.990 when the accounts closed. |

That run covered first-time Kamino account setup, which a plain mainnet simulation cannot reach —
the account does not exist yet, so there is nothing to simulate against. What a fork cannot prove:
real fills at real depth, and oracle behaviour during a real weekend.

---

## 10. Engineering notes — what broke, and what it changed

A few of the failures that shaped the design, since they are more informative than a feature list:

- **The hedge was not a hedge.** The first implementation sold xStocks on Jupiter. That does nothing
  for shares held at a broker. Caught in review, and it forced the entire Kamino integration —
  the largest and most valuable rewrite in the project.
- **`confirmTransaction` resolves successfully for reverted transactions.** It confirms that the
  transaction *landed*, not that it *worked*. The code now inspects `confirmation.value.err` and
  confirms against the transaction's own blockhash. Without this, a failed borrow would have been
  recorded as an open short.
- **The basis bug.** Comparing the raw xStock price to the real close baked the token's ~0.38%
  premium into every measurement, making the signal look meaningfully worse than it is. Fixed by
  measuring move-vs-move. This is the difference between the tool reporting a real edge and
  reporting noise.
- **Ticker mapping by string surgery.** Stripping a trailing `X` from `APPLX` yields `APPL`, which
  is not a ticker. Replaced with an explicit verified map, and anything without a confidently
  verified real-market listing is excluded rather than guessed.
- **A markdown injection killed `/status` silently.** Upstream text flowed into a Telegram message
  with markdown parsing on; a stray character made the whole send fail with no visible error. Now
  escaped — the same class of bug as the dashboard's `innerHTML` escaping, arriving from a
  completely different direction.
- **Units.** The Kamino SDK returns whole tokens where the surrounding code expected base units,
  producing a borrow amount of `1.75e-8`. xStocks additionally apply a dividend multiplier to UI
  amounts. The codebase now works in base units throughout, with conversion at the edges only.

---

## 11. Costs, coverage and limitations

### What running it costs

Nothing to try: dry-run uses live prices without signing, and the fork test uses fake funds. For
live mode, at the default 40% target LTV:

| Short on | Borrow factor | USDC collateral for a $50 short |
| --- | --- | --- |
| SPY, QQQ | 1.66 | $207.50 |
| NVDA, TSLA | 2.25 | $281.25 |

Plus ~0.04 SOL for first-time account rent (mostly refunded on close), and spare USDC of roughly 20%
of the short's size — if the stock rises, the buyback costs more than the sale brought in, and the
collateral stays locked until the loan is repaid.

### Ticker coverage

Tracked: AAPL, TSLA, NVDA, GOOGL, AMZN, META, MSFT, SPY, QQQ, GLD, COIN, HOOD, PLTR, MSTR, GME,
MCD, KO, INTC. **Shorting** additionally requires Kamino to lend the xStock — as of Sept 2026 that
is SPYx, QQQx, NVDAx and TSLAx; the rest are collateral-only, so those holdings hedge through SPY or
QQQ.

Deliberately excluded: entries whose mapping to a real listed ticker is not confidently verified,
and the private-company and non-equity instruments in the xStocks registry, which have no real
NYSE/Nasdaq close to gap against. Guessing a mapping here would produce confident, wrong numbers.

### Honest limitations

- **The signal is directional, not a magnitude** — and on TSLA it is worse than assuming no gap.
- **Holdings are manual entry**, with no brokerage API.
- **A short's legs are separate transactions, not atomic.** Each failure mode leaves the position
  flat, or reports how to finish it.
- **Closing leaves dust** (~$1.66 on a $50 short) because the buyback adds interest headroom.
  Kamino's flash-loan "repay with collateral" is not integrated.
- **Closing needs USDC in the wallet** for the buyback, since collateral is locked until repayment.
- **Weekend oracle risk.** Kamino accepts off-hours xStock prices only within a band around the last
  close, so a large weekend move could stall its oracle exactly when a hedge is most wanted. Gap
  Guard detects this and explains it rather than surfacing a raw program error — but it cannot fix
  it.
- **Backfilled history is one pool's tape**, while the live path uses Jupiter's aggregate price.
  Close, but not identical.
- **Early-close half days are not modeled**, and `/report` uses current share counts rather than a
  historical snapshot.

---

## 12. What's next

- **Calibrate the magnitude.** The overshoot is consistent, which means it is correctable. A simple
  regression of realised gap on predicted move, fit per ticker, would turn a directional signal into
  a sizing recommendation.
- **Liquidity-weight the signal.** TSLAx fails because its off-hours book is thin. Weighting the
  prediction by realised DEX depth would likely repair the worst row in the table, and is the single
  highest-value next experiment.
- **Basket hedging.** Most retail portfolios are correlated enough that one SPY or QQQ short hedges
  a whole book more cheaply than four single-name shorts — and those are exactly the xStocks with
  the best signal and the lowest borrow factor.
- **Atomic legs** via a flash loan, removing the intermediate flat state and the dust.
- **Read-only brokerage import** to replace manual holdings entry.
- **A longer backtest** through a genuine volatility regime.

---

## 13. Why this matters beyond the hackathon

The prevailing case for tokenized equities is access — trade US stocks anywhere, any time. That is
real but it is a substitute good, competing with brokers that are free and well-trusted.

Gap Guard argues something different: the 24/7 tape is **infrastructure**, not just a venue. It is a
continuously published, publicly readable, machine-consumable estimate of what a US equity is worth
during the 135 hours a week when no other estimate exists. That is a genuinely new primitive, and it
is only possible on a chain where the asset trades continuously and a lending market will lend it.

Once you can read it, you can build on it: gap hedging is the first application, but risk dashboards,
overnight VaR, weekend circuit-breaker alerting and after-hours index construction all sit on the
same foundation. And critically, the hedge leg composes two existing Solana protocols — Kamino for
the borrow, Jupiter for the execution — rather than requiring new infrastructure. The primitive is
already deployed. It just needed something to point at it.

---

## 14. Tech

TypeScript (ESM/NodeNext) · Solana web3.js + `@solana/kit` · `@kamino-finance/klend-sdk` · Jupiter
Price v3 and Swap v1 · better-sqlite3 · grammy · zod · pino · vitest · surfpool.

## 15. Try it

```bash
npm install && cp .env.example .env
npm run dev                # dashboard on http://127.0.0.1:8788
```

No account, no key, no money — dry-run uses live prices and simulates hedges.

```bash
npm run backtest           # score the core claim against real historical gaps
npm test                   # 38 unit tests, no network needed
npm run fork:e2e           # the real hedge path on a local mainnet fork, with fake funds
```

**Repo:** https://github.com/winstontai/gapguard
