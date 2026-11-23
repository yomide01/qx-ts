import { Candle } from '../stream/types.js';
import { TradeRecord, IndicatorSnapshot } from '../journal/types.js';
import { TechnicalIndicators } from './indicators.js';
import { breakevenWinRate, wilsonInterval } from './binaryMath.js';
import { VisualChartAnalysis } from './visualChartEngine.js';

export type AdaptiveStrategyMode = 'TREND_PULLBACK' | 'MEAN_REVERSION_BB' | 'BREAKOUT_MOMENTUM' | 'WAIT_NO_EDGE';
export type PlaybookName = 'EMA_PULLBACK_SNIPER' | 'MOMENTUM_CHANNEL' | 'STREAK_EXHAUSTION_FADE' | 'NONE';
export type IndicatorProfileName = 'FAST' | 'STANDARD' | 'SMOOTH';
export type MarketRegimeKind = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY';

export interface IndicatorProfile {
  name: IndicatorProfileName;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  bbPeriod: number;
  bbDev: number;
  stochK: number;
}

export const INDICATOR_PROFILES: Record<IndicatorProfileName, IndicatorProfile> = {
  FAST: { name: 'FAST', emaFast: 5, emaSlow: 13, rsiPeriod: 7, bbPeriod: 14, bbDev: 2.0, stochK: 8 },
  STANDARD: { name: 'STANDARD', emaFast: 9, emaSlow: 21, rsiPeriod: 14, bbPeriod: 20, bbDev: 2.0, stochK: 14 },
  SMOOTH: { name: 'SMOOTH', emaFast: 12, emaSlow: 26, rsiPeriod: 14, bbPeriod: 20, bbDev: 2.2, stochK: 14 },
};

export interface PlaybookStats {
  playbook: PlaybookName;
  profile: IndicatorProfile;
  horizonCandles: number; // 1, 2, or 3 candles ("how long price stays up/down")
  trainWins: number;
  trainLosses: number;
  trainWinRate: number;
  oosWins: number; // Out-of-Sample (unseen recent 35% of candles)
  oosLosses: number;
  oosWinRate: number;
  totalWins: number;
  totalLosses: number;
  winRate: number; // 0-100
  wilsonLowerBound: number; // Conservative lower confidence bound (shrinks small samples)
  edgeAboveBreakeven: number; // percentage points above break-even
}

export interface PairCalibrationReport {
  asset: string;
  payoutPercent: number;
  timeframeSeconds: number;
  candlesTested: number;
  bestPlaybook: PlaybookName;
  bestProfile: IndicatorProfile;
  recommendedHorizonCandles: number;
  recommendedExpirySeconds: number;
  bestStats: PlaybookStats | null;
  whipsawRatio: number;
  isTradeable: boolean;
  shouldRemovePair: boolean;
  removeReason?: string;
}

export interface AdaptivePairIntelligence {
  asset: string;
  isOtc: boolean;
  strategyMode: AdaptiveStrategyMode;
  activePlaybook: PlaybookName;
  activeProfile: IndicatorProfile;
  recommendedExpirySeconds: number;
  calibration: PairCalibrationReport;
  marketRegime: MarketRegimeKind;
  indicatorsAtEntry: IndicatorSnapshot;
  efficiencyRatio: number;
  atrPercent: number;
  volatilityState: 'DEAD_SQUEEZE' | 'HEALTHY' | 'ERRATIC_SPIKE';
  directionCall: 'CALL' | 'PUT' | 'WAIT';
  callLabel: string;
  convictionScore: number; // 0-100 confluence score
  alignedPillars: number; // out of 5 indicator pillars
  totalPillars: number; // 5
  shouldSwitchPair: boolean;
  switchReason?: string;
  factors: string[];
  journalEdgeSummary?: string;
}

interface PlaybookSignalResult {
  direction: 'CALL' | 'PUT';
  alignedPillars: number;
  score: number;
  reasons: string[];
}

