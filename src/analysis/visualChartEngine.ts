import { Page } from 'playwright';
import { Candle } from '../stream/types.js';
import { TechnicalIndicators } from './indicators.js';

export interface VisualCandle {
  index: number;
  x: number;
  polarity: 'BULLISH' | 'BEARISH' | 'DOJI';
  topY: number;
  bottomY: number;
  bodyTopY: number;
  bodyBottomY: number;
  bodyHeight: number;
  totalRange: number;
  upperWick: number;
  lowerWick: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  bodyRatio: number;
  pattern: 'BULLISH_PINBAR' | 'BEARISH_SHOOTING_STAR' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | 'DOJI' | 'NEUTRAL';
}

export interface VisualChartAnalysis {
  timestamp: number;
  canvasFound: boolean;
  dimensions: { width: number; height: number };
  candles: VisualCandle[];
  trendSlope: number; // Normalized slope per candle (positive = uptrend, negative = downtrend)
  trendDirection: 'UPTREND' | 'DOWNTREND' | 'RANGING';
  supportLevels: number[];
  resistanceLevels: number[];
  visualBias: 'CALL' | 'PUT' | 'NEUTRAL';
  confluenceScore: number; // 0-100 score indicating structural clarity
  reasons: string[];
}

/**
 * Deterministic OHLC Chart Structure Engine.
 * Replaces fragile browser WebGL pixel-scraping with zero-latency mathematical
 * price-action analysis (linear regression slope, S/R clustering, and wick/engulfing patterns)
 * computed directly from the true numerical OHLC candle series.
 */
export class VisualChartEngine {
  private lastAnalysis: VisualChartAnalysis | null = null;

  public analyzeCandles(rawCandles: Candle[]): VisualChartAnalysis {
    const timestamp = Date.now();
    if (!rawCandles || rawCandles.length < 4) {
      return this.fallbackAnalysis(timestamp, 'Insufficient candle history for structure analysis');
    }

    const slice = rawCandles.slice(-40);
    const candles: VisualCandle[] = [];

    for (let i = 0; i < slice.length; i++) {
      const c = slice[i];
      const prev = i > 0 ? slice[i - 1] : undefined;
      const wick = TechnicalIndicators.analyzeCandleWicks(c);
      const rawPat = TechnicalIndicators.detectPattern(c, prev);

      const polarity: VisualCandle['polarity'] =
        rawPat === 'DOJI' ? 'DOJI' : c.close >= c.open ? 'BULLISH' : 'BEARISH';

      let pattern: VisualCandle['pattern'] = 'NEUTRAL';
      if (rawPat === 'DOJI') pattern = 'DOJI';
      else if (rawPat === 'PINBAR_BULLISH') pattern = 'BULLISH_PINBAR';
      else if (rawPat === 'PINBAR_BEARISH') pattern = 'BEARISH_SHOOTING_STAR';
      else if (rawPat === 'ENGULFING_BULLISH') pattern = 'BULLISH_ENGULFING';
      else if (rawPat === 'ENGULFING_BEARISH') pattern = 'BEARISH_ENGULFING';

      const bodyTop = Math.max(c.open, c.close);
      const bodyBottom = Math.min(c.open, c.close);
      const bodyHeight = bodyTop - bodyBottom;

      candles.push({
        index: i,
        x: i,
        polarity,
        topY: c.high,
        bottomY: c.low,
        bodyTopY: bodyTop,
        bodyBottomY: bodyBottom,
        bodyHeight,
        totalRange: wick.totalRange,
        upperWick: c.high - bodyTop,
        lowerWick: bodyBottom - c.low,
        upperWickRatio: wick.upperWickRatio,
        lowerWickRatio: wick.lowerWickRatio,
        bodyRatio: wick.bodyRatio,
        pattern,
      });
    }

    // Normalized linear regression slope over the last 15 candles (in ATR units per candle)
    const regSlice = slice.slice(-15);
    const atrArr = TechnicalIndicators.calculateATR(slice, 14);
    const atr = Math.max(1e-9, atrArr.at(-1) ?? (regSlice[0].high - regSlice[0].low || 1e-4));

    const n = regSlice.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
      const mid = (regSlice[i].open + regSlice[i].close) / 2;
      sumX += i;
      sumY += mid;
      sumXY += i * mid;
      sumXX += i * i;
    }
    const rawSlope = (n * sumXY - sumX * sumY) / Math.max(1, n * sumXX - sumX * sumX);
    const trendSlope = rawSlope / atr; // ATR-normalized slope per bar

