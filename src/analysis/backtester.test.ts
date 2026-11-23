import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOhlcCsv,
  runRollingWalkForwardBacktest,
  buildSignFlippedCandles,
  formatBacktestReport,
} from './backtester.js';
import { Candle } from '../stream/types.js';

function makeRandomCandles(count: number, seed: number): Candle[] {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let price = 1.15;
  const start = 1_700_000_000_000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const delta = (rand() - 0.5) * 0.002;
    const close = Math.max(0.5, open + delta);
    out.push({
      asset: 'EURUSD',
      timeframe: 300,
      openTime: start + i * 300_000,
      open,
      high: Math.max(open, close) + rand() * 0.0005,
      low: Math.min(open, close) - rand() * 0.0005,
      close,
      isClosed: true,
    });
    price = close;
  }
  return out;
}

describe('Offline Walk-Forward Backtester', () => {
  it('parses standard OHLC CSV files with header and UNIX or ISO timestamps', () => {
    const csv = [
      'timestamp,open,high,low,close',
      '1700000000,1.1000,1.1010,1.0990,1.1005',
      '2026-11-23 10:05:00,1.1005,1.1020,1.1000,1.1015',
    ].join('\n');
    const parsed = parseOhlcCsv(csv, 'EUR/USD', 300);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].asset, 'EURUSD');
    assert.equal(parsed[0].openTime, 1700000000000);
    assert.equal(parsed[1].close, 1.1015);
  });

  it('builds sign-flipped random walk preserving bar count and positive prices', () => {
    const src = makeRandomCandles(200, 7);
    const flipped = buildSignFlippedCandles(src, 99);
    assert.equal(flipped.length, src.length);
    for (const c of flipped) {
      assert.ok(c.high >= Math.max(c.open, c.close));
      assert.ok(c.low <= Math.min(c.open, c.close));
      assert.ok(c.close > 0);
    }
  });

  it('runs rolling walk-forward backtest on random walk without claiming PROVEN_EDGE', () => {
    const candles = makeRandomCandles(500, 2026);
    const report = runRollingWalkForwardBacktest(candles, {
      payoutPercent: 85,
      trainBars: 140,
      testBars: 40,
      stepBars: 40,
      monteCarloTrials: 10,
      seed: 123,
    });

    assert.ok(report.foldsEvaluated >= 8);
    assert.notEqual(report.verdict.verdict, 'PROVEN_EDGE');
    assert.ok(report.monteCarloBaseline);
    assert.equal(report.monteCarloBaseline?.trials, 10);
    const text = formatBacktestReport(report);
    assert.ok(text.includes('WALK-FORWARD BACKTEST'));
    assert.ok(text.includes('VERDICT'));
  });
});