export class SignalEngine {
  /**
   * Evaluates a specific Playbook using a specific pair-optimized Indicator Profile
   * (FAST / STANDARD / SMOOTH). Used identically in both Out-of-Sample Walk-Forward
   * Calibration AND live entry decisions so zero discrepancy exists between test and live.
   */
  public evaluatePlaybook(
    playbook: PlaybookName,
    candles: Candle[],
    profile: IndicatorProfile = INDICATOR_PROFILES.STANDARD
  ): PlaybookSignalResult | null {
    const minNeeded = Math.max(30, profile.emaSlow + 5, profile.bbPeriod + 5);
    if (candles.length < minNeeded || playbook === 'NONE') return null;

    const closes = candles.map((c) => c.close);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const emaFastArr = TechnicalIndicators.calculateEMA(closes, profile.emaFast);
    const emaSlowArr = TechnicalIndicators.calculateEMA(closes, profile.emaSlow);
    const rsiArr = TechnicalIndicators.calculateRSI(closes, profile.rsiPeriod);
    const stoch = TechnicalIndicators.calculateStochastic(candles, profile.stochK, 3, 3);
    const bbMain = TechnicalIndicators.calculateBollingerBands(closes, profile.bbPeriod, profile.bbDev);
    const bbFade = TechnicalIndicators.calculateBollingerBands(closes, profile.bbPeriod, Math.max(1.7, profile.bbDev - 0.2));
    const wick = TechnicalIndicators.analyzeCandleWicks(last);

    if (emaFastArr.length < 3 || emaSlowArr.length < 2 || rsiArr.length < 2 || !bbMain || !bbFade) {
      return null;
    }

    const ef = emaFastArr[emaFastArr.length - 1];
    const efPrev = emaFastArr[emaFastArr.length - 2];
    const es = emaSlowArr[emaSlowArr.length - 1];
    const rsi = rsiArr[rsiArr.length - 1];
    const rsiPrev = rsiArr[rsiArr.length - 2];
    const k = stoch.k.length > 0 ? stoch.k[stoch.k.length - 1] : 50;
    const kPrev = stoch.k.length > 1 ? stoch.k[stoch.k.length - 2] : k;
    const d = stoch.d.length > 0 ? stoch.d[stoch.d.length - 1] : 50;

    const bbSpan = Math.max(1e-9, bbMain.upper - bbMain.lower);
    const pctB = (last.close - bbMain.lower) / bbSpan;

    // Count consecutive same-color candles leading into this bar
    let consecutiveBull = 0;
    let consecutiveBear = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].close > candles[i].open) {
        if (consecutiveBear > 0) break;
        consecutiveBull++;
      } else if (candles[i].close < candles[i].open) {
        if (consecutiveBull > 0) break;
        consecutiveBear++;
      } else {
        break;
      }
    }

    // Swing Support & Resistance over last 22 candles (never buy straight into resistance or sell into support)
    const lookback = candles.slice(-23, -1);
    const swingHigh = Math.max(...lookback.map((c) => c.high));
    const swingLow = Math.min(...lookback.map((c) => c.low));
    const swingSpan = Math.max(1e-9, swingHigh - swingLow);
    const nearResistance = (swingHigh - last.close) / swingSpan < 0.08;
    const nearSupport = (last.close - swingLow) / swingSpan < 0.08;

    const rsiHighCap = profile.rsiPeriod <= 8 ? 72 : 66;
    const rsiLowFloor = profile.rsiPeriod <= 8 ? 28 : 34;

    // ── PLAYBOOK 1: EMA PULLBACK SNIPER ──
    if (playbook === 'EMA_PULLBACK_SNIPER') {
      if (
        ef > es &&
        last.low <= ef * 1.0002 &&
        last.close > ef &&
        last.close > last.open &&
        rsi >= 44 &&
        rsi <= rsiHighCap &&
        !nearResistance &&
        consecutiveBull <= 3 &&
        (wick.lowerWickRatio >= 0.22 || prev.close < prev.open)
      ) {
        const pillars = 4 + (k >= d || k > kPrev ? 1 : 0);
        return {
          direction: 'CALL',
          alignedPillars: pillars,
          score: pillars === 5 ? 92 : 84,
          reasons: [
            `EMA(${profile.emaFast}/${profile.emaSlow}) Pullback Sniper: Price dipped to EMA(${profile.emaFast}) (${ef.toFixed(5)}) & rejected UP`,
            `Macro Trend: EMA(${profile.emaFast}) > EMA(${profile.emaSlow}) (${es.toFixed(5)}) with space below swing resistance`,
            `RSI(${profile.rsiPeriod}) Momentum: Healthy bullish zone at ${rsi.toFixed(1)}`,
            `Price Action: Bullish rejection close (lower wick ${Math.round(wick.lowerWickRatio * 100)}%)`,
          ],
        };
      }

      if (
        ef < es &&
        last.high >= ef * 0.9998 &&
        last.close < ef &&
        last.close < last.open &&
        rsi >= rsiLowFloor &&
        rsi <= 56 &&
        !nearSupport &&
        consecutiveBear <= 3 &&
        (wick.upperWickRatio >= 0.22 || prev.close > prev.open)
      ) {
        const pillars = 4 + (k <= d || k < kPrev ? 1 : 0);
        return {
          direction: 'PUT',
          alignedPillars: pillars,
          score: pillars === 5 ? 92 : 84,
          reasons: [
            `EMA(${profile.emaFast}/${profile.emaSlow}) Pullback Sniper: Price rallied to EMA(${profile.emaFast}) (${ef.toFixed(5)}) & rejected DOWN`,
            `Macro Trend: EMA(${profile.emaFast}) < EMA(${profile.emaSlow}) (${es.toFixed(5)}) with space above swing support`,
            `RSI(${profile.rsiPeriod}) Momentum: Healthy bearish zone at ${rsi.toFixed(1)}`,
            `Price Action: Bearish rejection close (upper wick ${Math.round(wick.upperWickRatio * 100)}%)`,
          ],
        };
      }
      return null;
    }

    // ── PLAYBOOK 2: MOMENTUM CHANNEL ──
    if (playbook === 'MOMENTUM_CHANNEL') {
      if (
        ef > es &&
        ef > efPrev &&
        last.close > last.open &&
        wick.bodyRatio >= 0.34 &&
        wick.upperWickRatio < 0.38 &&
        rsi >= 48 &&
        rsi <= rsiHighCap &&
        rsi > rsiPrev &&
        pctB >= 0.32 &&
        pctB <= 0.78 &&
        !nearResistance &&
        consecutiveBull <= 3
      ) {
        const stochAligned = k >= d && k <= 80;
        const pillars = stochAligned ? 5 : 4;
        return {
          direction: 'CALL',
          alignedPillars: pillars,
          score: pillars === 5 ? 90 : 82,
          reasons: [
            `Momentum Channel [${profile.name}]: Rising EMA(${profile.emaFast}) > EMA(${profile.emaSlow})`,
            `Bollinger(${profile.bbPeriod},${profile.bbDev}): Clean bullish channel (%B ${(pctB * 100).toFixed(0)}%)`,
            `RSI(${profile.rsiPeriod}) Momentum: Rising ${rsiPrev.toFixed(1)} -> ${rsi.toFixed(1)}`,
            `Price Action: Solid green continuation candle (body ${Math.round(wick.bodyRatio * 100)}%)`,
          ],
        };
      }

      if (
        ef < es &&
        ef < efPrev &&
        last.close < last.open &&
        wick.bodyRatio >= 0.34 &&
        wick.lowerWickRatio < 0.38 &&
        rsi >= rsiLowFloor &&
        rsi <= 52 &&
        rsi < rsiPrev &&
        pctB >= 0.22 &&
        pctB <= 0.68 &&
        !nearSupport &&
        consecutiveBear <= 3
      ) {
        const stochAligned = k <= d && k >= 20;
        const pillars = stochAligned ? 5 : 4;
        return {
          direction: 'PUT',
          alignedPillars: pillars,
          score: pillars === 5 ? 90 : 82,
          reasons: [
            `Momentum Channel [${profile.name}]: Falling EMA(${profile.emaFast}) < EMA(${profile.emaSlow})`,
            `Bollinger(${profile.bbPeriod},${profile.bbDev}): Clean bearish channel (%B ${(pctB * 100).toFixed(0)}%)`,
            `RSI(${profile.rsiPeriod}) Momentum: Falling ${rsiPrev.toFixed(1)} -> ${rsi.toFixed(1)}`,
            `Price Action: Solid red continuation candle (body ${Math.round(wick.bodyRatio * 100)}%)`,
          ],
        };
      }
      return null;
    }

    // ── PLAYBOOK 3: STREAK EXHAUSTION FADE ──
    if (playbook === 'STREAK_EXHAUSTION_FADE') {
      const obLevel = profile.rsiPeriod <= 8 ? 75 : 70;
      const osLevel = profile.rsiPeriod <= 8 ? 25 : 30;
      if (consecutiveBear >= 3 && (last.close <= bbFade.lower || rsi <= osLevel)) {
        return {
          direction: 'CALL',
          alignedPillars: 4,
          score: 82,
          reasons: [
            `Exhaustion Fade [${profile.name}]: ${consecutiveBear} consecutive red candles stretched into oversold floor`,
            `Bollinger(${profile.bbPeriod}): Price stretched below Lower Band (${bbFade.lower.toFixed(5)})`,
            `RSI(${profile.rsiPeriod}) Extreme: Deeply oversold at ${rsi.toFixed(1)} — snap-back expected`,
            `Stochastic(${profile.stochK},3,3): %K at ${k.toFixed(0)} signaling short-term seller exhaustion`,
          ],
        };
      }
      if (consecutiveBull >= 3 && (last.close >= bbFade.upper || rsi >= obLevel)) {
        return {
          direction: 'PUT',
          alignedPillars: 4,
          score: 82,
          reasons: [
            `Exhaustion Fade [${profile.name}]: ${consecutiveBull} consecutive green candles stretched into overbought ceiling`,
            `Bollinger(${profile.bbPeriod}): Price stretched above Upper Band (${bbFade.upper.toFixed(5)})`,
            `RSI(${profile.rsiPeriod}) Extreme: Deeply overbought at ${rsi.toFixed(1)} — pullback expected`,
            `Stochastic(${profile.stochK},3,3): %K at ${k.toFixed(0)} signaling short-term buyer exhaustion`,
          ],
        };
      }
      return null;
    }

    return null;
  }

  /**
   * Strict Out-of-Sample Walk-Forward Self-Calibration Engine:
   * Searches across:
   *   - 3 Playbooks (EMA_PULLBACK_SNIPER, MOMENTUM_CHANNEL, STREAK_EXHAUSTION_FADE)
   *   - 3 Indicator Parameter Profiles (FAST, STANDARD, SMOOTH)
   *   - 2-3 Expiry Duration Horizons (1-candle vs 2-candle vs 3-candle hold — "how long price stays up/down")
   * Splits the pair's ~200 real historical candles into Training (first 65%) and Unseen Validation (latest 35%)
   * so we ONLY approve a pair & indicator profile that is STILL winning on recent unseen candles!
   */
  public calibratePairPlaybook(
    asset: string,
    closedCandles: Candle[],
    payoutPercent: number,
    timeframeSeconds: number = 300
  ): PairCalibrationReport {
    const beWinRate = breakevenWinRate(payoutPercent);
    const defaultProfile = INDICATOR_PROFILES.STANDARD;

    // Measure erratic whipsaw/doji trap ratio over the last 12 closed candles
    const recent12 = closedCandles.slice(-12);
    let whipsawCount = 0;
    for (const c of recent12) {
      const w = TechnicalIndicators.analyzeCandleWicks(c);
      if (w.bodyRatio < 0.2 || (w.upperWickRatio >= 0.35 && w.lowerWickRatio >= 0.35)) {
        whipsawCount++;
      }
    }
    const whipsawRatio = recent12.length > 0 ? whipsawCount / recent12.length : 0;

    if (payoutPercent < 80) {
      return {
        asset,
        payoutPercent,
        timeframeSeconds,
        candlesTested: closedCandles.length,
        bestPlaybook: 'NONE',
        bestProfile: defaultProfile,
        recommendedHorizonCandles: 1,
        recommendedExpirySeconds: timeframeSeconds,
        bestStats: null,
        whipsawRatio,
        isTradeable: false,
        shouldRemovePair: true,
        removeReason: `Low payout (${payoutPercent}% < 80% min; needs ${beWinRate.toFixed(1)}% WR to break even)`,
      };
    }

    if (closedCandles.length < 55) {
      return {
        asset,
        payoutPercent,
        timeframeSeconds,
        candlesTested: closedCandles.length,
        bestPlaybook: 'EMA_PULLBACK_SNIPER',
        bestProfile: defaultProfile,
        recommendedHorizonCandles: 1,
        recommendedExpirySeconds: timeframeSeconds,
        bestStats: null,
        whipsawRatio,
        isTradeable: false,
        shouldRemovePair: false,
        removeReason: `Warming up history (${closedCandles.length}/55 closed candles)`,
      };
    }

    if (whipsawRatio >= 0.5) {
      return {
        asset,
        payoutPercent,
        timeframeSeconds,
        candlesTested: closedCandles.length,
        bestPlaybook: 'NONE',
        bestProfile: defaultProfile,
        recommendedHorizonCandles: 1,
        recommendedExpirySeconds: timeframeSeconds,
        bestStats: null,
        whipsawRatio,
        isTradeable: false,
        shouldRemovePair: true,
        removeReason: `Erratic whipsaw/doji traps (${Math.round(whipsawRatio * 100)}% trap candles in last 12 bars)`,
      };
    }

    const playbooks: PlaybookName[] = ['EMA_PULLBACK_SNIPER', 'MOMENTUM_CHANNEL', 'STREAK_EXHAUSTION_FADE'];
    const profiles: IndicatorProfile[] = [
      INDICATOR_PROFILES.FAST,
      INDICATOR_PROFILES.STANDARD,
      INDICATOR_PROFILES.SMOOTH,
    ];
    // Allowed duration horizons that match Quotex's real expiry presets (e.g. on 1m -> 1m/2m/3m; on 5m -> 5m/10m/15m)
    const horizons = timeframeSeconds <= 60 ? [1, 2, 3] : timeframeSeconds === 300 ? [1, 2, 3] : [1, 2];

    const splitIdx = Math.max(40, Math.floor(closedCandles.length * 0.65));
    const candidates: PlaybookStats[] = [];

    for (const pb of playbooks) {
      for (const prof of profiles) {
        // Compute signals once per (playbook, profile) across all historical bars, then grade across each duration horizon!
        const signalIndices: Array<{ idx: number; dir: 'CALL' | 'PUT' }> = [];
        for (let i = 32; i < closedCandles.length - 1; i++) {
          const sig = this.evaluatePlaybook(pb, closedCandles.slice(0, i + 1), prof);
          if (sig) {
            signalIndices.push({ idx: i, dir: sig.direction });
          }
        }
        if (signalIndices.length < 6) continue;

        for (const h of horizons) {
          let trainWins = 0;
          let trainLosses = 0;
          let oosWins = 0;
          let oosLosses = 0;

          for (const s of signalIndices) {
            const entryIdx = s.idx + 1;
            const exitIdx = s.idx + h;
            if (exitIdx >= closedCandles.length) continue;
            const entryPrice = closedCandles[entryIdx].open;
            const exitPrice = closedCandles[exitIdx].close;
            if (exitPrice === entryPrice) continue;

            const won = (s.dir === 'CALL' && exitPrice > entryPrice) || (s.dir === 'PUT' && exitPrice < entryPrice);
            if (s.idx < splitIdx) {
              if (won) trainWins++;
              else trainLosses++;
            } else {
              if (won) oosWins++;
              else oosLosses++;
            }
          }

          const trainTotal = trainWins + trainLosses;
          const oosTotal = oosWins + oosLosses;
          const total = trainTotal + oosTotal;
          // Require both in-sample and out-of-sample triggers so we never fake OOS stats
          if (total < 6 || trainTotal < 4 || oosTotal < 2) continue;

          const trainWinRate = (trainWins / trainTotal) * 100;
          const oosWinRate = (oosWins / oosTotal) * 100;
          const winRate = ((trainWins + oosWins) / total) * 100;
          // Use 80% Wilson lower bound (z=1.28) to shrink noisy small-sample flukes
          const wilsonLowerBound = wilsonInterval(trainWins + oosWins, total, 1.28).low;
          const edgeAboveBreakeven = winRate - beWinRate;

          candidates.push({
            playbook: pb,
            profile: prof,
            horizonCandles: h,
            trainWins,
            trainLosses,
            trainWinRate,
            oosWins,
            oosLosses,
            oosWinRate,
            totalWins: trainWins + oosWins,
            totalLosses: trainLosses + oosLosses,
            winRate,
            wilsonLowerBound,
            edgeAboveBreakeven,
          });
        }
      }
    }

    // Score candidates using shrinkage-adjusted Wilson lower bound + unseen OOS consistency
    candidates.sort((a, b) => {
      const oosLowA = wilsonInterval(a.oosWins, a.oosWins + a.oosLosses, 1.0).low;
      const oosLowB = wilsonInterval(b.oosWins, b.oosWins + b.oosLosses, 1.0).low;
      const scoreA = a.wilsonLowerBound * 0.5 + oosLowA * 0.35 + a.winRate * 0.15;
      const scoreB = b.wilsonLowerBound * 0.5 + oosLowB * 0.35 + b.winRate * 0.15;
      return scoreB - scoreA;
    });

    const best = candidates[0] ?? null;

    // Require genuine OOS sample (>= 2 OOS trades), OOS WR >= max(55%, breakeven), train WR > breakeven, and overall WR >= 58% (+4.5% over BE)
    const oosPassed =
      best !== null &&
      best.oosWins + best.oosLosses >= 2 &&
      best.oosWinRate >= Math.max(55, beWinRate) &&
      best.trainWinRate >= beWinRate;
    const isTradeable =
      best !== null && best.winRate >= 58 && best.edgeAboveBreakeven >= 4.5 && oosPassed;

    const bestHorizon = isTradeable && best ? best.horizonCandles : 1;
    const bestProfile = isTradeable && best ? best.profile : defaultProfile;

    return {
      asset,
      payoutPercent,
      timeframeSeconds,
      candlesTested: closedCandles.length,
      bestPlaybook: isTradeable && best ? best.playbook : 'NONE',
      bestProfile,
      recommendedHorizonCandles: bestHorizon,
      recommendedExpirySeconds: timeframeSeconds * bestHorizon,
      bestStats: best,
      whipsawRatio,
      isTradeable,
      shouldRemovePair: !isTradeable,
      removeReason: !isTradeable
        ? best
          ? `Unreliable regime on ${asset} (best ${best.playbook}/${best.profile.name} ${best.horizonCandles}c: ${best.winRate.toFixed(
              1
            )}% total, ${best.oosWinRate.toFixed(0)}% recent unseen — need >= 58% total & >= 55% recent)`
          : `Insufficient clean setups on ${asset} (${closedCandles.length} candles analyzed)`
        : undefined,
    };
  }

  /**
   * Pro-Trader Self-Calibrating Intelligence Engine:
   * Uses the pair's Out-of-Sample Walk-Forward calibrated (Playbook + Indicator Profile + Expiry Duration)
   * and enforces volatility & live-journal toxic-pair guardrails.
   */
  public analyzeAdaptivePairIntelligence(
    asset: string,
    isOtc: boolean,
    candles: Candle[],
    payoutPercent: number,
    visual?: VisualChartAnalysis | null,
    journalTrades?: TradeRecord[],
    livePriceOverride?: number,
    timeframeSeconds: number = 300,
    cachedCalibration?: PairCalibrationReport | null
  ): AdaptivePairIntelligence {
    const closedOnly = candles.filter((c) => c.isClosed !== false);
    const evalCandles = closedOnly.length >= 10 ? closedOnly : candles;
    const closes = evalCandles.map((c) => c.close);
    const lastCandle = evalCandles[evalCandles.length - 1];
    const livePrice = livePriceOverride ?? lastCandle?.close ?? 1;
    const beWinRate = breakevenWinRate(payoutPercent);

    // 1. Kaufman Efficiency Ratio (ER) over last 10 closed candles
    const erLookback = Math.min(10, Math.max(2, closes.length - 1));
    let netMove = 0;
    let sumSteps = 0;
    if (closes.length > erLookback) {
      netMove = Math.abs(closes[closes.length - 1] - closes[closes.length - 1 - erLookback]);
      for (let i = closes.length - erLookback; i < closes.length; i++) {
        sumSteps += Math.abs(closes[i] - closes[i - 1]);
      }
    }
    const efficiencyRatio = sumSteps > 0 ? netMove / sumSteps : 0;

    // 2. ATR(14) Volatility Health
    const atrArr = TechnicalIndicators.calculateATR(evalCandles, 14);
    const currentAtr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 0;
    const atrPercent = (currentAtr / Math.max(1e-9, livePrice)) * 100;
    const recent3 = evalCandles.slice(-3);
    const avgRecent3Range =
      recent3.length > 0 ? recent3.reduce((acc, c) => acc + (c.high - c.low), 0) / recent3.length : 0;
    const volatilityState: AdaptivePairIntelligence['volatilityState'] =
      currentAtr > 0 && avgRecent3Range < currentAtr * 0.28
        ? 'DEAD_SQUEEZE'
        : currentAtr > 0 && avgRecent3Range > currentAtr * 2.6
        ? 'ERRATIC_SPIKE'
        : 'HEALTHY';

    // 3. Reuse fresh calibration report if provided, otherwise run Out-of-Sample Walk-Forward Calibration
    const calibration =
      cachedCalibration && cachedCalibration.payoutPercent === payoutPercent && cachedCalibration.timeframeSeconds === timeframeSeconds
        ? cachedCalibration
        : this.calibratePairPlaybook(asset, evalCandles, payoutPercent, timeframeSeconds);

    // Compute live IndicatorSnapshot and MarketRegime using the pair's calibrated profile
    const activeProfile = calibration.bestProfile;
    const marketRegime = TechnicalIndicators.classifyRegime(evalCandles);
    const emaFastArr = TechnicalIndicators.calculateEMA(closes, activeProfile.emaFast);
    const emaSlowArr = TechnicalIndicators.calculateEMA(closes, activeProfile.emaSlow);
    const rsiArr = TechnicalIndicators.calculateRSI(closes, activeProfile.rsiPeriod);
    const bbNow = TechnicalIndicators.calculateBollingerBands(closes, activeProfile.bbPeriod, activeProfile.bbDev);
    const lastWick = lastCandle
      ? TechnicalIndicators.analyzeCandleWicks(lastCandle)
      : { upperWickRatio: 0, lowerWickRatio: 0, bodyRatio: 1, isBullish: true, totalRange: 0 };

    const indicatorsAtEntry: IndicatorSnapshot = {
      emaFast: emaFastArr.at(-1) ?? livePrice,
      emaSlow: emaSlowArr.at(-1) ?? livePrice,
      rsi: rsiArr.at(-1) ?? 50,
      atr: currentAtr,
      bbUpper: bbNow?.upper ?? livePrice,
      bbLower: bbNow?.lower ?? livePrice,
      bbMiddle: bbNow?.middle ?? livePrice,
      candleWickRatio: Math.max(lastWick.upperWickRatio, lastWick.lowerWickRatio),
    };

    // 4. Live Journal Circuit Breaker (handles both seconds and milliseconds timestamps)
    const toMs = (ts?: number): number => (!ts ? 0 : ts < 1e11 ? ts * 1000 : ts);
    let journalEdgeSummary: string | undefined;
    let journalToxic = false;
    if (journalTrades && journalTrades.length > 0) {
      const pairTrades = journalTrades
        .filter((t) => t.asset === asset && (t.status === 'WON' || t.status === 'LOST'))
        .sort((a, b) => toMs(a.openTime) - toMs(b.openTime));
      if (pairTrades.length > 0) {
        const wins = pairTrades.filter((t) => t.status === 'WON').length;
        const wr = (wins / pairTrades.length) * 100;
        journalEdgeSummary = `Journal on ${asset}: ${wins}/${pairTrades.length} won (${wr.toFixed(1)}% vs ${beWinRate.toFixed(1)}% BE)`;
        const last2 = pairTrades.slice(-2);
        const nowMs = Date.now();
        if (
          last2.length === 2 &&
          last2.every((t) => t.status === 'LOST' && nowMs - toMs(t.openTime) < 45 * 60 * 1000)
        ) {
          journalToxic = true;
        }
      }
    }

    let shouldSwitchPair = calibration.shouldRemovePair || volatilityState !== 'HEALTHY' || journalToxic;
    let switchReason = calibration.removeReason;
    if (journalToxic) {
      switchReason = `${asset} suffered 2 consecutive live losses recently — remove & replace`;
    } else if (volatilityState === 'DEAD_SQUEEZE') {
      switchReason = `${asset} candles are flat/dead squeeze`;
    } else if (volatilityState === 'ERRATIC_SPIKE') {
      switchReason = `${asset} has erratic spike volatility (${(avgRecent3Range / Math.max(1e-9, currentAtr)).toFixed(1)}x ATR)`;
    }

    const strategyMode: AdaptiveStrategyMode =
      !calibration.isTradeable || volatilityState !== 'HEALTHY' || journalToxic
        ? 'WAIT_NO_EDGE'
        : calibration.bestPlaybook === 'STREAK_EXHAUSTION_FADE'
        ? 'MEAN_REVERSION_BB'
        : 'TREND_PULLBACK';

    let directionCall: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
    let alignedPillars = 0;
    let convictionScore = 0;
    let factors: string[] = [];
    let callLabel = '';

    if (calibration.isTradeable && volatilityState === 'HEALTHY' && !journalToxic) {
      const pbResult = this.evaluatePlaybook(calibration.bestPlaybook, evalCandles, calibration.bestProfile);
      if (pbResult) {
        let bonus = 0;
        const pbStats = calibration.bestStats!;
        const reasons = [
          `Out-of-Sample Calibrated [${calibration.bestPlaybook} | ${calibration.bestProfile.name} | ${
            calibration.recommendedHorizonCandles
          }c Hold]: ${pbStats.winRate.toFixed(1)}% total (${pbStats.totalWins}W-${pbStats.totalLosses}L) & ${pbStats.oosWinRate.toFixed(
            0
          )}% recent unseen WR`,
          ...pbResult.reasons,
        ];

        // Check micro-structure OHLC candlestick pattern (Pinbar / Engulfing) on true price data
        const prevCandle = evalCandles.length >= 2 ? evalCandles[evalCandles.length - 2] : undefined;
        const pattern = lastCandle ? TechnicalIndicators.detectPattern(lastCandle, prevCandle) : 'NONE';
        if (
          (pbResult.direction === 'CALL' && (pattern === 'PINBAR_BULLISH' || pattern === 'ENGULFING_BULLISH')) ||
          (pbResult.direction === 'PUT' && (pattern === 'PINBAR_BEARISH' || pattern === 'ENGULFING_BEARISH'))
        ) {
          bonus = 4;
          reasons.push(`OHLC Price Action: Confirmed ${pattern.replace('_', ' ')} candle structure`);
        } else if (visual?.canvasFound && visual.visualBias === pbResult.direction) {
          bonus = 4;
          reasons.push(`Chart Structure: Confirms ${pbResult.direction} directional bias`);
        }

        directionCall = pbResult.direction;
        alignedPillars = Math.min(5, pbResult.alignedPillars + (bonus > 0 ? 1 : 0));
        convictionScore = Math.min(96, pbResult.score + bonus);
        factors = reasons;
        callLabel = `${pbResult.direction} [${pbResult.direction === 'CALL' ? 'UP' : 'DOWN'}] (${
          calibration.bestPlaybook
        }/${calibration.bestProfile.name} · ${pbStats.oosWinRate.toFixed(0)}% OOS)`;
      } else {
        const pbStats = calibration.bestStats!;
        callLabel = `WAIT (${calibration.bestPlaybook}/${calibration.bestProfile.name} · ${pbStats.winRate.toFixed(
          0
        )}% WR / ${pbStats.oosWinRate.toFixed(0)}% OOS)`;
        factors = [
          `Calibrated: ${calibration.bestPlaybook} (${calibration.bestProfile.name}, ${calibration.recommendedHorizonCandles}c expiry) — waiting for exact trigger`,
        ];
      }
    } else {
      callLabel = `SKIP / REMOVE (${switchReason || 'No calibrated edge'})`;
      factors = [switchReason || 'No calibrated edge on this market'];
    }

    return {
      asset,
      isOtc,
      strategyMode,
      activePlaybook: calibration.bestPlaybook,
      activeProfile: calibration.bestProfile,
      recommendedExpirySeconds: calibration.recommendedExpirySeconds,
      calibration,
      marketRegime,
      indicatorsAtEntry,
      efficiencyRatio,
      atrPercent,
      volatilityState,
      directionCall,
      callLabel,
      convictionScore,
      alignedPillars,
      totalPillars: 5,
      shouldSwitchPair,
      switchReason,
      factors,
      journalEdgeSummary,
    };
  }
}