    let trendDirection: VisualChartAnalysis['trendDirection'] = 'RANGING';
    if (trendSlope > 0.15) trendDirection = 'UPTREND';
    else if (trendSlope < -0.15) trendDirection = 'DOWNTREND';

    const sr = TechnicalIndicators.calculateSupportResistance(slice, 25);

    const reasons: string[] = [];
    let visualBias: VisualChartAnalysis['visualBias'] = 'NEUTRAL';
    let confluenceScore = 50;

    const lastCandle = candles[candles.length - 1];
    if (trendDirection === 'UPTREND') {
      reasons.push(`Price structure trending upward (+${trendSlope.toFixed(2)} ATR/bar)`);
      confluenceScore += 15;
    } else if (trendDirection === 'DOWNTREND') {
      reasons.push(`Price structure trending downward (${trendSlope.toFixed(2)} ATR/bar)`);
      confluenceScore += 15;
    } else {
      reasons.push('Price structure is ranging / consolidating');
    }

    if (lastCandle.pattern === 'BULLISH_PINBAR') {
      reasons.push(`Bullish Pinbar with ${Math.round(lastCandle.lowerWickRatio * 100)}% lower rejection wick`);
      visualBias = 'CALL';
      confluenceScore += 25;
    } else if (lastCandle.pattern === 'BEARISH_SHOOTING_STAR') {
      reasons.push(`Bearish Shooting Star with ${Math.round(lastCandle.upperWickRatio * 100)}% upper rejection wick`);
      visualBias = 'PUT';
      confluenceScore += 25;
    } else if (lastCandle.pattern === 'BULLISH_ENGULFING') {
      reasons.push('Bullish Engulfing candlestick pattern confirmed');
      visualBias = 'CALL';
      confluenceScore += 20;
    } else if (lastCandle.pattern === 'BEARISH_ENGULFING') {
      reasons.push('Bearish Engulfing candlestick pattern confirmed');
      visualBias = 'PUT';
      confluenceScore += 20;
    } else if (trendDirection === 'UPTREND' && lastCandle.polarity === 'BULLISH') {
      visualBias = 'CALL';
      confluenceScore += 10;
    } else if (trendDirection === 'DOWNTREND' && lastCandle.polarity === 'BEARISH') {
      visualBias = 'PUT';
      confluenceScore += 10;
    }

    const analysis: VisualChartAnalysis = {
      timestamp,
      canvasFound: true,
      dimensions: { width: 1280, height: 720 },
      candles,
      trendSlope,
      trendDirection,
      supportLevels: sr.supports,
      resistanceLevels: sr.resistances,
      visualBias,
      confluenceScore: Math.min(100, Math.max(0, confluenceScore)),
      reasons,
    };

    this.lastAnalysis = analysis;
    return analysis;
  }

  /**
   * Computes structure analysis from candles if provided, or falls back to cached analysis.
   * Zero DOM/Canvas pixel-scraping latency.
   */
  public async analyzeChart(_page?: Page, candles?: Candle[]): Promise<VisualChartAnalysis> {
    if (candles && candles.length >= 4) {
      return this.analyzeCandles(candles);
    }
    if (this.lastAnalysis) {
      return this.lastAnalysis;
    }
    return this.fallbackAnalysis(Date.now(), 'Waiting for candle series');
  }

  public getLastAnalysis(): VisualChartAnalysis | null {
    return this.lastAnalysis;
  }

  private fallbackAnalysis(timestamp: number, reason: string): VisualChartAnalysis {
    return {
      timestamp,
      canvasFound: false,
      dimensions: { width: 0, height: 0 },
      candles: [],
      trendSlope: 0,
      trendDirection: 'RANGING',
      supportLevels: [],
      resistanceLevels: [],
      visualBias: 'NEUTRAL',
      confluenceScore: 0,
      reasons: [reason],
    };
  }
}
