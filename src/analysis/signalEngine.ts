import { Candle } from '../stream/types.js';
import { IndicatorSnapshot } from '../journal/types.js';
import { TechnicalIndicators } from './indicators.js';

export interface TradingSignal {
  asset: string;
  isOtc: boolean;
  direction: 'CALL' | 'PUT';
  timeframeSeconds: number; // 300 for 5M
  entryTime: number; // target candle open timestamp
  expiryTime: number; // target candle close timestamp
  confidence: number; // 0-100%
  payoutPercent: number;
  reasons: string[];
  marketRegime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY';
  indicatorSnapshot: IndicatorSnapshot;
}

export class SignalEngine {
  public minPayoutPercent: number = 80;
  public minConfidenceThreshold: number = 70;

  /**
   * Evaluates closed candles to determine if a high-probability 5M setup exists.
   */
  public evaluateSetup(
    asset: string,
    isOtc: boolean,
    candles: Candle[],
    payoutPercent: number,
    targetEntryTime: number
  ): TradingSignal | null {
    // Filter 1: Payout must meet threshold to maintain positive Expected Value
    if (payoutPercent < this.minPayoutPercent) {
      return null;
    }

    // Filter 2: Sufficient candle history for reliable indicators
    if (candles.length < 25) {
      return null;
    }

    const closes = candles.map((c) => c.close);
    const lastCandle = candles[candles.length - 1];

    // Compute indicators
    const emaFast = TechnicalIndicators.calculateEMA(closes, 9);
    const emaSlow = TechnicalIndicators.calculateEMA(closes, 21);
    const rsi = TechnicalIndicators.calculateRSI(closes, 14);
    const bb = TechnicalIndicators.calculateBollingerBands(closes, 20);
    const wick = TechnicalIndicators.analyzeCandleWicks(lastCandle);
    const regime = TechnicalIndicators.classifyRegime(candles);

    if (emaFast.length === 0 || emaSlow.length === 0 || rsi.length === 0 || !bb) {
      return null;
    }

    const currentEmaFast = emaFast[emaFast.length - 1];
    const currentEmaSlow = emaSlow[emaSlow.length - 1];
    const currentRsi = rsi[rsi.length - 1];
    const currentClose = closes[closes.length - 1];

    const indicatorSnapshot: IndicatorSnapshot = {
      emaFast: currentEmaFast,
      emaSlow: currentEmaSlow,
      rsi: currentRsi,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      bbMiddle: bb.middle,
      candleWickRatio: Math.max(wick.upperWickRatio, wick.lowerWickRatio),
    };

    // Evaluate CALL (GREEN / UP) Setup
    const callSignal = this.evaluateCallSetup(
      asset,
      isOtc,
      currentClose,
      currentEmaFast,
      currentEmaSlow,
      currentRsi,
      bb,
      wick,
      regime,
      payoutPercent,
      targetEntryTime,
      indicatorSnapshot
    );

    if (callSignal && callSignal.confidence >= this.minConfidenceThreshold) {
      return callSignal;
    }

    // Evaluate PUT (RED / DOWN) Setup
    const putSignal = this.evaluatePutSetup(
      asset,
      isOtc,
      currentClose,
      currentEmaFast,
      currentEmaSlow,
      currentRsi,
      bb,
      wick,
      regime,
      payoutPercent,
      targetEntryTime,
      indicatorSnapshot
    );

    if (putSignal && putSignal.confidence >= this.minConfidenceThreshold) {
      return putSignal;
    }

    return null;
  }

