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

export type CandlestickPattern =
  | 'PINBAR_BULLISH'
  | 'PINBAR_BEARISH'
  | 'ENGULFING_BULLISH'
  | 'ENGULFING_BEARISH'
  | 'DOJI'
  | 'NONE';

export interface SupportResistanceLevels {
  supports: number[];
  resistances: number[];
}

export class TechnicalIndicators {
  /**
   * Simple Moving Average (SMA)
   */
  public static calculateSMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    const smaArray: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[i];
    }
    smaArray.push(sum / period);

    for (let i = period; i < prices.length; i++) {
      sum += prices[i] - prices[i - period];
      smaArray.push(sum / period);
    }
    return smaArray;
  }

  /**
   * Exponential Moving Average (EMA)
   */
  public static calculateEMA(prices: number[], period: number): number[] {
    const effPeriod = Math.max(2, Math.min(period, prices.length));
    if (prices.length < 2) return [];

    const k = 2 / (effPeriod + 1);
    const emaArray: number[] = [];

    // Initial SMA for first period
    let sum = 0;
    for (let i = 0; i < effPeriod; i++) {
      sum += prices[i];
    }
    let prevEma = sum / effPeriod;
    emaArray.push(prevEma);

    for (let i = effPeriod; i < prices.length; i++) {
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
    if (prices.length < 3) return [];
    const effPeriod = Math.max(2, Math.min(period, prices.length - 1));

    const gains: number[] = [];
    const losses: number[] = [];

    for (let i = 1; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? Math.abs(diff) : 0);
    }

    if (gains.length < effPeriod) return [];

    // First average
    let avgGain = gains.slice(0, effPeriod).reduce((a, b) => a + b, 0) / effPeriod;
    let avgLoss = losses.slice(0, effPeriod).reduce((a, b) => a + b, 0) / effPeriod;

    const rsiValues: number[] = [];
    const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - 100 / (1 + firstRs));

    for (let i = effPeriod; i < gains.length; i++) {
      avgGain = (avgGain * (effPeriod - 1) + gains[i]) / effPeriod;
      avgLoss = (avgLoss * (effPeriod - 1) + losses[i]) / effPeriod;

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
   * Average True Range (ATR - Wilder's Smoothing)
   * Measures true market volatility independent of price direction.
   */
  public static calculateATR(candles: Candle[], period: number = 14): number[] {
    if (candles.length < 2) return [];
    const effPeriod = Math.max(2, Math.min(period, candles.length - 1));

    const trValues: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - prev.close),
        Math.abs(current.low - prev.close)
      );
      trValues.push(tr);
    }

    if (trValues.length < effPeriod) return [];

    const atrValues: number[] = [];
    let initialAtr = trValues.slice(0, effPeriod).reduce((a, b) => a + b, 0) / effPeriod;
    atrValues.push(initialAtr);

    let prevAtr = initialAtr;
    for (let i = effPeriod; i < trValues.length; i++) {
      const currentAtr = (prevAtr * (effPeriod - 1) + trValues[i]) / effPeriod;
      atrValues.push(currentAtr);
      prevAtr = currentAtr;
    }

    return atrValues;
  }

  /**
   * Slow Stochastic Oscillator (default 14, 3, 3).
   * %K shows where the close sits inside the recent high-low range (0 = at lowest low, 100 = at highest high).
   * %D is a smoothed copy of %K used for crossover timing.
   */
  public static calculateStochastic(
    candles: Candle[],
    kPeriod: number = 14,
    kSmooth: number = 3,
    dPeriod: number = 3
  ): { k: number[]; d: number[] } {
    if (candles.length < 3) return { k: [], d: [] };
    const effK = Math.max(2, Math.min(kPeriod, candles.length));
    const effSmooth = Math.max(1, Math.min(kSmooth, effK));
    const effD = Math.max(1, Math.min(dPeriod, effK));

    const raw: number[] = [];
    for (let i = effK - 1; i < candles.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - effK + 1; j <= i; j++) {
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

    const k = sma(raw, effSmooth);
    const d = sma(k, effD);
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
   * Identifies micro-structure price action patterns (Pinbars, Engulfing, Doji)
   */
  public static detectPattern(candle: Candle, prevCandle?: Candle): CandlestickPattern {
    const wick = this.analyzeCandleWicks(candle);
    if (wick.totalRange <= 0) return 'NONE';

    // Doji: Body takes up <= 10% of total range
    if (wick.bodyRatio <= 0.10) {
      return 'DOJI';
    }

    // Bullish Pinbar (Hammer / Dragonfly): Lower rejection wick >= 55% of range, upper wick <= 20%
    if (wick.lowerWickRatio >= 0.55 && wick.upperWickRatio <= 0.20) {
      return 'PINBAR_BULLISH';
    }

    // Bearish Shooting Star / Pinbar: Upper rejection wick >= 55% of range, lower wick <= 20%
    if (wick.upperWickRatio >= 0.55 && wick.lowerWickRatio <= 0.20) {
      return 'PINBAR_BEARISH';
    }

    // Engulfing patterns require a previous candle
    if (prevCandle) {
      const prevWick = this.analyzeCandleWicks(prevCandle);
      const prevBody = Math.abs(prevCandle.close - prevCandle.open);
      const currBody = Math.abs(candle.close - candle.open);

      // Bullish Engulfing: previous was bearish, current is bullish and completely engulfs previous body
      if (
        !prevWick.isBullish &&
        wick.isBullish &&
        candle.open <= prevCandle.close &&
        candle.close >= prevCandle.open &&
        currBody > prevBody
      ) {
        return 'ENGULFING_BULLISH';
      }

      // Bearish Engulfing: previous was bullish, current is bearish and completely engulfs previous body
      if (
        prevWick.isBullish &&
        !wick.isBullish &&
        candle.open >= prevCandle.close &&
        candle.close <= prevCandle.open &&
        currBody > prevBody
      ) {
        return 'ENGULFING_BEARISH';
      }
    }

    return 'NONE';
  }

  /**
   * Clusters recent swing highs and swing lows to detect Key Support and Resistance zones.
   */
  public static calculateSupportResistance(candles: Candle[], lookback: number = 25): SupportResistanceLevels {
    if (candles.length < 5) return { supports: [], resistances: [] };
    const slice = candles.slice(-Math.min(candles.length, lookback));

    const swingHighs: number[] = [];
    const swingLows: number[] = [];

    for (let i = 1; i < slice.length - 1; i++) {
      const c = slice[i];
      const prev = slice[i - 1];
      const next = slice[i + 1];

      // Swing High: peak higher than neighbor wicks
      if (c.high >= prev.high && c.high >= next.high) {
        swingHighs.push(c.high);
      }
      // Swing Low: trough lower than neighbor wicks
      if (c.low <= prev.low && c.low <= next.low) {
        swingLows.push(c.low);
      }
    }

    // Cluster levels that are within 0.05% of each other
    const cluster = (levels: number[]): number[] => {
      if (levels.length === 0) return [];
      const sorted = [...levels].sort((a, b) => a - b);
      const clustered: number[] = [];
      let currentCluster: number[] = [sorted[0]];

      for (let i = 1; i < sorted.length; i++) {
        const val = sorted[i];
        const avg = currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length;
        if (Math.abs(val - avg) / avg < 0.0008) {
          currentCluster.push(val);
        } else {
          clustered.push(currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length);
          currentCluster = [val];
        }
      }
      if (currentCluster.length > 0) {
        clustered.push(currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length);
      }
      return clustered;
    };

    return {
      supports: cluster(swingLows),
      resistances: cluster(swingHighs),
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
