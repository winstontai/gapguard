# Gap Guard — demo video script

Target length **2:45–3:00**. Four beats: the problem, the product, the proof, the honesty.

Judges watch a lot of these. The two things that separate this one are (1) a measured number for
the core claim and (2) real signed transactions. Both are in the first 90 seconds.

---

## Beat 1 — The hook (0:00–0:20)

**On screen:** a plain title card, then a clock graphic or just the terminal.

> Your broker is open six and a half hours a day, five days a week. That's thirty-two hours out of
> a hundred and sixty-eight. For the other hundred and thirty-five, your portfolio is frozen and the
> world isn't.
>
> News breaks on a Saturday. You find out what it cost you at 9:30 Monday morning.
>
> But tokenized stocks on Solana never stop trading. So I measured whether that weekend tape
> actually predicts Monday's open — across two hundred and forty-eight close-to-open windows.
> It called the direction eighty-one percent of the time.
>
> Gap Guard turns that into a hedge.

**Note:** say the 81% out loud before showing any UI. It is the reason to keep watching.

---

## Beat 2 — The product (0:20–1:15)

**On screen:** `npm run dev`, then the dashboard at `http://127.0.0.1:8788`.

Have this staged before recording — holdings already added, market closed if you can time it
(record on a weekend or after 4pm ET, so the "closed" countdown and the live gap are both real).

> Setup is two commands and no account, no key and no money.

Show the terminal: `npm install && cp .env.example .env && npm run dev`. Cut as soon as the server
line prints — don't film the install.

Then walk the dashboard top to bottom, slowly, one section per sentence:

> It knows the market's shut and how long for. These are real positions I hold at a real broker —
> just a ticker and a share count.
>
> This column is the last real close. This one is the same stock trading right now on Solana, live
> from Jupiter. The gap between them is what I'm exposed to and can't do anything about.

Hover or click so the cursor leads the eye. Then:

> Past my threshold, it alerts me — dashboard or Telegram, Telegram's optional.

**If you can only show one thing, show the gap column moving while the market is closed.** That
image is the whole pitch.

---

## Beat 3 — The proof (1:15–2:10)

This is the part most hackathon demos don't have. Don't rush it.

**On screen:** split the terminal and the dashboard, or cut between them.

> A spot sell can't hedge shares sitting at your broker. So this is a real short: supply USDC to
> Kamino's xStocks market, borrow the xStock, sell it on Jupiter.
>
> I have no money to test that with, so I forked mainnet locally — real Kamino, real Jupiter, real
> programs, fake funds — and ran the whole cycle.

Run it live, or play a recording of it:

```bash
npm run fork:e2e
```

Let the real output scroll. Call out the numbers as they land:

> Fifty dollar short on QQQ. It sized two hundred and seven dollars of collateral, because Kamino
> weights xStock debt by a borrow factor of 1.66. Borrowed the QQQx, sold it. LTV landed on exactly
> forty percent.
>
> Then unwind: bought it back, repaid, withdrew the collateral. Five signed transactions. Round
> trip cost about three cents.

Close the beat on the ledger row in the dashboard:

> Every hedge lands here with its transaction signatures. In live mode those are Solscan links.

---

## Beat 4 — The honesty (2:10–2:45)

**On screen:** `npm run backtest` output, or the README table as a still.

Do not skip this. Claiming a signal works everywhere is what makes judges stop believing the rest.

> Here's where it doesn't work.

Point at the TSLA row.

> Against the naive baseline of assuming no gap at all, the tape beats it on SPY, QQQ and NVDA —
> and loses on Tesla. TSLAx's off-hours liquidity is thin enough that it overshoots. One weekend it
> predicted plus three point six percent against an actual of minus zero point four.
>
> The direction is the signal. The magnitude overshoots, so sizing a hedge off the raw predicted
> move would over-hedge. That's in the README, not buried.

Optional, ~5 seconds if the pace allows:

> It holds a hot wallet, so the dashboard is loopback-only with CSRF and DNS-rebinding checks,
> spending caps enforced in code rather than config, a 60% LTV ceiling and a kill switch.

---

## Close (2:45–3:00)

> Gap Guard. Your broker's closed a hundred and thirty-five hours a week. Solana isn't.

End card: repo URL `github.com/winstontai/gapguard`.

---

## Recording notes

- **Terminal font 16pt or larger.** Judges watch these in a small embedded player.
- **Never show a wallet address, keypair path, or `.env` on screen.** Even the burner. If the
  dashboard header shows the address, crop it or blur it in post.
- **Start the surfpool fork immediately before filming the e2e run.** An idle fork serves stale
  oracle prices and Kamino rejects the borrow with `PriceTooOld`. If it fails on camera, restart the
  fork rather than trying to talk over the error.
- **Pre-record the fork run as a backup clip** so a live failure doesn't cost you the take.
- Record the dashboard while the market is genuinely closed — a real countdown and a real live gap
  beat any mocked screenshot.
- Cut all install/build waiting. Nobody needs to watch `npm install`.
- No background music under the numbers. It makes spoken figures hard to catch.

## Numbers, verbatim

Keep these exact — they're all reproducible from the repo, and a wrong figure on camera is the one
thing a judge can check in ten seconds.

| Claim | Figure | Source |
| --- | --- | --- |
| Broker closed per week | 135 of 168 hours | 6.5h × 5 days |
| Backtest size | 248 windows, 3 months to Sept 2026 | `npm run backtest` |
| Directional accuracy | 179/221, 81% | same |
| Mean abs error vs baseline | 0.73pp vs 0.85pp | same |
| Where it fails | TSLA, 1.22pp vs 1.06pp baseline | same |
| Fork e2e | $50 QQQ short, $207.50 collateral, 40.0% LTV, 5 transactions, ~$0.03 round trip | `npm run fork:e2e` |
| Unit tests | 38 across 4 files | `npm test` |
