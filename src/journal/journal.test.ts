import { TradingJournalDB } from './database.js';
import { JournalAnalytics } from './analytics.js';
import { TradeRecord } from './types.js';

function runJournalTests() {
  console.log('--- Testing Phase 3: SQLite Journal & Analytics ---');

  // Test 1: In-memory database initialization
  const db = new TradingJournalDB(':memory:');
  console.log('✓ Database initialized with schema');

  // Test 2: Record a Trade
  const mockTrade1: TradeRecord = {
    id: 'deal_001',
    asset: 'EURUSD',
    isOtc: false,
    direction: 'CALL',
    timeframeSeconds: 300,
    payoutPercent: 85,
    stakeAmount: 50,
    openTime: Date.now() - 300000,
    closeTime: Date.now(),
    openPrice: 1.05400,
    status: 'OPEN',
    isDemo: true,
    marketRegime: 'TRENDING_UP',
    signalConfidence: 75,
    signalReason: 'EMA 50 Bounce',
    indicatorsAtEntry: { rsi: 35, emaFast: 1.0542, emaSlow: 1.0538 },
  };

  db.recordTrade(mockTrade1);
  const fetched = db.getTrade('deal_001');
  if (!fetched || fetched.asset !== 'EURUSD' || fetched.status !== 'OPEN') {
    throw new Error(`Failed to record/fetch trade: ${JSON.stringify(fetched)}`);
  }
  console.log('✓ Trade recording passed');

  // Test 3: Settle Trade as WON
  db.updateTradeOutcome('deal_001', 1.05445, 42.50, 'WON');
  const settled = db.getTrade('deal_001');
  if (!settled || settled.status !== 'WON' || settled.profitLoss !== 42.50) {
    throw new Error(`Failed to update trade settlement: ${JSON.stringify(settled)}`);
  }
  console.log('✓ Trade settlement update passed');

  // Test 4: Record additional trades (including an OTC loss)
  const mockTrade2: TradeRecord = {
    id: 'deal_002',
    asset: 'USDJPY_OTC',
    isOtc: true,
    direction: 'PUT',
    timeframeSeconds: 300,
    payoutPercent: 90,
    stakeAmount: 50,
    openTime: Date.now() - 300000,
    closeTime: Date.now(),
    openPrice: 154.20,
    closePrice: 154.30,
    status: 'LOST',
    profitLoss: -50.00,
    isDemo: true,
    marketRegime: 'RANGING',
  };
  db.recordTrade(mockTrade2);

  const mockTrade3: TradeRecord = {
    id: 'deal_003',
    asset: 'EURUSD',
    isOtc: false,
    direction: 'CALL',
    timeframeSeconds: 300,
    payoutPercent: 85,
    stakeAmount: 50,
    openTime: Date.now() - 600000,
    closeTime: Date.now() - 300000,
    openPrice: 1.0535,
    closePrice: 1.0541,
    status: 'WON',
    profitLoss: 42.50,
    isDemo: true,
    marketRegime: 'TRENDING_UP',
  };
  db.recordTrade(mockTrade3);

  // Test 5: Analytics & Expected Value computation
  const allTrades = db.getAllTrades();
  const summary = JournalAnalytics.computeSummary(allTrades);

  console.log(`Total: ${summary.totalTrades}, Wins: ${summary.wonTrades}, Losses: ${summary.lostTrades}`);
  console.log(`Overall Winrate: ${summary.overallWinRate.toFixed(1)}%`);
  console.log(`Live Winrate   : ${summary.liveWinRate.toFixed(1)}%`);
  console.log(`OTC Winrate    : ${summary.otcWinRate.toFixed(1)}%`);
  console.log(`Net PnL        : $${summary.totalPnL.toFixed(2)}`);

  if (summary.totalTrades !== 3 || summary.wonTrades !== 2 || summary.lostTrades !== 1) {
    throw new Error(`Incorrect summary stats: ${JSON.stringify(summary)}`);
  }
  if (Math.round(summary.liveWinRate) !== 100 || Math.round(summary.otcWinRate) !== 0) {
    throw new Error('Incorrect live vs otc win rate calculation');
  }

  // Breakeven check: At 85% payout, breakeven is 1 / 1.85 = 54.05%
  const breakeven = JournalAnalytics.calculateBreakevenWinRate(85);
  if (Math.round(breakeven) !== 54) {
    throw new Error(`Breakeven win rate calculation error: ${breakeven}`);
  }
  console.log(`✓ Breakeven threshold calculation passed: ${breakeven.toFixed(2)}%`);

  // Test 6: Regression — sanitize corrupted payout (1380 dollar profit on 1500 stake -> 92%) & UNIX second timeframe calculation
  const repairedPayout = TradingJournalDB.sanitizePayoutPercent(1380, 1500);
  if (repairedPayout !== 92) {
    throw new Error(`Expected corrupted payout 1380 on 1500 stake to sanitize to 92%, got ${repairedPayout}`);
  }
  const tfFromUnixSeconds = TradingJournalDB.computeTimeframeSeconds(1795452891, 1795453191, 300);
  if (tfFromUnixSeconds !== 300) {
    throw new Error(`Expected 300s timeframe from UNIX-second timestamps, got ${tfFromUnixSeconds}`);
  }
  console.log('✓ Payout sanitization (1380 -> 92%) and UNIX-second timeframe calculation passed');

  // Test 7: Regression — attaching signal context after initial trade open updates SQLite row via ON CONFLICT
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
    signalConfidence: 88,
    signalReason: 'EMA Pullback Sniper',
    marketRegime: 'TRENDING_UP',
    indicatorsAtEntry: { rsi: 48.5, emaFast: 1.2648, emaSlow: 1.2640 },
  });
  const updatedTrade4 = db.getTrade('deal_004');
  if (
    !updatedTrade4 ||
    updatedTrade4.payoutPercent !== 92 ||
    updatedTrade4.timeframeSeconds !== 300 ||
    updatedTrade4.marketRegime !== 'TRENDING_UP' ||
    updatedTrade4.signalConfidence !== 88 ||
    updatedTrade4.indicatorsAtEntry?.rsi !== 48.5
  ) {
    throw new Error(`Failed to update signal context or sanitize fields on conflict: ${JSON.stringify(updatedTrade4)}`);
  }
  console.log('✓ Signal context attachment & ON CONFLICT update passed');

  db.close();
  console.log('\nAll Phase 3 SQLite Journal & Analytics Tests Passed!\n');
}

runJournalTests();
