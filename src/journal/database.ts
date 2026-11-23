import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { TradeRecord } from './types.js';

export class TradingJournalDB {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.resolve(process.cwd(), 'data', 'qx_trading.db');
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(finalPath);
    this.initSchema();
    this.repairHistoricalAnomalies();
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
    // If timestamps are in milliseconds (> 1e11), diff is in ms; if in seconds (< 1e11), diff is already in seconds.
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

  /**
   * Retrieves a trade by deal ID.
   */
  public getTrade(id: string): TradeRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM trades WHERE id = ?`);
    const row = stmt.get(id) as any;
    return row ? this.mapRowToTrade(row) : null;
  }

  /**
   * Retrieves all trades matching an optional status or limit.
   */
  public getAllTrades(limit: number = 500): TradeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades
      ORDER BY open_time DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    return rows.map((r) => this.mapRowToTrade(r));
  }

  /**
   * Retrieves currently open trades.
   */
  public getOpenTrades(): TradeRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM trades WHERE status = 'OPEN'`);
    const rows = stmt.all() as any[];
    return rows.map((r) => this.mapRowToTrade(r));
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
      indicatorsAtEntry: row.indicators_at_entry
        ? JSON.parse(row.indicators_at_entry)
        : undefined,
    };
  }

  public close(): void {
    this.db.close();
  }
}
