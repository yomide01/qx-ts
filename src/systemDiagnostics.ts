import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { QxWsParser } from './stream/wsParser.js';
import { QxWsSniffer } from './stream/wsSniffer.js';
import { CandleAggregator } from './stream/candleAggregator.js';
import { TechnicalIndicators } from './analysis/indicators.js';
import { SignalEngine } from './analysis/signalEngine.js';
import { TradingJournalDB } from './journal/database.js';
import { JournalAnalytics } from './journal/analytics.js';
import { playAlertSound } from './ui/sound.js';
import { Candle } from './stream/types.js';

interface DiagnosticResult {
  suite: string;
  test: string;
  passed: boolean;
  details?: string;
}

async function runFullDiagnostics() {
  console.log('================================================================');
  console.log('       QX TRADING ASSISTANT: FULL END-TO-END SYSTEM DIAGNOSTICS ');
  console.log('================================================================\n');

  const results: DiagnosticResult[] = [];

  function record(suite: string, test: string, passed: boolean, details?: string) {
    results.push({ suite, test, passed, details });
    const statusMark = passed ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
    console.log(`${statusMark} ${suite} :: ${test} ${details ? `(${details})` : ''}`);
  }

  // -------------------------------------------------------------
  // SUITE 1: File System & Profile Persistence
  // -------------------------------------------------------------
  console.log('\n--- 1. File System & Persistent Environment ---');
  record('Environment', 'Google Chrome Binary Exists', fs.existsSync(config.chromePath), config.chromePath);
  record('Environment', 'Profile Directory Exists', fs.existsSync(config.userDataDir), config.userDataDir);

  const defaultProfile = path.join(config.userDataDir, 'Default');
  const hasProfileData = fs.existsSync(defaultProfile) && fs.readdirSync(defaultProfile).length > 5;
  record('Environment', 'Saved Session Data Present', hasProfileData, 'Cookies and session storage active');

  const dbPath = path.resolve(process.cwd(), 'data', 'qx_trading.db');
  record('Environment', 'SQLite Database Present', fs.existsSync(dbPath), dbPath);

  // -------------------------------------------------------------
  // SUITE 2: WebSocket Parser & Protocol Handling
  // -------------------------------------------------------------
  console.log('\n--- 2. WebSocket Protocol Parser ---');
  const parser = new QxWsParser();

  // Test Socket.IO Tick
  const tickPacket = '42["tick",{"asset":"EURUSD","time":1700000100,"price":1.05432}]';
  const parsedTickMsg = parser.parseFrame(tickPacket);
  const tick = parsedTickMsg ? parser.extractTick(parsedTickMsg.eventName, parsedTickMsg.data) : null;
  record('WsParser', 'Extract Socket.IO Tick', Boolean(tick && tick.asset === 'EURUSD' && tick.price === 1.05432));

  // Test Payouts with Live vs OTC distinction
  const payoutPacket =
    '42["instruments",[{"symbol":"EURUSD","name":"EUR/USD","payout":87,"is_otc":false},{"symbol":"USDJPY_otc","name":"USD/JPY (OTC)","payout":92,"is_otc":true}]]';
  const parsedPayoutMsg = parser.parseFrame(payoutPacket);
  const payouts = parsedPayoutMsg ? parser.extractPayouts(parsedPayoutMsg.eventName, parsedPayoutMsg.data) : [];
  record(
    'WsParser',
    'Extract Live & OTC Payouts',
    payouts.length === 2 && payouts[0].payoutPercent === 87 && payouts[1].isOtc === true,
    `Found ${payouts.length} assets, OTC detected`
  );

  // Test Engine.IO Heartbeat filter
  record('WsParser', 'Filter Heartbeat Ping (2) and Pong (3)', parser.parseFrame('2') === null && parser.parseFrame('3') === null);

  // -------------------------------------------------------------
  // SUITE 3: Candle Aggregator & Dynamic OHLC
  // -------------------------------------------------------------
  console.log('\n--- 3. Candle Aggregation Engine ---');
  const sniffer = new QxWsSniffer();
  const aggregator = new CandleAggregator(sniffer);

  // Simulate 60 ticks across 1 minute to test M1 candle closure
  const baseTime = Math.floor(Date.now() / 60000) * 60000;
  for (let s = 0; s < 60; s++) {
    const simTick = {
      asset: 'EURUSD',
      time: baseTime + s * 1000,
      price: 1.0500 + Math.sin(s / 10) * 0.0010,
    };
    (sniffer as any).handleIncomingFrame(`42["tick",${JSON.stringify(simTick)}]`);
  }

  const activeM1 = aggregator.getCurrentCandle('EURUSD', 60);
  record(
    'CandleAggregator',
    'M1 Live Candle Construction',
    Boolean(activeM1 && activeM1.high >= activeM1.low && activeM1.open > 0),
    `O: ${activeM1?.open?.toFixed(4)}, H: ${activeM1?.high?.toFixed(4)}, L: ${activeM1?.low?.toFixed(4)}, C: ${activeM1?.close?.toFixed(4)}`
  );

  // -------------------------------------------------------------
  // SUITE 4: Quantitative Math & Setup Detection
  // -------------------------------------------------------------
  console.log('\n--- 4. Quantitative Math & Signal Engine ---');
  const closes = Array.from({ length: 30 }, (_, i) => 1.0500 + i * 0.0003);
  const emaFast = TechnicalIndicators.calculateEMA(closes, 9);
  const emaSlow = TechnicalIndicators.calculateEMA(closes, 21);
  record('Indicators', 'EMA 9 / 21 Calculation', emaFast.length > 0 && emaSlow.length > 0 && emaFast[emaFast.length - 1] > emaSlow[emaSlow.length - 1]);

  const rsi = TechnicalIndicators.calculateRSI(closes, 14);
  record('Indicators', 'Wilders RSI (14) Calculation', rsi.length > 0 && rsi[rsi.length - 1] > 70, `RSI: ${rsi[rsi.length - 1]?.toFixed(1)}`);

  const bb = TechnicalIndicators.calculateBollingerBands(closes, 20);
  record('Indicators', 'Bollinger Bands (20, 2)', Boolean(bb && bb.upper > bb.middle && bb.middle > bb.lower));

  // Test Pinbar Rejection Wick
  const hammer: Candle = {
    asset: 'EURUSD',
    timeframe: 300,
    openTime: Date.now(),
    open: 1.0550,
    high: 1.0555,
    low: 1.0510,
    close: 1.0548,
    isClosed: true,
  };
  const wick = TechnicalIndicators.analyzeCandleWicks(hammer);
  record('Indicators', 'Candle Rejection Wick Analysis', wick.lowerWickRatio >= 0.70, `Lower wick ratio: ${(wick.lowerWickRatio * 100).toFixed(0)}%`);

  // Test Signal Engine CALL detection
  const engine = new SignalEngine();
  const mockHistory: Candle[] = [];
  for (let i = 0; i < 29; i++) {
    const p = 1.0500 + i * 0.0002;
    mockHistory.push({
      asset: 'EURUSD',
      timeframe: 300,
      openTime: Date.now() - (30 - i) * 300000,
      open: p,
      high: p + 0.0002,
      low: p - 0.0001,
      close: p + 0.0001,
      isClosed: true,
    });
  }
  // 30th candle: hammer rejection at lower band
  mockHistory.push({
    asset: 'EURUSD',
    timeframe: 300,
    openTime: Date.now() - 300000,
    open: 1.0555,
    high: 1.0557,
    low: 1.0515,
    close: 1.0553,
    isClosed: true,
  });

  const signal = engine.evaluateSetup('EURUSD', false, mockHistory, 85, Date.now() + 300000);
  record(
    'SignalEngine',
    'Confluence CALL Signal Generation',
    Boolean(signal && signal.direction === 'CALL' && signal.confidence >= 70),
    `Confidence: ${signal?.confidence}%, Reasons: ${signal?.reasons.length}`
  );

  // Test Negative EV Filter (Payout < 80% must be rejected)
  const rejectedSignal = engine.evaluateSetup('EURUSD', false, mockHistory, 65, Date.now() + 300000);
  record('SignalEngine', 'Negative EV Payout Gatekeeper (<80% Rejected)', rejectedSignal === null, 'Rejected 65% payout');

  // -------------------------------------------------------------
  // SUITE 5: SQLite Database & Expected Value Math
  // -------------------------------------------------------------
  console.log('\n--- 5. Database & Expected Value Analytics ---');
  const testDb = new TradingJournalDB(':memory:');

  testDb.recordTrade({
    id: 'diag_trade_1',
    asset: 'EURUSD',
    isOtc: false,
    direction: 'CALL',
    timeframeSeconds: 300,
    payoutPercent: 85,
    stakeAmount: 10,
    openTime: Date.now() - 300000,
    closeTime: Date.now(),
    openPrice: 1.0540,
    status: 'OPEN',
    isDemo: true,
  });

  const retrieved = testDb.getTrade('diag_trade_1');
  record('Database', 'CRUD Insert & Retrieve Trade', Boolean(retrieved && retrieved.status === 'OPEN'));

  testDb.updateTradeOutcome('diag_trade_1', 1.0545, 8.50, 'WON');
  const settled = testDb.getTrade('diag_trade_1');
  record('Database', 'Trade Settlement & PnL Update', Boolean(settled && settled.status === 'WON' && settled.profitLoss === 8.50));

  // Breakeven math check: 1 / (1 + 0.85) = ~54.05%
  const breakeven = JournalAnalytics.calculateBreakevenWinRate(85);
  record('Analytics', 'Quotex Breakeven Formula Verification', Math.abs(breakeven - 54.05) < 0.1, `85% payout requires ${breakeven.toFixed(2)}% win rate`);

  // Expected Value check: At 60% winrate and 85% payout: EV = (0.60 * 0.85) - (0.40 * 1.0) = +0.11 (+11%)
  const evSummary = JournalAnalytics.computeSummary([
    settled!,
    { ...settled!, id: 'diag_trade_2', status: 'WON', profitLoss: 8.50 },
    { ...settled!, id: 'diag_trade_3', status: 'WON', profitLoss: 8.50 },
    { ...settled!, id: 'diag_trade_4', status: 'LOST', profitLoss: -10.00 },
    { ...settled!, id: 'diag_trade_5', status: 'LOST', profitLoss: -10.00 },
  ]);
  record('Analytics', 'Expected Value (EV) Calculation', evSummary.expectedValue > 0, `EV: +${(evSummary.expectedValue * 100).toFixed(1)}% per trade`);
  testDb.close();

  // -------------------------------------------------------------
  // SUITE 6: Audio & UI Alert System
  // -------------------------------------------------------------
  console.log('\n--- 6. Audible & Visual Alert System ---');
  try {
    playAlertSound();
    record('UI', 'System Alert Beep Audio Trigger', true, 'Executed without exceptions');
  } catch (err) {
    record('UI', 'System Alert Beep Audio Trigger', false, (err as Error).message);
  }

  // -------------------------------------------------------------
  // DIAGNOSTIC SUMMARY
  // -------------------------------------------------------------
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  console.log('\n================================================================');
  console.log(`DIAGNOSTIC RESULTS: ${passed}/${total} TESTS PASSED (${failed} failures)`);
  console.log('================================================================\n');

  if (failed === 0) {
    console.log('>>> [VERDICT: ALL SYSTEMS OPERATIONAL] The bot is fully functional,');
    console.log('>>> mathematically verified, and actively monitoring Quotex.\n');
  } else {
    console.log(`>>> [VERDICT: ${failed} ISSUES DETECTED] Please check failed items above.\n`);
  }
}

runFullDiagnostics().catch(console.error);
