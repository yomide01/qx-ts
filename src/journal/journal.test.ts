import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TradingJournalDB } from './database.js';
import { JournalAnalytics } from './analytics.js';
import { TradeRecord } from './types.js';
import { Candle } from '../stream/types.js';

describe('SQLite Journal, Candle Archive & Analytics', () => {
  it('records, settles, sanitizes trades, tracks today PnL, and computes draw-excluded win rates', () => {
    const db = new TradingJournalDB(':memory:');
    try {
      const now = Date.now();
      const trade1: TradeRecord = {
        id: 'deal_001',
        asset: 'EURUSD',
        isOtc: false,
        direction: 'CALL',
        timeframeSeconds: 300,
        payoutPercent: 85,
        stakeAmount: 50,
        openTime: now - 300_000,
        closeTime: now,
        openPrice: 1.054,
        status: 'OPEN',
        isDemo: true,
        marketRegime: 'TRENDING_UP',
        signalConfidence: 58,
        signalReason: 'EMA Pullback',
        indicatorsAtEntry: { rsi: 52, emaFast: 1.0542, emaSlow: 1.0538 },
      };
      db.recordTrade(trade1);
      db.updateTradeOutcome('deal_001', 1.05445, 42.5, 'WON');

      db.recordTrade({
        id: 'deal_002',
        asset: 'USDJPY_OTC',
        isOtc: true,
        direction: 'PUT',
        timeframeSeconds: 300,
        payoutPercent: 90,
        stakeAmount: 50,
        openTime: now - 300_000,
        closeTime: now,
        openPrice: 154.2,
        closePrice: 154.3,
        status: 'LOST',
        profitLoss: -50,
        isDemo: true,
        marketRegime: 'RANGING',
      });

      // Include a DRAW to ensure liveWinRate / byAsset / byRegime exclude draws consistently
      db.recordTrade({
        id: 'deal_003',
        asset: 'EURUSD',
        isOtc: false,
        direction: 'CALL',
        timeframeSeconds: 300,
        payoutPercent: 85,
        stakeAmount: 50,
        openTime: now - 600_000,
        closeTime: now - 300_000,
        openPrice: 1.0535,
        closePrice: 1.0535,
        status: 'DRAW',
        profitLoss: 0,
        isDemo: true,
        marketRegime: 'TRENDING_UP',
      });

      const summary = JournalAnalytics.computeSummary(db.getAllTrades());
      assert.equal(summary.totalTrades, 3);
      assert.equal(summary.wonTrades, 1);
      assert.equal(summary.lostTrades, 1);
      assert.equal(summary.drawTrades, 1);
      assert.equal(summary.liveWinRate, 100, 'DRAW must be excluded from liveWinRate denominator');
      assert.equal(summary.byAsset.EURUSD.winRate, 100, 'DRAW must be excluded from byAsset winRate denominator');
      assert.equal(summary.otcWinRate, 0);

      // Today PnL check (+42.5 - 50 = -7.5)
      const today = db.getTodayNetPnL(true, now);
      assert.equal(today.tradeCount, 3);
      assert.ok(Math.abs(today.netPnL - -7.5) < 1e-6);

      // Payout sanitization & ON CONFLICT signal attachment
      assert.equal(TradingJournalDB.sanitizePayoutPercent(1380, 1500), 92);
      assert.equal(TradingJournalDB.computeTimeframeSeconds(1795452891, 1795453191, 300), 300);

      const bareTrade: TradeRecord = {
        id: 'deal_004',
        asset: 'GBPUSD',
        isOtc: false,
        direction: 'CALL',
        timeframeSeconds: 0,
        payoutPercent: 1380,
        stakeAmount: 1500,
        openTime: 1795452891,
        closeTime: 1795453191,
        openPrice: 1.265,
        status: 'OPEN',
        isDemo: true,
      };
      db.recordTrade(bareTrade);
      db.recordTrade({
        ...bareTrade,
        signalConfidence: 59,
        signalReason: 'EMA Pullback',
        marketRegime: 'TRENDING_UP',
        indicatorsAtEntry: { rsi: 48.5, emaFast: 1.2648, emaSlow: 1.264 },
      });
      const updated = db.getTrade('deal_004');
      assert.equal(updated?.payoutPercent, 92);
      assert.equal(updated?.timeframeSeconds, 300);
      assert.equal(updated?.marketRegime, 'TRENDING_UP');
      assert.equal(updated?.indicatorsAtEntry?.rsi, 48.5);
    } finally {
      db.close();
    }
  });

  it('persists, merges, and retrieves historical candles cleanly', () => {
    const db = new TradingJournalDB(':memory:');
    try {
      const candles: Candle[] = [0, 1, 2, 3, 4].map((i) => ({
        asset: 'EUR/USD (OTC)',
        timeframe: 300,
        openTime: 1_700_000_000_000 + i * 300_000,
        open: 1.1 + i * 0.001,
        high: 1.1005 + i * 0.001,
        low: 1.0995 + i * 0.001,
        close: 1.1002 + i * 0.001,
        isClosed: true,
      }));
      assert.equal(db.saveCandles(candles), 5);
      // Upsert overlapping candle with higher wick
      db.saveCandles([{ ...candles[2], high: candles[2].high + 0.005 }]);

      const loaded = db.getCandles('EURUSD_otc', 300, 100);
      assert.equal(loaded.length, 5);
      assert.ok(loaded[2].high > candles[2].high);

      const list = db.listCandleSeries();
      assert.equal(list.length, 1);
      assert.equal(list[0].asset, 'EURUSD_OTC');
      assert.equal(list[0].count, 5);
    } finally {
      db.close();
    }
  });
});
