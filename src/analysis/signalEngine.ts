import { Candle } from '../stream/types.js';
import { IndicatorSnapshot } from '../journal/types.js';
import { TechnicalIndicators } from './indicators.js';

export interface TradingSignal {
  asset: string;
  isOtc: boolean;
  direction: 'CALL' | 'PUT'; // CALL = price higher at expiry, PUT = price lower at expiry
  timeframeSeconds: number; // 300 for 5M
  expiryMinutes: number; // how long the trade should run
  entryTime: number; // target candle open timestamp
  expiryTime: number; // target candle close timestamp
  confidence: number; // setup score 0-100 (a rule score, NOT a win probability)
  payoutPercent: number;
  reasons: string[];
  marketRegime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY';
  indicatorSnapshot: IndicatorSnapshot;
}

/**
 * Strategy: EMA trend + RSI momentum + Stochastic timing, on closed 5-minute candles.
 *
 * CALL (price UP for the next 5 minutes) needs ALL THREE:
 *   1. TREND     EMA 9 is above EMA 21 (uptrend)
 *   2. MOMENTUM  RSI(14) is between 40 and 70 and rising (healthy, not overbought)
 *   3. TIMING    Stochastic %K crosses UP through %D while %K is still low (< 40):
 *                the pullback inside the uptrend has ended
 * PUT is the exact mirror (EMA 9 < EMA 21, RSI 30-60 and falling, %K crosses DOWN through %D
 * while %K is high, > 60).
 *
 * This is a classic "buy the dip in an uptrend" rule set. It follows the rules exactly and
 * will say when they line up. It cannot know the future: whether the rules beat the broker's
 * payout margin is something only your own results can show.
 */
export class SignalEngine {
  public minPayoutPercent: number = process.env.MIN_PAYOUT_PERCENT ? Number(process.env.MIN_PAYOUT_PERCENT) : 75;
  /** All three core rules together score 60, so 60 means "the full set lined up". */
  public minConfidenceThreshold: number = 60;
  public timeframeSeconds: number = 300;

