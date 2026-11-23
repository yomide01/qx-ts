import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { TradeRecord } from './types.js';
import { Candle } from '../stream/types.js';
import { normalizeAsset } from '../stream/assets.js';

export interface CandleSeriesSummary {
  asset: string;
  timeframe: number;
  count: number;
  firstTime: number;
  lastTime: number;
}

export class TradingJournalDB {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.resolve(process.cwd(), 'data', 'qx_trading.db');
    if (finalPath !== ':memory:') {
      const dir = path.dirname(finalPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(finalPath);
    this.initSchema();
    this.repairHistoricalAnomalies();
  }

  public static toEpochMs(ts: number): number {
    if (!Number.isFinite(ts) || ts <= 0) return 0;
    return ts < 1e11 ? Math.round(ts * 1000) : Math.round(ts);
  }

  public static sanitizePayoutPercent(payoutPercent: number, stakeAmount?: number): number {
    if (!Number.isFinite(payoutPercent) || payoutPercent <= 0) return 80;
    if (payoutPercent > 100 && stakeAmount && stakeAmount > 0) {
      const derived = Math.round((payoutPercent / stakeAmount) * 1000) / 10;
      if (derived >= 10 && derived <= 100) return derived;
    }
    if (payoutPercent <= 1) return Math.round(payoutPercent * 1000) / 10;
    return Math.min(100, Math.max(10, payoutPercent));
  }

  public static computeTimeframeSeconds(openTime: number, closeTime: number, fallback: number = 300): number {
    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) || closeTime <= openTime) {
      return fallback;
    }
    const diff = closeTime - openTime;
    const isMs = openTime > 1e11 || closeTime > 1e11 || diff > 86400 * 2;
    const sec = isMs ? Math.round(diff / 1000) : Math.round(diff);
    return sec > 0 ? sec : fallback;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        asset TEXT NOT NULL,
        is_otc INTEGER NOT NULL,
        direction TEXT NOT NULL,
        timeframe_seconds INTEGER NOT NULL,
        payout_percent REAL NOT NULL,
        stake_amount REAL NOT NULL,
        open_time INTEGER NOT NULL,
        close_time INTEGER NOT NULL,
        open_price REAL NOT NULL,
        close_price REAL,
        status TEXT NOT NULL,
        profit_loss REAL,
        is_demo INTEGER NOT NULL,
        signal_confidence REAL,
        signal_reason TEXT,
        market_regime TEXT,
        indicators_at_entry TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades (asset);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);
      CREATE INDEX IF NOT EXISTS idx_trades_open_time ON trades (open_time);
      CREATE INDEX IF NOT EXISTS idx_trades_is_otc ON trades (is_otc);

      CREATE TABLE IF NOT EXISTS candles (
        asset TEXT NOT NULL,
        timeframe INTEGER NOT NULL,
        open_time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        PRIMARY KEY (asset, timeframe, open_time)
      );

      CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles (asset, timeframe, open_time);
    `);
  }

  /**
   * Automatically repairs legacy database anomalies:
   * 1. Fixes rows where dollar profit (e.g. 1380 on a 1500 stake) was stored in payout_percent.
   * 2. Fixes rows where timeframe_seconds was rounded to 0 due to seconds vs milliseconds division.
   * 3. Removes stale orphaned 'OPEN' rows whose scheduled close_time expired > 1 hour ago without settlement.
   */
  private repairHistoricalAnomalies(): void {
    try {
      this.db.exec(`
        UPDATE trades
        SET payout_percent = CASE
          WHEN stake_amount > 0 AND (payout_percent / stake_amount) * 100 BETWEEN 10 AND 100
            THEN ROUND((payout_percent / stake_amount) * 100, 1)
          ELSE 80
        END
        WHERE payout_percent > 100 OR payout_percent < 10;

        UPDATE trades
        SET timeframe_seconds = CASE
          WHEN (close_time - open_time) > 172800 THEN ROUND((close_time - open_time) / 1000.0)
          WHEN (close_time - open_time) > 0 THEN ROUND(close_time - open_time)
          ELSE 300
        END
        WHERE timeframe_seconds <= 0 AND close_time > open_time;
      `);

      const nowSec = Math.floor(Date.now() / 1000);
      const nowMs = Date.now();
      const staleStmt = this.db.prepare(`
        DELETE FROM trades
        WHERE status = 'OPEN'
          AND profit_loss IS NULL
          AND close_time > 0
          AND (
            (close_time < 100000000000 AND close_time < ? - 3600)
            OR (close_time >= 100000000000 AND close_time < ? - 3600000)
          )
      `);
      staleStmt.run(nowSec, nowMs);
    } catch {
      // Safe fallback for read-only or in-memory test instances
    }
  }

  /**
   * Records a new trade entry in the database (or updates outcome and signal context on conflict).
   */
  public recordTrade(trade: TradeRecord): void {
    const cleanPayout = TradingJournalDB.sanitizePayoutPercent(trade.payoutPercent, trade.stakeAmount);
    const cleanTf =
      trade.timeframeSeconds > 0
        ? trade.timeframeSeconds
        : TradingJournalDB.computeTimeframeSeconds(trade.openTime, trade.closeTime, 300);

    const stmt = this.db.prepare(`
      INSERT INTO trades (
        id, asset, is_otc, direction, timeframe_seconds, payout_percent,
        stake_amount, open_time, close_time, open_price, close_price,
        status, profit_loss, is_demo, signal_confidence, signal_reason,
        market_regime, indicators_at_entry
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        timeframe_seconds = CASE WHEN excluded.timeframe_seconds > 0 THEN excluded.timeframe_seconds ELSE trades.timeframe_seconds END,
        payout_percent = CASE WHEN excluded.payout_percent BETWEEN 10 AND 100 THEN excluded.payout_percent ELSE trades.payout_percent END,
        close_price = COALESCE(excluded.close_price, trades.close_price),
        status = excluded.status,
        profit_loss = COALESCE(excluded.profit_loss, trades.profit_loss),
        signal_confidence = COALESCE(excluded.signal_confidence, trades.signal_confidence),
        signal_reason = COALESCE(excluded.signal_reason, trades.signal_reason),
        market_regime = COALESCE(excluded.market_regime, trades.market_regime),
        indicators_at_entry = COALESCE(excluded.indicators_at_entry, trades.indicators_at_entry)
    `);

    stmt.run(
      trade.id,
      trade.asset.toUpperCase(),
      trade.isOtc ? 1 : 0,
      trade.direction.toUpperCase(),
      cleanTf,
      cleanPayout,
      trade.stakeAmount,
      trade.openTime,
      trade.closeTime,
      trade.openPrice,
      trade.closePrice ?? null,
      trade.status,
      trade.profitLoss ?? null,
      trade.isDemo ? 1 : 0,
      trade.signalConfidence ?? null,
      trade.signalReason ?? null,
      trade.marketRegime ?? null,
      trade.indicatorsAtEntry ? JSON.stringify(trade.indicatorsAtEntry) : null
    );
  }

  /**
   * Updates an existing trade upon settlement.
   */
  public updateTradeOutcome(
    dealId: string,
    closePrice: number,
    profitLoss: number,
    status: 'WON' | 'LOST' | 'DRAW'
  ): void {
    const stmt = this.db.prepare(`
      UPDATE trades
      SET close_price = ?, profit_loss = ?, status = ?
      WHERE id = ?
    `);
    stmt.run(closePrice, profitLoss, status, dealId);
  }

  public getTrade(id: string): TradeRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM trades WHERE id = ?`);
    const row = stmt.get(id) as any;
    return row ? this.mapRowToTrade(row) : null;
  }

  public getAllTrades(limit: number = 2000): TradeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades
      ORDER BY CASE WHEN open_time < 100000000000 THEN open_time * 1000 ELSE open_time END DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    return rows.map((r) => this.mapRowToTrade(r));
  }

  public getOpenTrades(): TradeRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM trades WHERE status = 'OPEN'`);
    const rows = stmt.all() as any[];
    return rows.map((r) => this.mapRowToTrade(r));
  }

  /**
   * Returns net PnL and settled trade count for the current local calendar day
   * for either DEMO or LIVE accounts (used to enforce persistent daily loss limits across restarts).
   */
  public getTodayNetPnL(isDemo: boolean, nowMs: number = Date.now()): { netPnL: number; tradeCount: number } {
    const startOfDay = new Date(nowMs);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    const startSec = Math.floor(startMs / 1000);

    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(profit_loss), 0) AS net_pnl, COUNT(*) AS cnt
      FROM trades
      WHERE is_demo = ?
        AND status IN ('WON', 'LOST', 'DRAW')
        AND (
          (open_time < 100000000000 AND open_time >= ?)
          OR (open_time >= 100000000000 AND open_time >= ?)
        )
    `);
    const row = stmt.get(isDemo ? 1 : 0, startSec, startMs) as any;
    return {
      netPnL: Number(row?.net_pnl ?? 0),
      tradeCount: Number(row?.cnt ?? 0),
    };
  }

  // ───────────────────────── CANDLE ARCHIVE (for walk-forward & offline backtesting) ─────────────────────────

  /**
   * Persists closed candles in a single SQLite transaction (upsert by asset, timeframe, open_time).
   */
  public saveCandles(candles: Candle[]): number {
    if (!candles || candles.length === 0) return 0;
    const valid = candles.filter(
      (c) =>
        c.isClosed !== false &&
        c.asset &&
        c.timeframe > 0 &&
        c.openTime > 0 &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    );
    if (valid.length === 0) return 0;

    const stmt = this.db.prepare(`
      INSERT INTO candles (asset, timeframe, open_time, open, high, low, close)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset, timeframe, open_time) DO UPDATE SET
        open = excluded.open,
        high = MAX(candles.high, excluded.high),
        low = MIN(candles.low, excluded.low),
        close = excluded.close
    `);

    this.db.exec('BEGIN');
    try {
      for (const c of valid) {
        const normAsset = normalizeAsset(c.asset);
        const openMs = TradingJournalDB.toEpochMs(c.openTime);
        stmt.run(normAsset, c.timeframe, openMs, c.open, c.high, c.low, c.close);
      }
      this.db.exec('COMMIT');
      return valid.length;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Loads persisted closed candles in ascending chronological order.
   */
  public getCandles(asset: string, timeframe: number, limit: number = 5000): Candle[] {
    const normAsset = normalizeAsset(asset);
    const stmt = this.db.prepare(`
      SELECT asset, timeframe, open_time, open, high, low, close
      FROM (
        SELECT asset, timeframe, open_time, open, high, low, close
        FROM candles
        WHERE asset = ? AND timeframe = ?
        ORDER BY open_time DESC
        LIMIT ?
      )
      ORDER BY open_time ASC
    `);
    const rows = stmt.all(normAsset, timeframe, limit) as any[];
    return rows.map((r) => ({
      asset: r.asset,
      timeframe: r.timeframe,
      openTime: r.open_time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      isClosed: true,
    }));
  }

  public listCandleSeries(): CandleSeriesSummary[] {
    const stmt = this.db.prepare(`
      SELECT asset, timeframe, COUNT(*) AS cnt, MIN(open_time) AS first_time, MAX(open_time) AS last_time
      FROM candles
      GROUP BY asset, timeframe
      ORDER BY cnt DESC, asset ASC
    `);
    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      asset: r.asset,
      timeframe: r.timeframe,
      count: Number(r.cnt),
      firstTime: Number(r.first_time),
      lastTime: Number(r.last_time),
    }));
  }

  private mapRowToTrade(row: any): TradeRecord {
    return {
      id: row.id,
      asset: row.asset,
      isOtc: Boolean(row.is_otc),
      direction: row.direction as 'CALL' | 'PUT',
      timeframeSeconds: row.timeframe_seconds,
      payoutPercent: row.payout_percent,
      stakeAmount: row.stake_amount,
      openTime: row.open_time,
      closeTime: row.close_time,
      openPrice: row.open_price,
      closePrice: row.close_price ?? undefined,
      status: row.status as 'OPEN' | 'WON' | 'LOST' | 'DRAW',
      profitLoss: row.profit_loss ?? undefined,
      isDemo: Boolean(row.is_demo),
      signalConfidence: row.signal_confidence ?? undefined,
      signalReason: row.signal_reason ?? undefined,
      marketRegime: row.market_regime ?? undefined,
      indicatorsAtEntry: row.indicators_at_entry ? JSON.parse(row.indicators_at_entry) : undefined,
    };
  }

  public close(): void {
    this.db.close();
  }
}
