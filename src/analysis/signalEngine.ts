import { Candle } from '../stream/types.js';
import { TradeRecord, IndicatorSnapshot } from '../journal/types.js';
import { TechnicalIndicators, BollingerBandsResult, CandleWickAnalysis } from './indicators.js';
import {
  breakevenWinRate,
  wilsonInterval,
  bonferroniZ,
  binomialOneSidedPValue,
  empiricalBayesWinRate,
  expectedValuePerDollar,
  halfKellyFraction,
} from './binaryMath.js';
import { VisualChartAnalysis } from './visualChartEngine.js';

export type AdaptiveStrategyMode = 'TREND_PULLBACK' | 'MEAN_REVERSION_BB' | 'BREAKOUT_MOMENTUM' | 'WAIT_NO_EDGE';
export type PlaybookName = 'EMA_PULLBACK_SNIPER' | 'MOMENTUM_CHANNEL' | 'STREAK_EXHAUSTION_FADE' | 'NONE';
export type IndicatorProfileName = 'FAST' | 'STANDARD' | 'SMOOTH';
export type MarketRegimeKind = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY';
export type CalibrationTier = 'PROVEN_EDGE' | 'PRELIMINARY' | 'NO_EDGE';

/** Plain, non-hyped labels for user-facing output. */
export const PLAYBOOK_DISPLAY_NAMES: Record<PlaybookName, string> = {
  EMA_PULLBACK_SNIPER: 'EMA Pullback',
  MOMENTUM_CHANNEL: 'Momentum Channel',
  STREAK_EXHAUSTION_FADE: 'Exhaustion Fade',
  NONE: 'None',
};

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

export const ALL_PLAYBOOKS: PlaybookName[] = [
  'EMA_PULLBACK_SNIPER',
  'MOMENTUM_CHANNEL',
  'STREAK_EXHAUSTION_FADE',
];

export const ALL_PROFILES: IndicatorProfile[] = [
  INDICATOR_PROFILES.FAST,
  INDICATOR_PROFILES.STANDARD,
  INDICATOR_PROFILES.SMOOTH,
];

export interface PlaybookStats {
  playbook: PlaybookName;
  profile: IndicatorProfile;
  horizonCandles: number;
  trainWins: number;
  trainLosses: number;
  trainWinRate: number;
  trainWilsonLowBonf: number; // Bonferroni-corrected Wilson lower bound on train set
  trainPValueBonf: number; // Multiple-testing adjusted train p-value
  oosWins: number; // STRICTLY UNTOUCHED holdout (never used to rank/select candidates!)
  oosLosses: number;
  oosWinRate: number;
  oosWilsonLow95: number; // 95% Wilson lower bound on untouched OOS
  oosWilsonHigh95: number; // 95% Wilson upper bound on untouched OOS
  oosWilsonLow1Sigma: number; // 1-sigma (~84% one-sided) Wilson lower bound on untouched OOS
  oosPValue: number; // Exact one-sided binomial p-value vs break-even on untouched OOS
  estimatedWinRate: number; // Empirical Bayes shrunk probability (pulled toward 50% coin flip)
  expectedValuePerDollar: number; // EV per $1 staked using shrunk win probability
  rawOosEvPerDollar: number; // EV per $1 staked using raw untouched OOS win rate
  halfKelly: number; // Conservative half-Kelly bankroll fraction (capped at 2%)
  candidatesTested: number; // K = number of variants searched during training selection
  totalWins: number;
  totalLosses: number;
  winRate: number; // Combined (informational only — never used for gating!)
  wilsonLowerBound: number; // Untouched OOS 95% Wilson lower bound
  edgeAboveBreakeven: number; // Untouched OOS win rate minus break-even (percentage points)
}

export interface CalibrationOptions {
  /** If true (required for unproven LIVE safety gate), only PROVEN_EDGE passes isTradeable. */
  strictProvenOnly?: boolean;
  /** Fraction of history reserved strictly for candidate selection (default 0.60). */
  trainFraction?: number;
  /** Minimum training trades required for a candidate to be eligible (default 5). */
  minTrainTrades?: number;
  /** Minimum untouched OOS trades required for PRELIMINARY tier (default 4). PROVEN_EDGE always needs >= 30. */
  minOosTrades?: number;
  /** Minimum payout % to allow trading (default 80). */
  minPayoutPercent?: number;
}

