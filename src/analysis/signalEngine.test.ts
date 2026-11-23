import { SignalEngine } from './signalEngine.js';
import { VisualChartEngine } from './visualChartEngine.js';
import { Candle } from '../stream/types.js';
import { TradeRecord } from '../journal/types.js';

function makeCandles(count: number, step: number = 0.0002): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1;
  const startMs = Date.now() - count * 300_000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const delta = i % 4 === 2 ? -step * 0.6 : step;
    const close = open + delta;
    const high = Math.max(open, close) + step * 0.3;
    const low = Math.min(open, close) - step * 0.4;
    candles.push({
      asset: 'EURUSD',
      timeframe: 300,
      openTime: startMs + i * 300_000,
      open,
      high,
      low,
      close,
      isClosed: true,
    });
    price = close;
  }
  return candles;
}

function runSignalEngineTests() {
  console.log('--- Testing SignalEngine & VisualChartEngine ---');
  const engine = new SignalEngine();
  const visualEngine = new VisualChartEngine();

  // Test 1: Rejects low payouts (< 80%)
  const candles = makeCandles(80);
  const lowPayoutReport = engine.calibratePairPlaybook('EURUSD', candles, 75, 300);
  if (lowPayoutReport.isTradeable || !lowPayoutReport.shouldRemovePair) {
    throw new Error('Expected low payout (<80%) to be marked non-tradeable and removable');
  }
  console.log('✓ Low payout rejection (< 80%) passed');

  // Test 2: Never fakes OOS win rate when there are 0 OOS signals
  // Flat candles only during the last 35% (OOS window) produce 0 OOS signals
  const oosStarved = makeCandles(80);
  for (let i = 52; i < 80; i++) {
    const base = oosStarved[51].close;
    oosStarved[i] = {
      ...oosStarved[i],
      open: base,
      high: base + 0.00005,
      low: base - 0.00001,
      close: base + 0.00002,
    };
  }
  const oosReport = engine.calibratePairPlaybook('EURUSD', oosStarved, 88, 300);
  if (oosReport.bestStats && oosReport.bestStats.oosWins + oosReport.bestStats.oosLosses < 2) {
    throw new Error('Calibration must not accept candidates with fewer than 2 real OOS signals');
  }
  console.log('✓ Anti-fake-OOS validation (requires >= 2 real OOS trades) passed');

  // Test 3: Populates marketRegime and indicatorsAtEntry, and triggers circuit breaker on UNIX-second timestamps
  const nowSec = Math.floor(Date.now() / 1000);
  const recentLosses: TradeRecord[] = [
    {
      id: 'loss-1',
      asset: 'EURUSD',
      isOtc: false,
      direction: 'CALL',
      timeframeSeconds: 300,
      payoutPercent: 88,
      stakeAmount: 50,
      openTime: nowSec - 600, // UNIX seconds (10m ago)
      closeTime: nowSec - 300,
      openPrice: 1.1,
      closePrice: 1.099,
      status: 'LOST',
      profitLoss: -50,
      isDemo: true,
    },
    {
      id: 'loss-2',
      asset: 'EURUSD',
      isOtc: false,
      direction: 'CALL',
      timeframeSeconds: 300,
      payoutPercent: 88,
      stakeAmount: 50,
      openTime: nowSec - 300, // UNIX seconds (5m ago)
      closeTime: nowSec,
      openPrice: 1.099,
      closePrice: 1.098,
      status: 'LOST',
      profitLoss: -50,
      isDemo: true,
    },
  ];

  const visual = visualEngine.analyzeCandles(candles);
  if (!visual.canvasFound || visual.trendDirection !== 'UPTREND') {
    throw new Error(`Expected deterministic OHLC structure analysis to detect UPTREND, got ${JSON.stringify(visual)}`);
  }

  const intel = engine.analyzeAdaptivePairIntelligence('EURUSD', false, candles, 88, visual, recentLosses, 1.11, 300);
  if (!intel.shouldSwitchPair || !intel.switchReason?.includes('2 consecutive live losses')) {
    throw new Error(`Expected UNIX-second journal circuit breaker to trigger, got: ${intel.switchReason}`);
  }
  if (!intel.marketRegime || typeof intel.indicatorsAtEntry?.rsi !== 'number') {
    throw new Error('Expected marketRegime and indicatorsAtEntry to be populated');
  }
  console.log('✓ Deterministic OHLC visual structure, indicator snapshot & UNIX-second journal circuit breaker passed');

  console.log('\nAll SignalEngine & VisualChartEngine Tests Passed!\n');
}

runSignalEngineTests();
