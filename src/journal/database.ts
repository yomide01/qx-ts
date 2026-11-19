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
   * Records a new trade entry in the database.
   */
  public recordTrade(trade: TradeRecord): void {
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
        close_price = excluded.close_price,
        status = excluded.status,
        profit_loss = excluded.profit_loss
    `);

    stmt.run(
      trade.id,
      trade.asset.toUpperCase(),
      trade.isOtc ? 1 : 0,
      trade.direction.toUpperCase(),
      trade.timeframeSeconds,
      trade.payoutPercent,
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
