import { TechnicalIndicators } from './indicators.js';
import { SignalEngine } from './signalEngine.js';
import { Candle } from '../stream/types.js';

function runAnalysisTests() {
  console.log('--- Testing Phase 4: Mathematical Indicators & Signal Engine ---');

  // Test 1: EMA Calculation
  const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const ema = TechnicalIndicators.calculateEMA(prices, 5);
  if (ema.length !== 7 || ema[ema.length - 1] < 18) {
    throw new Error(`EMA calculation failed: ${JSON.stringify(ema)}`);
  }
  console.log('✓ EMA calculation passed');

  // Test 2: RSI Calculation
  // Consistently rising prices should produce high RSI (>70)
  const risingPrices = [
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
    110, 111, 112, 113, 114, 115, 116, 117, 118, 119
  ];
  const rsiRising = TechnicalIndicators.calculateRSI(risingPrices, 14);
  const latestRsi = rsiRising[rsiRising.length - 1];
  if (latestRsi < 75) {
    throw new Error(`RSI calculation on rising series failed. Got ${latestRsi}`);
  }
  console.log(`✓ RSI calculation passed (Rising series RSI: ${latestRsi.toFixed(1)})`);

  // Test 3: Bollinger Bands
  const bbPrices = Array.from({ length: 25 }, (_, i) => 1.0500 + Math.sin(i / 2) * 0.0050);
  const bb = TechnicalIndicators.calculateBollingerBands(bbPrices, 20);
  if (!bb || bb.upper <= bb.middle || bb.middle <= bb.lower) {
    throw new Error(`Bollinger Bands calculation failed: ${JSON.stringify(bb)}`);
  }
  console.log('✓ Bollinger Bands calculation passed');

  // Test 4: Candlestick Rejection Wick
  const hammerCandle: Candle = {
    asset: 'EURUSD',
    timeframe: 300,
    openTime: Date.now(),
    open: 1.0550,
    high: 1.0555,
    low: 1.0500, // deep low
    close: 1.0545, // closes near open/high -> long lower wick
    isClosed: true,
  };
  const wickAnalysis = TechnicalIndicators.analyzeCandleWicks(hammerCandle);
  if (wickAnalysis.lowerWickRatio < 0.70) {
    throw new Error(`Wick rejection analysis failed: ${JSON.stringify(wickAnalysis)}`);
  }
  console.log(`✓ Rejection wick analysis passed (Lower wick ratio: ${(wickAnalysis.lowerWickRatio * 100).toFixed(0)}%)`);

  // Test 5: Signal Engine Call Setup Evaluation
  const engine = new SignalEngine();
  // Build a synthetic 30-candle sequence exhibiting a CALL setup at support
  const mockCandles: Candle[] = [];
  const baseTime = Date.now() - 30 * 300000;
  for (let i = 0; i < 29; i++) {
    const p = 1.0500 + i * 0.0002;
    mockCandles.push({
      asset: 'EURUSD',
      timeframe: 300,
      openTime: baseTime + i * 300000,
      open: p,
      high: p + 0.0003,
      low: p - 0.0001,
      close: p + 0.0002,
      isClosed: true,
    });
  }
  // Add 30th candle as a strong lower wick rejection at support
  mockCandles.push({
    asset: 'EURUSD',
    timeframe: 300,
    openTime: baseTime + 29 * 300000,
    open: 1.0558,
    high: 1.0560,
    low: 1.0520, // 40-pip dip
    close: 1.0556, // recovered -> 90% lower wick
    isClosed: true,
  });

  const signal = engine.evaluateSetup('EURUSD', false, mockCandles, 85, Date.now());
  if (!signal || signal.direction !== 'CALL') {
    throw new Error(`Signal engine failed to generate expected CALL signal: ${JSON.stringify(signal)}`);
  }
  if (signal.confidence < 70) {
    throw new Error(`Signal confidence too low: ${signal.confidence}%`);
  }
  console.log(`✓ Signal Engine generated CALL signal with ${signal.confidence}% confidence`);
  console.log(`  Reasons: ${signal.reasons.join(' | ')}`);

  // Test 6: Low payout filter (<80% payout should reject)
  const lowPayoutSignal = engine.evaluateSetup('EURUSD', false, mockCandles, 70, Date.now());
  if (lowPayoutSignal !== null) {
    throw new Error('Signal engine should reject trades with payout < 80%');
  }
  console.log('✓ Low payout filter passed (rejected 70% payout)');

  console.log('\nAll Phase 4 Indicator & Signal Engine Tests Passed!\n');
}

runAnalysisTests();
