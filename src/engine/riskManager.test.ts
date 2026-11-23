import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager, evaluateLiveReadiness } from './riskManager.js';
import { TradeRecord } from '../journal/types.js';

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: `t-${Math.random()}`,
    asset: 'EURUSD',
    isOtc: false,
    direction: 'CALL',
    timeframeSeconds: 300,
    payoutPercent: 85,
    stakeAmount: 10,
    openTime: Date.now() - 300_000,
    closeTime: Date.now(),
    openPrice: 1.1,
    closePrice: 1.101,
    status: 'WON',
    profitLoss: 8.5,
    isDemo: true,
    ...overrides,
  };
}

describe('RiskManager & LIVE readiness gate', () => {
  it('halts cleanly on maxSessionLoss (symmetric stop!)', () => {
    const rm = new RiskManager({
      accountType: 'DEMO',
      stakeAmount: 10,
      profitGoal: 100,
      maxSessionLoss: 25,
      maxDailyLoss: 50,
      maxTradesPerSession: 20,
      maxConsecutiveSessionLosses: 5,
      pairConsecutiveLossCooldown: 3,
      allowOtc: true,
    });

    assert.equal(rm.canOpenTrade(1000).allowed, true);
    rm.recordTradeOpened();
    const r1 = rm.recordTradeOutcome({ asset: 'EURUSD', status: 'LOST', pnl: -10 });
    assert.equal(r1.haltSession, false);

    rm.recordTradeOpened();
    const r2 = rm.recordTradeOutcome({ asset: 'GBPUSD', status: 'LOST', pnl: -10 });
    assert.equal(r2.haltSession, false);

    rm.recordTradeOpened();
    const r3 = rm.recordTradeOutcome({ asset: 'USDJPY', status: 'LOST', pnl: -10 });
    assert.equal(r3.haltSession, true);
    assert.ok(r3.haltReason?.includes('Max session loss'));
    assert.equal(rm.canOpenTrade(970).allowed, false);
  });

  it('enforces persistent daily loss limit across restarts', () => {
    const rm = new RiskManager(
      {
        accountType: 'DEMO',
        stakeAmount: 10,
        profitGoal: 100,
        maxSessionLoss: 50,
        maxDailyLoss: 40,
        maxTradesPerSession: 20,
        maxConsecutiveSessionLosses: 5,
        pairConsecutiveLossCooldown: 3,
        allowOtc: true,
      },
      -35 // Already down -$35 earlier today
    );

    assert.equal(rm.canOpenTrade(1000).allowed, true);
    rm.recordTradeOpened();
    const res = rm.recordTradeOutcome({ asset: 'EURUSD', status: 'LOST', pnl: -10 });
    assert.equal(res.haltSession, true);
    assert.ok(res.haltReason?.includes('Max daily loss'));
  });

  it('halts on consecutive loss circuit breaker and maxTradesPerSession', () => {
    const rm = new RiskManager({
      accountType: 'DEMO',
      stakeAmount: 5,
      profitGoal: 100,
      maxSessionLoss: 100,
      maxDailyLoss: 200,
      maxTradesPerSession: 20,
      maxConsecutiveSessionLosses: 3,
      pairConsecutiveLossCooldown: 3,
      allowOtc: true,
    });

    rm.recordTradeOpened();
    rm.recordTradeOutcome({ asset: 'EURUSD', status: 'LOST', pnl: -5 });
    rm.recordTradeOpened();
    rm.recordTradeOutcome({ asset: 'EURUSD', status: 'LOST', pnl: -5 });
    rm.recordTradeOpened();
    const r3 = rm.recordTradeOutcome({ asset: 'EURUSD', status: 'LOST', pnl: -5 });
    assert.equal(r3.pairNeedsCooldown, true);
    assert.equal(r3.haltSession, true);
    assert.ok(r3.haltReason?.includes('consecutive losses'));
  });

  it('halts when profitGoal is reached', () => {
    const rm = new RiskManager({
      accountType: 'DEMO',
      stakeAmount: 10,
      profitGoal: 15,
      maxSessionLoss: 30,
      maxDailyLoss: 50,
      maxTradesPerSession: 20,
      maxConsecutiveSessionLosses: 4,
      pairConsecutiveLossCooldown: 3,
      allowOtc: true,
    });

    rm.recordTradeOpened();
    rm.recordTradeOutcome({ asset: 'EURUSD', status: 'WON', pnl: 8.5 });
    rm.recordTradeOpened();
    const r2 = rm.recordTradeOutcome({ asset: 'EURUSD', status: 'WON', pnl: 8.5 });
    assert.equal(r2.haltSession, true);
    assert.ok(r2.haltReason?.includes('Profit goal'));
  });

  it('blocks LIVE readiness until >= 300 demo trades with PROVEN_EDGE', () => {
    const fewTrades = Array.from({ length: 11 }, (_, i) =>
      makeTrade({ status: i < 5 ? 'WON' : 'LOST', profitLoss: i < 5 ? 8.5 : -10 })
    );
    const rFew = evaluateLiveReadiness(fewTrades);
    assert.equal(rFew.ready, false);
    assert.equal(rFew.demoTrades, 11);

    // 320 trades at 50% WR -> losing / inconclusive -> still BLOCKED
    const coinFlipTrades = Array.from({ length: 320 }, (_, i) =>
      makeTrade({ status: i % 2 === 0 ? 'WON' : 'LOST', profitLoss: i % 2 === 0 ? 8.5 : -10 })
    );
    assert.equal(evaluateLiveReadiness(coinFlipTrades).ready, false);

    // 320 trades at 65% WR (208W / 112L) at 85% payout -> 95% low ~59.6% > 54.05% -> READY
    const strongTrades = Array.from({ length: 320 }, (_, i) =>
      makeTrade({ status: i < 208 ? 'WON' : 'LOST', profitLoss: i < 208 ? 8.5 : -10 })
    );
    const rStrong = evaluateLiveReadiness(strongTrades);
    assert.equal(rStrong.ready, true);
    assert.equal(rStrong.verdict.verdict, 'PROVEN_EDGE');
  });
});
