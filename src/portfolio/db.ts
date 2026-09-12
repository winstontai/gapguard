import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config } from "../config.js";
import type { PricePoint } from "../market/reconcileMath.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedDb: Database.Database | null = null;

export function getDb(): Database.Database {
  if (cachedDb) return cachedDb;

  const db = new Database(config.DATABASE_PATH);
  db.pragma("journal_mode = WAL");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);

  // CREATE TABLE IF NOT EXISTS won't add columns to a database made by an earlier version.
  const columns = db.prepare(`PRAGMA table_info(gap_snapshots)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === "source")) {
    db.exec(`ALTER TABLE gap_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'monitor'`);
  }

  cachedDb = db;
  return db;
}

export interface Holding {
  id: number;
  ticker: string;
  xstockTicker: string;
  shares: number;
  addedTs: number;
}

export function addHolding(ticker: string, xstockTicker: string, shares: number): number {
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO holdings (ticker, xstock_ticker, shares, added_ts) VALUES (?, ?, ?, ?)`);
  const result = stmt.run(ticker.toUpperCase(), xstockTicker.toUpperCase(), shares, Date.now());
  return Number(result.lastInsertRowid);
}

export function listHoldings(): Holding[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, ticker, xstock_ticker AS xstockTicker, shares, added_ts AS addedTs
       FROM holdings WHERE removed_ts IS NULL ORDER BY added_ts ASC`
    )
    .all() as Holding[];
}

export function removeHolding(id: number): boolean {
  const db = getDb();
  const result = db.prepare(`UPDATE holdings SET removed_ts = ? WHERE id = ? AND removed_ts IS NULL`).run(Date.now(), id);
  return result.changes > 0;
}

export function clearHoldings(): number {
  const db = getDb();
  const result = db.prepare(`UPDATE holdings SET removed_ts = ? WHERE removed_ts IS NULL`).run(Date.now());
  return result.changes;
}

export interface HedgeEntry {
  ts: number;
  xstockTicker: string;
  mint: string;
  /** "open" short-sells the xStock, "unwind" buys it back. */
  side: "open" | "unwind";
  usdAmount: number;
  /** xStock price it executed (or, in dry-run, would have executed) at. */
  priceUsd: number;
  gapPctAtHedge: number | null;
  txSignature: string | null;
  status: "pending" | "confirmed" | "failed" | "dry-run";
  triggeredBy: string | null;
  notes: string | null;
}

export function insertHedge(entry: HedgeEntry): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO hedge_ledger (ts, xstock_ticker, mint, side, usd_amount, price_usd, gap_pct_at_hedge, tx_signature, status, triggered_by, notes)
     VALUES (@ts, @xstockTicker, @mint, @side, @usdAmount, @priceUsd, @gapPctAtHedge, @txSignature, @status, @triggeredBy, @notes)`
  );
  const result = stmt.run(entry);
  return Number(result.lastInsertRowid);
}

/** Sum of confirmed (or dry-run, so caps still mean something in demo mode) hedge USD notional in the trailing `windowMs`. */
export function getRollingHedgeUsd(windowMs: number, now = Date.now()): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(usd_amount), 0) AS total
       FROM hedge_ledger
       WHERE side = 'open' AND status IN ('confirmed', 'dry-run') AND ts >= ?`
    )
    .get(now - windowMs) as { total: number };
  return row.total;
}

export function getLastHedgeTs(): number | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT MAX(ts) AS lastTs FROM hedge_ledger WHERE status IN ('confirmed', 'dry-run')`)
    .get() as { lastTs: number | null };
  return row.lastTs;
}

export interface HedgeFill {
  side: "open" | "unwind";
  usdAmount: number;
  priceUsd: number;
  status: "confirmed" | "dry-run";
}

/** Executed (or dry-run) hedges for one xStock with ts in [fromTs, toTs), oldest first. Failed attempts excluded. */
export function listHedgeFillsBetween(xstockTicker: string, fromTs: number, toTs: number): HedgeFill[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT side, usd_amount AS usdAmount, price_usd AS priceUsd, status
       FROM hedge_ledger
       WHERE xstock_ticker = ? AND status IN ('confirmed', 'dry-run') AND ts >= ? AND ts < ?
       ORDER BY ts ASC`
    )
    .all(xstockTicker, fromTs, toTs) as HedgeFill[];
}

export interface HedgeLogEntry {
  ts: number;
  xstockTicker: string;
  side: "open" | "unwind";
  usdAmount: number;
  priceUsd: number;
  status: string;
  txSignature: string | null;
  notes: string | null;
}

/** Most recent hedge attempts, newest first - including failures, which the dashboard shows. */
export function listRecentHedges(limit: number): HedgeLogEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT ts, xstock_ticker AS xstockTicker, side, usd_amount AS usdAmount, price_usd AS priceUsd,
              status, tx_signature AS txSignature, notes
       FROM hedge_ledger ORDER BY ts DESC LIMIT ?`
    )
    .all(limit) as HedgeLogEntry[];
}

/** xStock tickers with at least one executed or dry-run hedge. */
export function listHedgedTickers(): string[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT DISTINCT xstock_ticker AS ticker FROM hedge_ledger WHERE status IN ('confirmed', 'dry-run')`)
    .all() as { ticker: string }[];
  return rows.map((r) => r.ticker);
}

export function insertGapSnapshot(reading: {
  xstockTicker: string;
  livePrice: number;
  referenceClose: number;
  gapPct: number;
  marketOpen: boolean;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO gap_snapshots (ts, xstock_ticker, live_price, reference_close, gap_pct, market_open, source)
     VALUES (?, ?, ?, ?, ?, ?, 'monitor')`
  ).run(Date.now(), reading.xstockTicker, reading.livePrice, reading.referenceClose, reading.gapPct, reading.marketOpen ? 1 : 0);
}

/**
 * Stores a historical tape fetched from DEX history, so a report can cover a window the
 * monitor wasn't running for. Marked 'backfill' to keep it distinguishable from live polls.
 */
export function insertBackfilledSnapshots(xstockTicker: string, referenceClose: number, points: PricePoint[]): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO gap_snapshots (ts, xstock_ticker, live_price, reference_close, gap_pct, market_open, source)
     VALUES (?, ?, ?, ?, ?, 0, 'backfill')`
  );
  const insertAll = db.transaction((rows: PricePoint[]) => {
    for (const row of rows) {
      stmt.run(row.ts, xstockTicker, row.price, referenceClose, ((row.price - referenceClose) / referenceClose) * 100);
    }
  });
  insertAll(points);
  return points.length;
}

/** Recorded xStock prices for one ticker with ts in [fromTs, toTs), oldest first. */
export function listLivePricesBetween(xstockTicker: string, fromTs: number, toTs: number): { ts: number; livePrice: number }[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT ts, live_price AS livePrice FROM gap_snapshots
       WHERE xstock_ticker = ? AND ts >= ? AND ts < ?
       ORDER BY ts ASC`
    )
    .all(xstockTicker, fromTs, toTs) as { ts: number; livePrice: number }[];
}

/** Raw key/value overrides for Settings fields, persisted across restarts. */
export function getSettingsOverrides(): Record<string, unknown> {
  const db = getDb();
  const rows = db.prepare(`SELECT key, value FROM settings_overrides`).all() as { key: string; value: string }[];
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    out[row.key] = JSON.parse(row.value);
  }
  return out;
}

export function setSettingOverride(key: string, value: unknown): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings_overrides (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), Date.now());
}
