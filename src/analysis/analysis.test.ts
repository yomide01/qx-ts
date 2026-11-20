import { TechnicalIndicators } from './indicators.js';
import { SignalEngine } from './signalEngine.js';
import { Candle } from '../stream/types.js';
import { candlesFromCloses, pullbackSeries } from './testSeries.js';

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

  // Test 5: Stochastic oscillator
  const rising = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 1 + i * 0.001));
  const falling = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 1 - i * 0.001));
  const stRise = TechnicalIndicators.calculateStochastic(rising);
  const stFall = TechnicalIndicators.calculateStochastic(falling);
  if (stRise.k[stRise.k.length - 1] < 85) throw new Error(`Stochastic should be high in a rising market: ${stRise.k.at(-1)}`);
  if (stFall.k[stFall.k.length - 1] > 15) throw new Error(`Stochastic should be low in a falling market: ${stFall.k.at(-1)}`);
  const allVals = [...stRise.k, ...stRise.d, ...stFall.k, ...stFall.d];
  if (allVals.some((v) => v < 0 || v > 100)) throw new Error('Stochastic left the 0-100 range');
  if (TechnicalIndicators.calculateStochastic(rising.slice(0, 10)).k.length !== 0) throw new Error('Stochastic should be empty with too little data');
  console.log('✓ Stochastic oscillator passed (rising -> high, falling -> low, always 0-100)');

  const engine = new SignalEngine();

  // Test 6: dip in an uptrend -> CALL, 5 minutes, all three indicators cited
  const callCandles = pullbackSeries(1);
  const callSignal = engine.evaluateSetup('EURUSD', false, callCandles, 85, Date.now());
  if (!callSignal || callSignal.direction !== 'CALL') {
    throw new Error(`Expected a CALL on a dip in an uptrend: ${JSON.stringify(callSignal)}`);
  }
  if (callSignal.expiryMinutes !== 5 || callSignal.expiryTime - callSignal.entryTime !== 300000) {
    throw new Error('Signal must state a 5-minute expiry');
  }
  const text = callSignal.reasons.join(' ');
  if (!/EMA/.test(text) || !/RSI/.test(text) || !/Stochastic/.test(text)) {
    throw new Error(`Signal must cite EMA, RSI and Stochastic: ${text}`);
  }
  console.log(`✓ CALL signal on a dip in an uptrend (score ${callSignal.confidence}, ${callSignal.expiryMinutes} min)`);
  console.log(`  Reasons: ${callSignal.reasons.join(' | ')}`);

  // Test 7: mirror image -> PUT
  const putSignal = engine.evaluateSetup('EURUSD', false, pullbackSeries(-1), 85, Date.now());
  if (!putSignal || putSignal.direction !== 'PUT') {
    throw new Error(`Expected a PUT on a bounce in a downtrend: ${JSON.stringify(putSignal)}`);
  }
  console.log(`✓ PUT signal on a bounce in a downtrend (score ${putSignal.confidence})`);

  // Test 8: no signal when the rules do not line up
  const calm = candlesFromCloses(Array.from({ length: 40 }, () => 1.05));
  if (engine.evaluateSetup('EURUSD', false, calm, 85, Date.now()) !== null) throw new Error('Flat market must give no signal');
  const steady = candlesFromCloses(Array.from({ length: 50 }, (_, i) => 1.05 + i * 0.0005));
  if (engine.evaluateSetup('EURUSD', false, steady, 85, Date.now()) !== null) throw new Error('A trend with no pullback must give no signal');
  // Same dip, but one candle too early (Stochastic has not crossed yet) -> must wait
  const early = pullbackSeries(1).slice(0, -2);
  const earlySignal = engine.evaluateSetup('EURUSD', false, early, 85, Date.now());
  if (earlySignal && earlySignal.direction === 'CALL') throw new Error('Must wait for the Stochastic cross before signalling');
  // A dip that is far too short to matter must not trigger either
  if (engine.evaluateSetup('EURUSD', false, pullbackSeries(1).slice(0, 10), 85, Date.now()) !== null) throw new Error('Too little data must give no signal');
  console.log('✓ No signal in flat markets, trends without a pullback, or before the Stochastic cross');

  // Test 9: Low payout filter (<80% payout should reject)
  if (engine.evaluateSetup('EURUSD', false, callCandles, 70, Date.now()) !== null) {
    throw new Error('Signal engine should reject trades with payout < 80%');
  }
  console.log('✓ Low payout filter passed (rejected 70% payout)');

  console.log('\nAll Phase 4 Indicator & Signal Engine Tests Passed!\n');
}

runAnalysisTests();
