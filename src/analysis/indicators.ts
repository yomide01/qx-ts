import { Candle } from '../stream/types.js';

export interface BollingerBandsResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
}

export interface CandleWickAnalysis {
  upperWickRatio: number;
  lowerWickRatio: number;
  bodyRatio: number;
  isBullish: boolean;
  totalRange: number;
}

export class TechnicalIndicators {
  /**
   * Exponential Moving Average (EMA)
   */
  public static calculateEMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];

    const k = 2 / (period + 1);
    const emaArray: number[] = [];

    // Initial SMA for first period
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[i];
    }
    let prevEma = sum / period;
    emaArray.push(prevEma);

    for (let i = period; i < prices.length; i++) {
      const currentEma = prices[i] * k + prevEma * (1 - k);
      emaArray.push(currentEma);
      prevEma = currentEma;
    }

    return emaArray;
  }

  /**
   * Relative Strength Index (RSI - Wilder's Smoothing)
   */
  public static calculateRSI(prices: number[], period: number = 14): number[] {
    if (prices.length <= period) return [];

    const gains: number[] = [];
    const losses: number[] = [];

    for (let i = 1; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? Math.abs(diff) : 0);
    }

    if (gains.length < period) return [];

    // First average
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

    const rsiValues: number[] = [];
    const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - 100 / (1 + firstRs));

    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

      if (avgLoss === 0) {
        rsiValues.push(100);
      } else {
        const rs = avgGain / avgLoss;
        rsiValues.push(100 - 100 / (1 + rs));
      }
    }

    return rsiValues;
  }

  /**
   * Slow Stochastic Oscillator (default 14, 3, 3).
   * %K shows where the close sits inside the recent high-low range (0 = at the lowest low,
   * 100 = at the highest high); %D is a smoothed copy of %K used for crossover timing.
   * Both arrays end at the most recent candle.
   */
  public static calculateStochastic(
    candles: Candle[],
    kPeriod: number = 14,
    kSmooth: number = 3,
    dPeriod: number = 3
  ): { k: number[]; d: number[] } {
    if (candles.length < kPeriod) return { k: [], d: [] };

    const raw: number[] = [];
    for (let i = kPeriod - 1; i < candles.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) {
        hh = Math.max(hh, candles[j].high);
        ll = Math.min(ll, candles[j].low);
      }
      raw.push(hh === ll ? 50 : (100 * (candles[i].close - ll)) / (hh - ll));
    }

    const sma = (values: number[], period: number): number[] => {
      if (values.length < period) return [];
      const out: number[] = [];
      for (let i = period - 1; i < values.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += values[j];
        out.push(sum / period);
      }
      return out;
    };

    const k = sma(raw, kSmooth);
    const d = sma(k, dPeriod);
    return { k, d };
  }

  /**
   * Bollinger Bands (20 period, 2 std dev)
   */
  public static calculateBollingerBands(
    prices: number[],
    period: number = 20,
    stdDevMultiplier: number = 2
  ): BollingerBandsResult | null {
    if (prices.length < period) return null;

    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;

    const variance =
      slice.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    const upper = mean + stdDevMultiplier * stdDev;
    const lower = mean - stdDevMultiplier * stdDev;
    const bandwidth = mean > 0 ? (upper - lower) / mean : 0;

    return {
      upper,
      middle: mean,
      lower,
      bandwidth,
    };
  }

  /**
   * Analyzes candlestick body vs upper/lower rejection wicks
   */
  public static analyzeCandleWicks(candle: Candle): CandleWickAnalysis {
    const totalRange = candle.high - candle.low;
    if (totalRange <= 0) {
      return {
        upperWickRatio: 0,
        lowerWickRatio: 0,
        bodyRatio: 1,
        isBullish: candle.close >= candle.open,
        totalRange: 0,
      };
    }

    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const body = Math.abs(candle.close - candle.open);

    return {
      upperWickRatio: upperWick / totalRange,
      lowerWickRatio: lowerWick / totalRange,
      bodyRatio: body / totalRange,
      isBullish: candle.close >= candle.open,
      totalRange,
    };
  }

  /**
   * Classifies the market regime using closed candles
   */
  public static classifyRegime(candles: Candle[]): 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY' {
    if (candles.length < 25) return 'RANGING';

    const closes = candles.map((c) => c.close);
    const emaFastArr = this.calculateEMA(closes, 9);
    const emaSlowArr = this.calculateEMA(closes, 21);
    const bb = this.calculateBollingerBands(closes, 20);

    if (emaFastArr.length === 0 || emaSlowArr.length === 0 || !bb) {
      return 'RANGING';
    }

    const currentEmaFast = emaFastArr[emaFastArr.length - 1];
    const currentEmaSlow = emaSlowArr[emaSlowArr.length - 1];
    const prevEmaFast = emaFastArr[emaFastArr.length - 2];
    const prevEmaSlow = emaSlowArr[emaSlowArr.length - 2];

    // High volatility check (wide Bollinger bandwidth)
    if (bb.bandwidth > 0.008) {
      return 'HIGH_VOLATILITY';
    }

    // Trending Up: Fast EMA clearly above Slow EMA and sloping upward
    if (currentEmaFast > currentEmaSlow && currentEmaFast > prevEmaFast) {
      return 'TRENDING_UP';
    }

    // Trending Down: Fast EMA clearly below Slow EMA and sloping downward
    if (currentEmaFast < currentEmaSlow && currentEmaFast < prevEmaFast) {
      return 'TRENDING_DOWN';
    }

    return 'RANGING';
  }
}
