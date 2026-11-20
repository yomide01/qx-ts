import { Candle } from '../stream/types.js';

/** Turns a list of closing prices into 5-minute candles (used by tests and diagnostics). */
export function candlesFromCloses(closes: number[], asset: string = 'EURUSD'): Candle[] {
  const start = 1_800_000_000_000;
  return closes.map((close, i) => {
    const open = i === 0 ? closes[0] : closes[i - 1];
    return {
      asset,
      timeframe: 300,
      openTime: start + i * 300_000,
      open,
      close,
      high: Math.max(open, close) + 0.0001,
      low: Math.min(open, close) - 0.0001,
      isClosed: true,
    };
  });
}

/**
 * A market that trends for 45 candles, pulls back for 4, then turns and moves with the trend
 * again for 3. dir = 1 builds the "dip in an uptrend" (a CALL setup on the last candle);
 * dir = -1 builds the mirror image (a PUT setup).
 */
export function pullbackSeries(dir: 1 | -1): Candle[] {
  const p = [1.05];
  for (let i = 0; i < 45; i++) p.push(p[p.length - 1] + dir * 0.0005);
  for (let i = 0; i < 4; i++) p.push(p[p.length - 1] - dir * 0.001);
  for (let i = 0; i < 3; i++) p.push(p[p.length - 1] + dir * 0.0005);
  return candlesFromCloses(p);
}