  private evaluateCallSetup(
    asset: string,
    isOtc: boolean,
    close: number,
    emaFast: number,
    emaSlow: number,
    rsi: number,
    bb: { upper: number; middle: number; lower: number },
    wick: { lowerWickRatio: number; upperWickRatio: number; isBullish: boolean },
    regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY',
    payout: number,
    entryTime: number,
    indicators: IndicatorSnapshot
  ): TradingSignal | null {
    let score = 50;
    const reasons: string[] = [];

    // Trend Confluence
    if (regime === 'TRENDING_UP' && emaFast > emaSlow) {
      score += 10;
      reasons.push('Trend alignment: M5 Uptrend (EMA 9 > EMA 21)');
    } else if (regime === 'RANGING') {
      score += 5;
      reasons.push('Range boundary: Market in consolidation');
    }

    // RSI Condition (Oversold bounce or momentum continuation)
    if (rsi <= 35) {
      score += 10;
      reasons.push(`RSI Oversold condition (${rsi.toFixed(1)} <= 35)`);
    } else if (regime === 'TRENDING_UP' && rsi >= 45 && rsi <= 60) {
      score += 5;
      reasons.push(`RSI healthy bullish momentum (${rsi.toFixed(1)})`);
    }

    // Bollinger Band Interaction
    if (close <= bb.lower * 1.0005) {
      score += 10;
      reasons.push('Price touching / piercing Lower Bollinger Band');
    }

    // Candle Rejection Wick (Strong buying wick at bottom)
    if (wick.lowerWickRatio >= 0.35) {
      score += 10;
      reasons.push(
        `Prominent lower rejection wick (${(wick.lowerWickRatio * 100).toFixed(0)}% of candle)`
      );
    }

    // High Payout bonus
    if (payout >= 85) {
      score += 5;
      reasons.push(`High payout tier (${payout.toFixed(0)}%)`);
    }

    if (score < this.minConfidenceThreshold) return null;

    return {
      asset,
      isOtc,
      direction: 'CALL',
      timeframeSeconds: 300,
      entryTime,
      expiryTime: entryTime + 300000,
      confidence: Math.min(score, 95),
      payoutPercent: payout,
      reasons,
      marketRegime: regime,
      indicatorSnapshot: indicators,
    };
  }

  private evaluatePutSetup(
    asset: string,
    isOtc: boolean,
    close: number,
    emaFast: number,
    emaSlow: number,
    rsi: number,
    bb: { upper: number; middle: number; lower: number },
    wick: { lowerWickRatio: number; upperWickRatio: number; isBullish: boolean },
    regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY',
    payout: number,
    entryTime: number,
    indicators: IndicatorSnapshot
  ): TradingSignal | null {
    let score = 50;
    const reasons: string[] = [];

    // Trend Confluence
    if (regime === 'TRENDING_DOWN' && emaFast < emaSlow) {
      score += 10;
      reasons.push('Trend alignment: M5 Downtrend (EMA 9 < EMA 21)');
    } else if (regime === 'RANGING') {
      score += 5;
      reasons.push('Range boundary: Market in consolidation');
    }

    // RSI Condition (Overbought drop or momentum continuation)
    if (rsi >= 65) {
      score += 10;
      reasons.push(`RSI Overbought condition (${rsi.toFixed(1)} >= 65)`);
    } else if (regime === 'TRENDING_DOWN' && rsi >= 40 && rsi <= 55) {
      score += 5;
      reasons.push(`RSI healthy bearish momentum (${rsi.toFixed(1)})`);
    }

    // Bollinger Band Interaction
    if (close >= bb.upper * 0.9995) {
      score += 10;
      reasons.push('Price touching / piercing Upper Bollinger Band');
    }

    // Candle Rejection Wick (Strong selling wick at top)
    if (wick.upperWickRatio >= 0.35) {
      score += 10;
      reasons.push(
        `Prominent upper rejection wick (${(wick.upperWickRatio * 100).toFixed(0)}% of candle)`
      );
    }

    // High Payout bonus
    if (payout >= 85) {
      score += 5;
      reasons.push(`High payout tier (${payout.toFixed(0)}%)`);
    }

    if (score < this.minConfidenceThreshold) return null;

    return {
      asset,
      isOtc,
      direction: 'PUT',
      timeframeSeconds: 300,
      entryTime,
      expiryTime: entryTime + 300000,
      confidence: Math.min(score, 95),
      payoutPercent: payout,
      reasons,
      marketRegime: regime,
      indicatorSnapshot: indicators,
    };
  }
}