  public evaluateSetup(
    asset: string,
    isOtc: boolean,
    candles: Candle[],
    payoutPercent: number,
    targetEntryTime: number,
    timeframeSeconds: number = 300
  ): TradingSignal | null {
    // Payout filter: a low payout makes break-even harder to reach
    if (payoutPercent < this.minPayoutPercent) return null;

    // Need at least 8 closed candles to start computing reliable indicators
    if (candles.length < 8) return null;

    const tf = timeframeSeconds || this.timeframeSeconds;
    const closes = candles.map((c) => c.close);
    const emaFastArr = TechnicalIndicators.calculateEMA(closes, 9);
    const emaSlowArr = TechnicalIndicators.calculateEMA(closes, 21);
    const rsiArr = TechnicalIndicators.calculateRSI(closes, 14);
    const stoch = TechnicalIndicators.calculateStochastic(candles, 14, 3, 3);

    if (emaFastArr.length < 2 || emaSlowArr.length < 1 || rsiArr.length < 2 || stoch.k.length < 2 || stoch.d.length < 2) {
      return null;
    }

    const last = (arr: number[], back = 0) => arr[arr.length - 1 - back];
    const emaFast = last(emaFastArr);
    const emaSlow = last(emaSlowArr);
    const rsi = last(rsiArr);
    const rsiPrev = last(rsiArr, 1);
    const k = last(stoch.k);
    const kPrev = last(stoch.k, 1);
    const d = last(stoch.d);
    const dPrev = last(stoch.d, 1);

    // Trend strength: is the gap between the EMAs widening compared with 3 candles ago?
    const slowAt = (back: number) => emaSlowArr[emaSlowArr.length - 1 - back];
    const gapNow = Math.abs(emaFast - emaSlow);
    const gapBefore = Math.abs(last(emaFastArr, 3) - slowAt(3));
    const gapWidening = slowAt(3) !== undefined && gapNow > gapBefore;

    const bb = TechnicalIndicators.calculateBollingerBands(closes, 20);
    const lastCandle = candles[candles.length - 1];
    const wick = TechnicalIndicators.analyzeCandleWicks(lastCandle);
    const regime = TechnicalIndicators.classifyRegime(candles);

    // Recorded in the journal for reference only; they play no part in the decision.
    const indicatorSnapshot: IndicatorSnapshot = {
      emaFast,
      emaSlow,
      rsi,
      bbUpper: bb?.upper ?? 0,
      bbLower: bb?.lower ?? 0,
      bbMiddle: bb?.middle ?? 0,
      candleWickRatio: Math.max(wick.upperWickRatio, wick.lowerWickRatio),
    };

    const crossedUp = kPrev <= dPrev && k > d;
    const crossedDown = kPrev >= dPrev && k < d;

    // ---------- CALL ----------
    if (emaFast > emaSlow && rsi >= 40 && rsi <= 70 && rsi > rsiPrev && crossedUp && Math.min(k, kPrev) < 40) {
      let score = 60;
      const reasons = [
        `TREND: EMA 9 (${emaFast.toFixed(5)}) above EMA 21 (${emaSlow.toFixed(5)}) = uptrend`,
        `MOMENTUM: RSI ${rsi.toFixed(1)}, rising from ${rsiPrev.toFixed(1)} (zone 40-70)`,
        `TIMING: Stochastic %K ${k.toFixed(1)} crossed UP through %D ${d.toFixed(1)} from a low zone`,
      ];
      if (Math.min(k, kPrev) < 20) {
        score += 10;
        reasons.push('Bonus: Stochastic turned up from deeply oversold (< 20)');
      }
      if (rsi >= 45 && rsi <= 60) {
        score += 10;
        reasons.push('Bonus: RSI in the middle of its healthy zone (45-60)');
      }
      if (gapWidening) {
        score += 10;
        reasons.push('Bonus: gap between EMA 9 and EMA 21 is widening (trend strengthening)');
      }
      if (payoutPercent >= 85) {
        score += 5;
        reasons.push(`Bonus: high payout (${payoutPercent.toFixed(0)}%)`);
      }
      return this.build('CALL', asset, isOtc, targetEntryTime, tf, score, payoutPercent, reasons, regime, indicatorSnapshot);
    }

    // ---------- PUT ----------
    if (emaFast < emaSlow && rsi <= 60 && rsi >= 30 && rsi < rsiPrev && crossedDown && Math.max(k, kPrev) > 60) {
      let score = 60;
      const reasons = [
        `TREND: EMA 9 (${emaFast.toFixed(5)}) below EMA 21 (${emaSlow.toFixed(5)}) = downtrend`,
        `MOMENTUM: RSI ${rsi.toFixed(1)}, falling from ${rsiPrev.toFixed(1)} (zone 30-60)`,
        `TIMING: Stochastic %K ${k.toFixed(1)} crossed DOWN through %D ${d.toFixed(1)} from a high zone`,
      ];
      if (Math.max(k, kPrev) > 80) {
        score += 10;
        reasons.push('Bonus: Stochastic turned down from deeply overbought (> 80)');
      }
      if (rsi >= 40 && rsi <= 55) {
        score += 10;
        reasons.push('Bonus: RSI in the middle of its healthy zone (40-55)');
      }
      if (gapWidening) {
        score += 10;
        reasons.push('Bonus: gap between EMA 9 and EMA 21 is widening (trend strengthening)');
      }
      if (payoutPercent >= 85) {
        score += 5;
        reasons.push(`Bonus: high payout (${payoutPercent.toFixed(0)}%)`);
      }
      return this.build('PUT', asset, isOtc, targetEntryTime, tf, score, payoutPercent, reasons, regime, indicatorSnapshot);
    }

    return null;
  }

  private build(
    direction: 'CALL' | 'PUT',
    asset: string,
    isOtc: boolean,
    entryTime: number,
    timeframeSeconds: number,
    score: number,
    payoutPercent: number,
    reasons: string[],
    regime: TradingSignal['marketRegime'],
    indicatorSnapshot: IndicatorSnapshot
  ): TradingSignal | null {
    if (score < this.minConfidenceThreshold) return null;
    return {
      asset,
      isOtc,
      direction,
      timeframeSeconds,
      expiryMinutes: timeframeSeconds / 60,
      entryTime,
      expiryTime: entryTime + timeframeSeconds * 1000,
      confidence: Math.min(score, 95),
      payoutPercent,
      reasons,
      marketRegime: regime,
      indicatorSnapshot,
    };
  }
}
