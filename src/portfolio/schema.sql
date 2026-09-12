CREATE TABLE IF NOT EXISTS settings_overrides (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Real, off-chain holdings the user says they own (manual entry - no brokerage
-- API integration). This is the thing Gap Guard is protecting.
CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,          -- real underlying ticker, e.g. AAPL
  xstock_ticker TEXT NOT NULL,   -- matching xStock, e.g. APPLX
  shares REAL NOT NULL,
  added_ts INTEGER NOT NULL,
  removed_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_holdings_ticker ON holdings (ticker, removed_ts);

-- Every hedge trade Gap Guard has executed (or, in dry-run mode, would have executed).
CREATE TABLE IF NOT EXISTS hedge_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  xstock_ticker TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('open', 'unwind')), -- open = short-sell, unwind = buy back
  usd_amount REAL NOT NULL,
  price_usd REAL NOT NULL,       -- xStock price it executed (or, in dry-run, would have executed) at
  gap_pct_at_hedge REAL,
  tx_signature TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'dry-run')),
  triggered_by TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_hedge_ledger_ts ON hedge_ledger (ts);
CREATE INDEX IF NOT EXISTS idx_hedge_ledger_ticker_ts ON hedge_ledger (xstock_ticker, ts);

-- Periodic gap readings, kept so /status and the Monday reconciliation can show
-- "here's what happened while the market was closed" instead of just the instant value.
CREATE TABLE IF NOT EXISTS gap_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  xstock_ticker TEXT NOT NULL,
  live_price REAL NOT NULL,
  reference_close REAL NOT NULL,
  gap_pct REAL NOT NULL,
  market_open INTEGER NOT NULL,
  -- 'monitor' = recorded live by the poller, 'backfill' = fetched later from DEX history
  source TEXT NOT NULL DEFAULT 'monitor'
);
CREATE INDEX IF NOT EXISTS idx_gap_snapshots_ticker_ts ON gap_snapshots (xstock_ticker, ts);