export interface PairCalibrationReport {
  asset: string;
  payoutPercent: number;
  timeframeSeconds: number;
  candlesTested: number;
  tier: CalibrationTier;
  bestPlaybook: PlaybookName;
  bestProfile: IndicatorProfile;
  recommendedHorizonCandles: number;
  recommendedExpirySeconds: number;
  bestStats: PlaybookStats | null;
  candidatesTested: number;
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
  playbookLabel: string;
  activeProfile: IndicatorProfile;
  recommendedExpirySeconds: number;
  calibration: PairCalibrationReport;
  calibrationTier: CalibrationTier;
  marketRegime: MarketRegimeKind;
  indicatorsAtEntry: IndicatorSnapshot;
  efficiencyRatio: number;
  atrPercent: number;
  volatilityState: 'DEAD_SQUEEZE' | 'HEALTHY' | 'ERRATIC_SPIKE';
  directionCall: 'CALL' | 'PUT' | 'WAIT';
  callLabel: string;
  /** Honest Empirical Bayes shrunk win probability (0-100), NOT a hardcoded conviction score. */
  estimatedWinProb: number;
  /** Expected value per $1 staked based on shrunk win probability and live payout. */
  expectedValuePerDollar: number;
  /** Alias for estimatedWinProb (stored in DB signal_confidence for backwards compatibility). */
  convictionScore: number;
  alignedPillars: number;
  totalPillars: number;
  shouldSwitchPair: boolean;
  switchReason?: string;
  factors: string[];
  journalEdgeSummary?: string;
}

export interface PlaybookSignalResult {
  direction: 'CALL' | 'PUT';
  alignedPillars: number;
  reasons: string[];
}

/**
 * O(N) precomputed indicator arrays aligned to candle indices [0..N-1] for a given profile.
 * Eliminates the O(N^2) slicing bottleneck during calibration and multi-thousand-bar backtests.
 */
export interface PrecomputedProfileSeries {
  candles: Candle[];
  profile: IndicatorProfile;
  minNeeded: number;
  emaFast: (number | undefined)[];
  emaSlow: (number | undefined)[];
  rsi: (number | undefined)[];
  stochK: (number | undefined)[];
  stochD: (number | undefined)[];
  bbMain: (BollingerBandsResult | null)[];
  bbFade: (BollingerBandsResult | null)[];
  wicks: CandleWickAnalysis[];
  consecBull: number[];
  consecBear: number[];
  swingHigh: number[];
  swingLow: number[];
}

export function precomputeProfileSeries(candles: Candle[], profile: IndicatorProfile): PrecomputedProfileSeries {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const minNeeded = Math.max(30, profile.emaSlow + 5, profile.bbPeriod + 5);

  const emaFast: (number | undefined)[] = new Array(n).fill(undefined);
  const emaSlow: (number | undefined)[] = new Array(n).fill(undefined);
  const rsi: (number | undefined)[] = new Array(n).fill(undefined);
  const stochK: (number | undefined)[] = new Array(n).fill(undefined);
  const stochD: (number | undefined)[] = new Array(n).fill(undefined);
  const bbMain: (BollingerBandsResult | null)[] = new Array(n).fill(null);
  const bbFade: (BollingerBandsResult | null)[] = new Array(n).fill(null);
  const wicks: CandleWickAnalysis[] = new Array(n);
  const consecBull: number[] = new Array(n).fill(0);
  const consecBear: number[] = new Array(n).fill(0);
  const swingHigh: number[] = new Array(n).fill(0);
  const swingLow: number[] = new Array(n).fill(0);

  if (n >= profile.emaFast) {
    const arr = TechnicalIndicators.calculateEMA(closes, profile.emaFast);
    const offset = profile.emaFast - 1;
    for (let j = 0; j < arr.length; j++) emaFast[offset + j] = arr[j];
  }

  if (n >= profile.emaSlow) {
    const arr = TechnicalIndicators.calculateEMA(closes, profile.emaSlow);
    const offset = profile.emaSlow - 1;
    for (let j = 0; j < arr.length; j++) emaSlow[offset + j] = arr[j];
  }

  if (n > profile.rsiPeriod) {
    const arr = TechnicalIndicators.calculateRSI(closes, profile.rsiPeriod);
    const offset = profile.rsiPeriod;
    for (let j = 0; j < arr.length; j++) rsi[offset + j] = arr[j];
  }

  if (n >= profile.stochK + 4) {
    const stoch = TechnicalIndicators.calculateStochastic(candles, profile.stochK, 3, 3);
    const kOffset = profile.stochK + 1;
    for (let j = 0; j < stoch.k.length; j++) stochK[kOffset + j] = stoch.k[j];
    const dOffset = profile.stochK + 3;
    for (let j = 0; j < stoch.d.length; j++) stochD[dOffset + j] = stoch.d[j];
  }

  const fadeDev = Math.max(1.7, profile.bbDev - 0.2);
  const bp = profile.bbPeriod;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    wicks[i] = TechnicalIndicators.analyzeCandleWicks(c);

    if (c.close > c.open) {
      consecBull[i] = i > 0 ? consecBull[i - 1] + 1 : 1;
      consecBear[i] = 0;
    } else if (c.close < c.open) {
      consecBear[i] = i > 0 ? consecBear[i - 1] + 1 : 1;
      consecBull[i] = 0;
    }

    // Swing high/low over the 22 candles strictly preceding index i (exact parity with slice(-23, -1))
    if (i > 0) {
      const start = Math.max(0, i - 22);
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = start; j < i; j++) {
        if (candles[j].high > hi) hi = candles[j].high;
        if (candles[j].low < lo) lo = candles[j].low;
      }
      swingHigh[i] = hi;
      swingLow[i] = lo;
    }

    if (i >= bp - 1) {
      let sum = 0;
      for (let j = i - bp + 1; j <= i; j++) sum += closes[j];
      const mean = sum / bp;
      let varSum = 0;
      for (let j = i - bp + 1; j <= i; j++) {
        const diff = closes[j] - mean;
        varSum += diff * diff;
      }
      const stdDev = Math.sqrt(varSum / bp);
      const upperMain = mean + profile.bbDev * stdDev;
      const lowerMain = mean - profile.bbDev * stdDev;
      bbMain[i] = {
        upper: upperMain,
        middle: mean,
        lower: lowerMain,
        bandwidth: mean > 0 ? (upperMain - lowerMain) / mean : 0,
      };
      const upperFade = mean + fadeDev * stdDev;
      const lowerFade = mean - fadeDev * stdDev;
      bbFade[i] = {
        upper: upperFade,
        middle: mean,
        lower: lowerFade,
        bandwidth: mean > 0 ? (upperFade - lowerFade) / mean : 0,
      };
    }
  }

  return {
    candles,
    profile,
    minNeeded,
    emaFast,
    emaSlow,
    rsi,
    stochK,
    stochD,
    bbMain,
    bbFade,
    wicks,
    consecBull,
    consecBear,
    swingHigh,
    swingLow,
  };
}

export class SignalEngine {
  /**
   * Evaluates a specific playbook at candle index `i` using O(N) precomputed series.
   * Bit-for-bit identical to `evaluatePlaybook(playbook, candles.slice(0, i + 1), profile)`.
   */
  public evaluatePlaybookAt(
    playbook: PlaybookName,
    series: PrecomputedProfileSeries,
    i: number
  ): PlaybookSignalResult | null {
    if (playbook === 'NONE' || i + 1 < series.minNeeded || i < 2 || i >= series.candles.length) {
      return null;
    }

    const ef = series.emaFast[i];
    const efPrev = series.emaFast[i - 1];
    const es = series.emaSlow[i];
    const rsi = series.rsi[i];
    const rsiPrev = series.rsi[i - 1];
    const bbMain = series.bbMain[i];
    const bbFade = series.bbFade[i];

    if (
      ef === undefined ||
      efPrev === undefined ||
      es === undefined ||
      rsi === undefined ||
      rsiPrev === undefined ||
      !bbMain ||
      !bbFade
    ) {
      return null;
    }

    const profile = series.profile;
    const last = series.candles[i];
    const prev = series.candles[i - 1];
    const wick = series.wicks[i];
    const k = series.stochK[i] ?? 50;
    const kPrev = series.stochK[i - 1] ?? k;
    const d = series.stochD[i] ?? 50;

    const bbSpan = Math.max(1e-9, bbMain.upper - bbMain.lower);
    const pctB = (last.close - bbMain.lower) / bbSpan;

    const consecutiveBull = series.consecBull[i];
    const consecutiveBear = series.consecBear[i];

    const swingSpan = Math.max(1e-9, series.swingHigh[i] - series.swingLow[i]);
    const nearResistance = (series.swingHigh[i] - last.close) / swingSpan < 0.08;
    const nearSupport = (last.close - series.swingLow[i]) / swingSpan < 0.08;

    const rsiHighCap = profile.rsiPeriod <= 8 ? 72 : 66;
    const rsiLowFloor = profile.rsiPeriod <= 8 ? 28 : 34;

    // ── PLAYBOOK 1: EMA PULLBACK ──
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
          reasons: [
            `EMA(${profile.emaFast}/${profile.emaSlow}) Pullback: Price touched EMA(${profile.emaFast}) (${ef.toFixed(5)}) and closed above it`,
            `Trend filter: EMA(${profile.emaFast}) > EMA(${profile.emaSlow}) (${es.toFixed(5)}), clear of swing high`,
            `RSI(${profile.rsiPeriod}): ${rsi.toFixed(1)} (mid-bullish range)`,
            `Candle structure: Bullish close, lower wick ${Math.round(wick.lowerWickRatio * 100)}%`,
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
          reasons: [
            `EMA(${profile.emaFast}/${profile.emaSlow}) Pullback: Price touched EMA(${profile.emaFast}) (${ef.toFixed(5)}) and closed below it`,
            `Trend filter: EMA(${profile.emaFast}) < EMA(${profile.emaSlow}) (${es.toFixed(5)}), clear of swing low`,
            `RSI(${profile.rsiPeriod}): ${rsi.toFixed(1)} (mid-bearish range)`,
            `Candle structure: Bearish close, upper wick ${Math.round(wick.upperWickRatio * 100)}%`,
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
          reasons: [
            `Momentum Channel [${profile.name}]: Rising EMA(${profile.emaFast}) > EMA(${profile.emaSlow})`,
            `Bollinger(${profile.bbPeriod},${profile.bbDev}): Mid-upper band (%B ${(pctB * 100).toFixed(0)}%)`,
            `RSI(${profile.rsiPeriod}): Rising ${rsiPrev.toFixed(1)} -> ${rsi.toFixed(1)}`,
            `Candle structure: Bullish body ${Math.round(wick.bodyRatio * 100)}%`,
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
          reasons: [
            `Momentum Channel [${profile.name}]: Falling EMA(${profile.emaFast}) < EMA(${profile.emaSlow})`,
            `Bollinger(${profile.bbPeriod},${profile.bbDev}): Mid-lower band (%B ${(pctB * 100).toFixed(0)}%)`,
            `RSI(${profile.rsiPeriod}): Falling ${rsiPrev.toFixed(1)} -> ${rsi.toFixed(1)}`,
            `Candle structure: Bearish body ${Math.round(wick.bodyRatio * 100)}%`,
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
          reasons: [
            `Exhaustion Fade [${profile.name}]: ${consecutiveBear} consecutive red candles stretched into lower band`,
            `Bollinger(${profile.bbPeriod}): Close ${last.close.toFixed(5)} vs Lower Band ${bbFade.lower.toFixed(5)}`,
            `RSI(${profile.rsiPeriod}): Oversold at ${rsi.toFixed(1)}`,
            `Stochastic(${profile.stochK},3,3): %K at ${k.toFixed(0)}`,
          ],
        };
      }
      if (consecutiveBull >= 3 && (last.close >= bbFade.upper || rsi >= obLevel)) {
        return {
          direction: 'PUT',
          alignedPillars: 4,
          reasons: [
            `Exhaustion Fade [${profile.name}]: ${consecutiveBull} consecutive green candles stretched into upper band`,
            `Bollinger(${profile.bbPeriod}): Close ${last.close.toFixed(5)} vs Upper Band ${bbFade.upper.toFixed(5)}`,
            `RSI(${profile.rsiPeriod}): Overbought at ${rsi.toFixed(1)}`,
            `Stochastic(${profile.stochK},3,3): %K at ${k.toFixed(0)}`,
          ],
        };
      }
      return null;
    }

    return null;
  }

  /**
   * Evaluates a specific Playbook on the latest bar of `candles`.
   * Uses the exact same precomputed logic as calibration & backtesting so zero test/live drift exists.
   */
  public evaluatePlaybook(
    playbook: PlaybookName,
    candles: Candle[],
    profile: IndicatorProfile = INDICATOR_PROFILES.STANDARD
  ): PlaybookSignalResult | null {
    const minNeeded = Math.max(30, profile.emaSlow + 5, profile.bbPeriod + 5);
    if (candles.length < minNeeded || playbook === 'NONE') return null;
    const series = precomputeProfileSeries(candles, profile);
    return this.evaluatePlaybookAt(playbook, series, candles.length - 1);
  }

  /**
   * Leak-Free Out-of-Sample Walk-Forward Calibration:
   *
   * 1. Splits `closedCandles` strictly into Training (first 60%) and Untouched Holdout OOS (final 40%).
   *    No training trade is allowed to cross the split boundary into OOS.
   * 2. Evaluates all (playbook x profile x horizon) variants on TRAINING ONLY and ranks them
   *    strictly by Bonferroni-adjusted Train Wilson lower bound — OOS is NEVER peeked at during selection!
   * 3. Takes ONLY the single #1 training winner and evaluates it ONCE on the untouched Holdout OOS split.
   * 4. Gates on statistical Wilson lower bounds (not raw combined win rate) and assigns an honest tier:
   *    - PROVEN_EDGE : >= 30 untouched OOS trades AND 95% OOS Wilson lower bound > break-even (p < 0.05)
   *    - PRELIMINARY : >= minOosTrades untouched OOS trades AND 1-sigma OOS Wilson lower bound > break-even
   *                    (exploratory/demo only — explicitly labeled UNPROVEN and rejected if strictProvenOnly=true)
   *    - NO_EDGE     : fails statistical criteria
   */
  public calibratePairPlaybook(
    asset: string,
    closedCandles: Candle[],
    payoutPercent: number,
    timeframeSeconds: number = 300,
    options: CalibrationOptions = {}
  ): PairCalibrationReport {
    const minPayout = options.minPayoutPercent ?? 80;
    const strictProvenOnly = options.strictProvenOnly ?? false;
    const trainFraction = options.trainFraction ?? 0.6;
    const minTrainTrades = options.minTrainTrades ?? 5;
    const minOosTrades = options.minOosTrades ?? 4;
    const beWinRate = breakevenWinRate(payoutPercent);
    const defaultProfile = INDICATOR_PROFILES.STANDARD;

    // Measure whipsaw/doji trap ratio over the last 12 closed candles
    const recent12 = closedCandles.slice(-12);
    let whipsawCount = 0;
    for (const c of recent12) {
      const w = TechnicalIndicators.analyzeCandleWicks(c);
      if (w.bodyRatio < 0.2 || (w.upperWickRatio >= 0.35 && w.lowerWickRatio >= 0.35)) {
        whipsawCount++;
      }
    }
    const whipsawRatio = recent12.length > 0 ? whipsawCount / recent12.length : 0;

    if (payoutPercent < minPayout) {
      return {
        asset,
        payoutPercent,
        timeframeSeconds,
        candlesTested: closedCandles.length,
        tier: 'NO_EDGE',
        bestPlaybook: 'NONE',
        bestProfile: defaultProfile,
        recommendedHorizonCandles: 1,
        recommendedExpirySeconds: timeframeSeconds,
        bestStats: null,
        candidatesTested: 0,
        whipsawRatio,
        isTradeable: false,
        shouldRemovePair: true,
        removeReason: `Low payout (${payoutPercent}% < ${minPayout}% min; needs ${beWinRate.toFixed(1)}% WR to break even)`,
      };
    }

    if (closedCandles.length < 70) {
      return {
        asset,
        payoutPercent,
        timeframeSeconds,
        candlesTested: closedCandles.length,
        tier: 'NO_EDGE',
        bestPlaybook: 'NONE',
        bestProfile: defaultProfile,
        recommendedHorizonCandles: 1,
        recommendedExpirySeconds: timeframeSeconds,
        bestStats: null,
        candidatesTested: 0,
        whipsawRatio,
        isTradeable: false,
        shouldRemovePair: false,
        removeReason: `Warming up history (${closedCandles.length}/70 closed candles)`,
      };
    }

    if (whipsawRatio >= 0.5) {
      return {
        asset,
        payoutPercent,
        timeframeSeconds,
        candlesTested: closedCandles.length,
        tier: 'NO_EDGE',
        bestPlaybook: 'NONE',
        bestProfile: defaultProfile,
        recommendedHorizonCandles: 1,
        recommendedExpirySeconds: timeframeSeconds,
        bestStats: null,
        candidatesTested: 0,
        whipsawRatio,
        isTradeable: false,
        shouldRemovePair: true,
        removeReason: `Erratic whipsaw/doji traps (${Math.round(whipsawRatio * 100)}% in last 12 bars)`,
      };
    }

    // Allowed expiry horizons matching Quotex's real expiry presets
    const horizons = timeframeSeconds <= 60 || timeframeSeconds === 300 ? [1, 2, 3] : [1, 2];
    const splitIdx = Math.max(45, Math.floor(closedCandles.length * trainFraction));

    interface TrainCandidate {
      playbook: PlaybookName;
      profile: IndicatorProfile;
      horizonCandles: number;
      signalIndices: Array<{ idx: number; dir: 'CALL' | 'PUT' }>;
      trainWins: number;
      trainLosses: number;
      trainWinRate: number;
      trainWilsonLowBonf: number;
      trainWilsonLow80: number;
      trainPValue: number;
    }

    const totalPossibleVariants = ALL_PLAYBOOKS.length * ALL_PROFILES.length * horizons.length;
    const bonfZ = bonferroniZ(totalPossibleVariants, 0.05, false);

    let candidatesTested = 0;
    const trainCandidates: TrainCandidate[] = [];

    for (const prof of ALL_PROFILES) {
      const series = precomputeProfileSeries(closedCandles, prof);
      for (const pb of ALL_PLAYBOOKS) {
        const signalIndices: Array<{ idx: number; dir: 'CALL' | 'PUT' }> = [];
        for (let i = series.minNeeded - 1; i < closedCandles.length - 1; i++) {
          const sig = this.evaluatePlaybookAt(pb, series, i);
          if (sig) {
            signalIndices.push({ idx: i, dir: sig.direction });
          }
        }

        for (const h of horizons) {
          candidatesTested++;
          let trainWins = 0;
          let trainLosses = 0;

          // STRICT TRAIN ONLY: exitIdx MUST stay strictly below splitIdx (zero boundary leakage into OOS)
          for (const s of signalIndices) {
            const entryIdx = s.idx + 1;
            const exitIdx = s.idx + h;
            if (exitIdx >= splitIdx) continue;
            const entryPrice = closedCandles[entryIdx].open;
            const exitPrice = closedCandles[exitIdx].close;
            if (exitPrice === entryPrice) continue;

            const won = (s.dir === 'CALL' && exitPrice > entryPrice) || (s.dir === 'PUT' && exitPrice < entryPrice);
            if (won) trainWins++;
            else trainLosses++;
          }

          const trainTotal = trainWins + trainLosses;
          if (trainTotal < minTrainTrades) continue;

          const trainWinRate = (trainWins / trainTotal) * 100;
          if (trainWinRate <= beWinRate) continue;

          const trainWilsonLowBonf = wilsonInterval(trainWins, trainTotal, bonfZ).low;
          const trainWilsonLow80 = wilsonInterval(trainWins, trainTotal, 1.28).low;
          const trainPValue = binomialOneSidedPValue(trainWins, trainTotal, beWinRate / 100);

          trainCandidates.push({
            playbook: pb,
            profile: prof,
            horizonCandles: h,
            signalIndices,
            trainWins,
            trainLosses,
            trainWinRate,
            trainWilsonLowBonf,
            trainWilsonLow80,
            trainPValue,
          });
        }
      }
    }

    // Rank STRICTLY on Training performance (NEVER touches OOS!)
    trainCandidates.sort((a, b) => {
      if (Math.abs(b.trainWilsonLowBonf - a.trainWilsonLowBonf) > 0.05) {
        return b.trainWilsonLowBonf - a.trainWilsonLowBonf;
      }
      if (Math.abs(b.trainWilsonLow80 - a.trainWilsonLow80) > 0.05) {
        return b.trainWilsonLow80 - a.trainWilsonLow80;
      }
      return b.trainWinRate - a.trainWinRate;
    });

    const selected = trainCandidates[0] ?? null;

    if (!selected) {
      return {
        asset,
        payoutPercent,
        timeframeSeconds,
        candlesTested: closedCandles.length,
        tier: 'NO_EDGE',
        bestPlaybook: 'NONE',
        bestProfile: defaultProfile,
        recommendedHorizonCandles: 1,
        recommendedExpirySeconds: timeframeSeconds,
        bestStats: null,
        candidatesTested,
        whipsawRatio,
        isTradeable: false,
        shouldRemovePair: true,
        removeReason: `No playbook beat ${beWinRate.toFixed(1)}% break-even in training across ${closedCandles.length} candles`,
      };
    }

    // ── STEP 2: EVALUATE ONLY THE SINGLE TRAIN WINNER ON UNTOUCHED HOLDOUT OOS ──
    let oosWins = 0;
    let oosLosses = 0;
    for (const s of selected.signalIndices) {
      if (s.idx < splitIdx) continue;
      const entryIdx = s.idx + 1;
      const exitIdx = s.idx + selected.horizonCandles;
      if (exitIdx >= closedCandles.length) continue;
      const entryPrice = closedCandles[entryIdx].open;
      const exitPrice = closedCandles[exitIdx].close;
      if (exitPrice === entryPrice) continue;

      const won = (s.dir === 'CALL' && exitPrice > entryPrice) || (s.dir === 'PUT' && exitPrice < entryPrice);
      if (won) oosWins++;
      else oosLosses++;
    }

    const oosTotal = oosWins + oosLosses;
    const oosWinRate = oosTotal > 0 ? (oosWins / oosTotal) * 100 : 0;
    const oos95 = wilsonInterval(oosWins, oosTotal, 1.96);
    const oos1Sigma = wilsonInterval(oosWins, oosTotal, 1.0);
    const oosPValue = binomialOneSidedPValue(oosWins, oosTotal, beWinRate / 100);
    const trainPValueBonf = Math.min(1, selected.trainPValue * Math.max(1, candidatesTested));

    // Honest shrunk win probability based purely on untouched OOS (pulled toward 50% prior)
    const estimatedWinRate = empiricalBayesWinRate(oosWins, oosTotal, 50, 20);
    const evPerDollar = expectedValuePerDollar(estimatedWinRate, payoutPercent);
    const rawOosEv = oosTotal > 0 ? expectedValuePerDollar(oosWinRate, payoutPercent) : -1;
    const hk = halfKellyFraction(estimatedWinRate, payoutPercent);

    const totalWins = selected.trainWins + oosWins;
    const totalLosses = selected.trainLosses + oosLosses;
    const combinedWinRate = totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0;

    const bestStats: PlaybookStats = {
      playbook: selected.playbook,
      profile: selected.profile,
      horizonCandles: selected.horizonCandles,
      trainWins: selected.trainWins,
      trainLosses: selected.trainLosses,
      trainWinRate: selected.trainWinRate,
      trainWilsonLowBonf: selected.trainWilsonLowBonf,
      trainPValueBonf,
      oosWins,
      oosLosses,
      oosWinRate,
      oosWilsonLow95: oos95.low,
      oosWilsonHigh95: oos95.high,
      oosWilsonLow1Sigma: oos1Sigma.low,
      oosPValue,
      estimatedWinRate,
      expectedValuePerDollar: evPerDollar,
      rawOosEvPerDollar: rawOosEv,
      halfKelly: hk,
      candidatesTested,
      totalWins,
      totalLosses,
      winRate: combinedWinRate,
      wilsonLowerBound: oos95.low,
      edgeAboveBreakeven: oosWinRate - beWinRate,
    };

    // Determine honest statistical tier strictly from UNTOUCHED OOS
    let tier: CalibrationTier = 'NO_EDGE';
    if (oosTotal >= 30 && oos95.low > beWinRate && oosPValue < 0.05) {
      tier = 'PROVEN_EDGE';
    } else if (oosTotal >= minOosTrades && oos1Sigma.low > beWinRate && rawOosEv > 0.02) {
      tier = 'PRELIMINARY';
    }

    const isTradeable = strictProvenOnly ? tier === 'PROVEN_EDGE' : tier === 'PROVEN_EDGE' || tier === 'PRELIMINARY';
    const bestHorizon = isTradeable ? selected.horizonCandles : 1;
    const bestProfile = isTradeable ? selected.profile : defaultProfile;
    const pbLabel = PLAYBOOK_DISPLAY_NAMES[selected.playbook];

    let removeReason: string | undefined;
    if (!isTradeable) {
      if (oosTotal < minOosTrades) {
        removeReason = `Too few untouched OOS signals on ${asset} (${oosTotal}/${minOosTrades} for ${pbLabel}/${selected.profile.name}; train was ${selected.trainWins}W-${selected.trainLosses}L)`;
      } else if (strictProvenOnly && tier === 'PRELIMINARY') {
        removeReason = `${asset} only reached PRELIMINARY tier (${oosWins}/${oosTotal} OOS, 95% CI ${oos95.low.toFixed(1)}-${oos95.high.toFixed(1)}% overlaps ${beWinRate.toFixed(1)}% BE) — LIVE requires PROVEN_EDGE`;
      } else {
        removeReason = `Failed untouched OOS on ${asset} (${pbLabel}/${selected.profile.name} ${selected.horizonCandles}c: ${oosWins}W-${oosLosses}L = ${oosWinRate.toFixed(1)}%, 1-sigma low ${oos1Sigma.low.toFixed(1)}% <= ${beWinRate.toFixed(1)}% BE)`;
      }
    }

    return {
      asset,
      payoutPercent,
      timeframeSeconds,
      candlesTested: closedCandles.length,
      tier,
      bestPlaybook: isTradeable ? selected.playbook : 'NONE',
      bestProfile,
      recommendedHorizonCandles: bestHorizon,
      recommendedExpirySeconds: timeframeSeconds * bestHorizon,
      bestStats,
      candidatesTested,
      whipsawRatio,
      isTradeable,
      shouldRemovePair: !isTradeable,
      removeReason,
    };
  }

  /**
   * Adaptive Pair Intelligence Engine:
   * Uses the pair's leak-free Walk-Forward calibrated (Playbook + Profile + Horizon),
   * enforces volatility and journal circuit breakers, and reports honest shrunk win probability & EV.
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
    cachedCalibration?: PairCalibrationReport | null,
    options?: {
      strictProvenOnly?: boolean;
      pairLossStreakLimit?: number;
    }
  ): AdaptivePairIntelligence {
    const closedOnly = candles.filter((c) => c.isClosed !== false);
    const evalCandles = closedOnly.length >= 10 ? closedOnly : candles;
    const closes = evalCandles.map((c) => c.close);
    const lastCandle = evalCandles[evalCandles.length - 1];
    const livePrice = livePriceOverride ?? lastCandle?.close ?? 1;
    const beWinRate = breakevenWinRate(payoutPercent);
    const pairLossLimit = options?.pairLossStreakLimit ?? 3;

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

    // 3. Reuse fresh calibration report if provided, otherwise run leak-free Walk-Forward Calibration
    const calibration =
      cachedCalibration &&
      cachedCalibration.payoutPercent === payoutPercent &&
      cachedCalibration.timeframeSeconds === timeframeSeconds
        ? cachedCalibration
        : this.calibratePairPlaybook(asset, evalCandles, payoutPercent, timeframeSeconds, {
            strictProvenOnly: options?.strictProvenOnly,
          });

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
        const recentSlice = pairTrades.slice(-pairLossLimit);
        const nowMs = Date.now();
        if (
          recentSlice.length === pairLossLimit &&
          recentSlice.every((t) => t.status === 'LOST' && nowMs - toMs(t.openTime) < 45 * 60 * 1000)
        ) {
          journalToxic = true;
        }
      }
    }

    const shouldSwitchPair = calibration.shouldRemovePair || volatilityState !== 'HEALTHY' || journalToxic;
    let switchReason = calibration.removeReason;
    if (journalToxic) {
      switchReason = `${asset} hit ${pairLossLimit} consecutive live losses recently — cooling down`;
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

    const pbLabel = PLAYBOOK_DISPLAY_NAMES[calibration.bestPlaybook];
    let directionCall: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
    let alignedPillars = 0;
    let estimatedWinProb = calibration.bestStats?.estimatedWinRate ?? 50;
    let evPerDollar = calibration.bestStats?.expectedValuePerDollar ?? expectedValuePerDollar(50, payoutPercent);
    let factors: string[] = [];
    let callLabel = '';

    if (calibration.isTradeable && volatilityState === 'HEALTHY' && !journalToxic) {
      const pbResult = this.evaluatePlaybook(calibration.bestPlaybook, evalCandles, calibration.bestProfile);
      const pbStats = calibration.bestStats!;
      const tierBadge = calibration.tier === 'PROVEN_EDGE' ? 'PROVEN' : 'PRELIMINARY [UNPROVEN]';
      const oosTotal = pbStats.oosWins + pbStats.oosLosses;

      if (pbResult) {
        const reasons = [
          `Untouched OOS [${pbLabel} | ${calibration.bestProfile.name} | ${calibration.recommendedHorizonCandles}c]: ${pbStats.oosWins}/${oosTotal} (${pbStats.oosWinRate.toFixed(1)}%, 95% CI ${pbStats.oosWilsonLow95.toFixed(1)}-${pbStats.oosWilsonHigh95.toFixed(1)}%) | Tier: ${tierBadge}`,
          `Shrunk Est Win Prob: ${pbStats.estimatedWinRate.toFixed(1)}% vs ${beWinRate.toFixed(1)}% BE | Shrunk EV: ${evPerDollar >= 0 ? '+' : ''}$${evPerDollar.toFixed(3)}/$1 | Raw OOS EV: ${pbStats.rawOosEvPerDollar >= 0 ? '+' : ''}$${pbStats.rawOosEvPerDollar.toFixed(3)}/$1`,
          ...pbResult.reasons,
        ];

        const prevCandle = evalCandles.length >= 2 ? evalCandles[evalCandles.length - 2] : undefined;
        const pattern = lastCandle ? TechnicalIndicators.detectPattern(lastCandle, prevCandle) : 'NONE';
        let structureBonus = 0;
        if (
          (pbResult.direction === 'CALL' && (pattern === 'PINBAR_BULLISH' || pattern === 'ENGULFING_BULLISH')) ||
          (pbResult.direction === 'PUT' && (pattern === 'PINBAR_BEARISH' || pattern === 'ENGULFING_BEARISH'))
        ) {
          structureBonus = 1;
          reasons.push(`OHLC Pattern: ${pattern.replace('_', ' ')}`);
        } else if (visual?.canvasFound && visual.visualBias === pbResult.direction) {
          structureBonus = 1;
          reasons.push(`OHLC Structure: Aligns with ${pbResult.direction} slope`);
        }
        if (isOtc) {
          reasons.push('Notice: OTC feed is broker-generated (counterparty risk)');
        }

        directionCall = pbResult.direction;
        alignedPillars = Math.min(5, pbResult.alignedPillars + structureBonus);
        estimatedWinProb = pbStats.estimatedWinRate;
        evPerDollar = pbStats.expectedValuePerDollar;
        factors = reasons;
        callLabel = `${pbResult.direction} (${pbLabel}/${calibration.bestProfile.name} · OOS ${pbStats.oosWins}/${oosTotal} ${pbStats.oosWinRate.toFixed(0)}% · Est ${estimatedWinProb.toFixed(1)}% · ${tierBadge})`;
      } else {
        callLabel = `WAIT (${pbLabel}/${calibration.bestProfile.name} · OOS ${pbStats.oosWins}/${oosTotal} ${pbStats.oosWinRate.toFixed(0)}% · ${tierBadge})`;
        factors = [
          `Calibrated [${tierBadge}]: ${pbLabel} (${calibration.bestProfile.name}, ${calibration.recommendedHorizonCandles}c) — waiting for trigger`,
        ];
      }
    } else {
      callLabel = `NO EDGE (${switchReason || 'Failed untouched OOS'})`;
      factors = [switchReason || 'No calibrated edge on this market'];
    }

    return {
      asset,
      isOtc,
      strategyMode,
      activePlaybook: calibration.bestPlaybook,
      playbookLabel: pbLabel,
      activeProfile: calibration.bestProfile,
      recommendedExpirySeconds: calibration.recommendedExpirySeconds,
      calibration,
      calibrationTier: calibration.tier,
      marketRegime,
      indicatorsAtEntry,
      efficiencyRatio,
      atrPercent,
      volatilityState,
      directionCall,
      callLabel,
      estimatedWinProb,
      expectedValuePerDollar: evPerDollar,
      convictionScore: Math.round(estimatedWinProb * 10) / 10,
      alignedPillars,
      totalPillars: 5,
      shouldSwitchPair,
      switchReason,
      factors,
      journalEdgeSummary,
    };
  }
}
