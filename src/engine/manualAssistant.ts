import { QuotexController } from '../browser/quotexController.js';
import { QxWsSniffer } from '../stream/wsSniffer.js';
import { CandleAggregator } from '../stream/candleAggregator.js';
import { TradingJournalDB } from '../journal/database.js';
import { TradeWatcher } from '../journal/tradeWatcher.js';
import { SignalEngine, PairCalibrationReport, PLAYBOOK_DISPLAY_NAMES } from '../analysis/signalEngine.js';
import { TechnicalIndicators } from '../analysis/indicators.js';
import { VisualChartEngine } from '../analysis/visualChartEngine.js';
import { normalizeAsset } from '../stream/assets.js';
import { StatusLine } from '../ui/statusLine.js';
import { playAlertSound } from '../ui/sound.js';
import { formatClockHHMM, formatPairDisplay } from '../cli/format.js';

interface TrackedSignalCall {
  key: string;
  asset: string;
  displayPair: string;
  direction: 'CALL' | 'PUT';
  timeframeSeconds: number;
  expirySeconds: number;
  entryTimeMs: number;
  expiryTimeMs: number;
  entryClock: string;
  toClock: string;
  entryPrice: number;
  payoutPercent: number;
  estimatedWinProb: number;
}

export interface ManualAssistantDeps {
  db: TradingJournalDB;
  sniffer: QxWsSniffer;
  aggregator: CandleAggregator;
  watcher: TradeWatcher;
  controller: QuotexController;
  brain: SignalEngine;
  visualEngine: VisualChartEngine;
  status: StatusLine;
  allowOtc: boolean;
}

export class ManualAssistant {
  private preCandleTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private calibrationCache = new Map<string, { report: PairCalibrationReport; candleCount: number; updatedAt: number }>();
  private calledCycles = new Set<string>();
  private activeTrackedSignal: TrackedSignalCall | null = null;
  private isEvaluating = false;

  constructor(private deps: ManualAssistantDeps) {}

  /**
   * Cached calibration lookup — fixes the previous 2-second CPU-burning loop that
   * re-ran full walk-forward calibration on every status-line tick!
   */
  private getOrComputeCalibration(
    asset: string,
    tf: number,
    payoutPct: number,
    history: ReturnType<CandleAggregator['getHistory']>
  ): PairCalibrationReport {
    const key = `${normalizeAsset(asset)}_${tf}_${payoutPct}`;
    const cached = this.calibrationCache.get(key);
    const now = Date.now();
    if (cached && cached.candleCount === history.length && now - cached.updatedAt < 5 * 60 * 1000) {
      return cached.report;
    }
    const report = this.deps.brain.calibratePairPlaybook(asset, history, payoutPct, tf);
    this.calibrationCache.set(key, { report, candleCount: history.length, updatedAt: now });
    return report;
  }

  public async start(): Promise<void> {
    const { db, sniffer, aggregator, watcher, controller, brain, visualEngine, status, allowOtc } = this.deps;

    const printCompactMarketSnapshot = async (headerLabel: string) => {
      const asset = sniffer.getActiveAsset();
      if (!asset) return;

      const tf = sniffer.getActiveTimeframe() || 300;
      const tfLabel = QuotexController.formatTimeframe(tf);
      const history = aggregator.getHistory(asset, tf);
      if (history.length < 15) return;

      const visual = visualEngine.analyzeCandles(history);
      const latestTick = sniffer.getLatestTick(asset);
      const price = latestTick?.price ?? history[history.length - 1].close;
      const payoutInfo = sniffer.getPayout(asset);
      const payoutPct = payoutInfo?.payoutPercent ?? 80;
      const displayPair = formatPairDisplay(asset, payoutInfo?.name);
      const isOtc = payoutInfo?.isOtc ?? asset.endsWith('_OTC');
      const balanceInfo = sniffer.getBalance();
      const mode = sniffer.getAccountMode();

      const cal = this.getOrComputeCalibration(asset, tf, payoutPct, history);
      const intel = brain.analyzeAdaptivePairIntelligence(
        asset,
        isOtc,
        history,
        payoutPct,
        visual,
        db.getAllTrades(),
        price,
        tf,
        cal
      );

      const closes = history.map((c) => c.close);
      const rsi = TechnicalIndicators.calculateRSI(closes, intel.activeProfile.rsiPeriod).at(-1) ?? 50;
      if (cal.isTradeable) {
        await controller.configureOnScreenIndicators(cal.bestProfile);
      }

      const expLbl = QuotexController.formatTimeframe(cal.recommendedExpirySeconds);
      const s = cal.bestStats;
      const calText =
        cal.isTradeable && s
          ? `${PLAYBOOK_DISPLAY_NAMES[cal.bestPlaybook]} [${cal.bestProfile.name} · ${expLbl}] — Untouched OOS ${s.oosWins}/${
              s.oosWins + s.oosLosses
            } (${s.oosWinRate.toFixed(1)}%, 95% CI ${s.oosWilsonLow95.toFixed(0)}-${s.oosWilsonHigh95.toFixed(
              0
            )}%) | Shrunk Est ${s.estimatedWinRate.toFixed(1)}% | Tier: ${cal.tier} (${cal.candlesTested}c)`
          : cal.removeReason || 'Warming up history';

      console.log(`\n-------------------------------------------------------`);
      console.log(`  [${headerLabel}] ${displayPair} | Candle TF: ${tfLabel} | Payout: ${payoutPct}%`);
      console.log(
        `  Account     : ${mode} ($${balanceInfo?.balance.toFixed(2) ?? '0.00'}) | Price: ${price.toFixed(5)} | RSI(${
          intel.activeProfile.rsiPeriod
        }): ${rsi.toFixed(1)}`
      );
      console.log(`  Calibration : ${calText}`);
      if (!allowOtc && isOtc) {
        console.log(`  Notice      : OTC signals suppressed (Live-only mode enabled).`);
      } else if (intel.shouldSwitchPair && intel.switchReason) {
        const alts = sniffer.getRecommendedAlternativePairs(asset, 2, allowOtc);
        const altText = alts.map((a) => `${a.label} (${a.payout}%)`).join(' or ');
        console.log(`  Advisor     : ${intel.switchReason}.${altText ? ` Try: ${altText}` : ''}`);
      } else {
        console.log(`  Status      : ${intel.callLabel}`);
      }
      console.log(`-------------------------------------------------------\n`);
    };

    const evaluateForSignal = async (triggerType: 'PRE_CANDLE' | 'CANDLE_OPEN') => {
      if (this.isEvaluating) return;
      const asset = sniffer.getActiveAsset();
      if (!asset) return;
      const isOtc = sniffer.getPayout(asset)?.isOtc ?? asset.endsWith('_OTC');
      if (!allowOtc && isOtc) return;

      const tf = sniffer.getActiveTimeframe() || 300;
      const cycleMs = tf * 1000;
      const now = Date.now();
      const nextBoundaryMs = Math.ceil(now / cycleMs) * cycleMs;
      const nearestBoundaryMs = Math.round(now / cycleMs) * cycleMs;
      const remToNextMs = nextBoundaryMs - now;
      const preWindowMs = Math.min(20000, Math.max(3000, cycleMs * 0.2));
      const openWindowMs = Math.min(12000, Math.max(3000, cycleMs * 0.15));

      let targetEntryMs: number;
      if (triggerType === 'PRE_CANDLE') {
        if (remToNextMs > preWindowMs) return;
        targetEntryMs = nextBoundaryMs;
      } else {
        if (Math.abs(now - nearestBoundaryMs) > openWindowMs) return;
        targetEntryMs = nearestBoundaryMs;
      }

      const cycleKey = `${asset}_${targetEntryMs}_${tf}`;
      if (this.calledCycles.has(cycleKey)) return;

      const history = aggregator.getHistory(asset, tf);
      if (history.length < 70) return;

      this.isEvaluating = true;
      try {
        const currentCandle = aggregator.getCurrentCandle(asset, tf);
        const evalCandles =
          triggerType === 'PRE_CANDLE' && currentCandle && remToNextMs <= 4000
            ? [...history, { ...currentCandle, isClosed: true }]
            : history;

        const latestTick = sniffer.getLatestTick(asset);
        const price = latestTick?.price ?? evalCandles[evalCandles.length - 1].close;
        const payoutInfo = sniffer.getPayout(asset);
        const payoutPct = payoutInfo?.payoutPercent ?? 80;
        const displayPair = formatPairDisplay(asset, payoutInfo?.name);

        const cal = this.getOrComputeCalibration(asset, tf, payoutPct, history);
        const visual = visualEngine.analyzeCandles(evalCandles);
        const intel = brain.analyzeAdaptivePairIntelligence(
          asset,
          isOtc,
          evalCandles,
          payoutPct,
          visual,
          db.getAllTrades(),
          price,
          tf,
          cal
        );

        if (intel.directionCall === 'WAIT') return;

        this.calledCycles.add(cycleKey);
        const optimalExpirySec = intel.recommendedExpirySeconds || tf;
        const optExpLabel = QuotexController.formatTimeframe(optimalExpirySec);
        const targetExpiryMs = targetEntryMs + optimalExpirySec * 1000;
        await controller.syncExpiryToTimeframe(optimalExpirySec);

        watcher.setPendingSignalContext(
          asset,
          intel.estimatedWinProb,
          intel.factors.join(' | '),
          intel.marketRegime,
          intel.indicatorsAtEntry
        );

        const useSec = tf < 60;
        const entryClock = formatClockHHMM(targetEntryMs, useSec);
        const toClock = formatClockHHMM(targetExpiryMs, useSec);
        const isCall = intel.directionCall === 'CALL';
        const color = isCall ? '\x1b[32m' : '\x1b[31m';
        const bold = '\x1b[1m';
        const reset = '\x1b[0m';
        const dirBadge = isCall ? 'CALL [GREEN / UP]' : 'PUT [RED / DOWN]';
        const tierLabel = intel.calibrationTier === 'PROVEN_EDGE' ? 'PROVEN' : 'PRELIMINARY [UNPROVEN]';

        console.log(`\n=======================================================`);
        console.log(`  ${bold}${displayPair}; ${entryClock}; ${color}${dirBadge}${reset}`);
        console.log(`  ${bold}TIME TO ${toClock}${reset}  (${optExpLabel} Expiry | Payout: ${payoutPct}% | ${tierLabel})`);
        console.log(`-------------------------------------------------------`);
        console.log(
          `  ${intel.playbookLabel} [${intel.activeProfile.name}] | Shrunk Est: ${intel.estimatedWinProb.toFixed(
            1
          )}% | EV: ${intel.expectedValuePerDollar >= 0 ? '+' : ''}$${intel.expectedValuePerDollar.toFixed(3)}/$1`
        );
        for (const reason of intel.factors) {
          console.log(`  * ${reason}`);
        }
        console.log(`=======================================================\n`);

        this.activeTrackedSignal = {
          key: cycleKey,
          asset,
          displayPair,
          direction: intel.directionCall,
          timeframeSeconds: tf,
          expirySeconds: optimalExpirySec,
          entryTimeMs: targetEntryMs,
          expiryTimeMs: targetExpiryMs,
          entryClock,
          toClock,
          entryPrice: price,
          payoutPercent: payoutPct,
          estimatedWinProb: intel.estimatedWinProb,
        };

        const spokenPair = displayPair.replace('(OTC)', 'O T C').replace('/', ' ');
        playAlertSound(
          `Signal: ${spokenPair}, ${entryClock}, ${isCall ? 'CALL UP' : 'PUT DOWN'}, Time to ${toClock}`,
          `${displayPair}; ${entryClock}; ${intel.directionCall}`,
          `TIME TO ${toClock} (${optExpLabel} Expiry | Payout: ${payoutPct}% | ${tierLabel})`
        );

        await controller.triggerInBrowserSignalAlert({
          asset,
          displayPair,
          direction: intel.directionCall,
          timeframeSeconds: optimalExpirySec,
          entryTimeStr: entryClock,
          expiryTimeStr: toClock,
          estimatedWinProb: intel.estimatedWinProb,
          expectedValuePerDollar: intel.expectedValuePerDollar,
          tierLabel,
          payoutPercent: payoutPct,
          reasons: intel.factors,
        });
      } catch {
        // Ignore transient navigation errors
      } finally {
        this.isEvaluating = false;
      }
    };

    await printCompactMarketSnapshot('WATCHING MARKET');
    await evaluateForSignal('CANDLE_OPEN');
    await evaluateForSignal('PRE_CANDLE');

    sniffer.on('activeAssetChanged', ({ asset }: { asset: string; previous: string | null }) => {
      setTimeout(async () => {
        await printCompactMarketSnapshot(`SWITCHED TO ${asset}`);
        await evaluateForSignal('CANDLE_OPEN');
        await evaluateForSignal('PRE_CANDLE');
      }, 600);
    });

    sniffer.on('timeframeChanged', ({ timeframe }: { timeframe: number; previous: number }) => {
      const tfLabel = QuotexController.formatTimeframe(timeframe);
      setTimeout(async () => {
        await printCompactMarketSnapshot(`TIMEFRAME SET TO ${tfLabel}`);
        await evaluateForSignal('CANDLE_OPEN');
        await evaluateForSignal('PRE_CANDLE');
      }, 600);
    });

    aggregator.on('candleClosed', (candle: any) => {
      const activeTf = sniffer.getActiveTimeframe();
      const activeAsset = sniffer.getActiveAsset();
      if (!activeAsset || candle.timeframe !== activeTf || normalizeAsset(candle.asset) !== normalizeAsset(activeAsset)) {
        return;
      }

      // Grade tracked multi-candle signal against true `sig.entryPrice` at `sig.expiryTimeMs`!
      if (this.activeTrackedSignal && normalizeAsset(this.activeTrackedSignal.asset) === normalizeAsset(activeAsset)) {
        const sig = this.activeTrackedSignal;
        if (Date.now() >= sig.expiryTimeMs - 3000) {
          const entryP = sig.entryPrice;
          const closeP = candle.close;
          const won = (sig.direction === 'CALL' && closeP > entryP) || (sig.direction === 'PUT' && closeP < entryP);
          const draw = closeP === entryP;

          if (won) {
            console.log(`\n=======================================================`);
            console.log(`  \x1b[42m\x1b[97m SIGNAL WIN \x1b[0m  ${sig.displayPair}; ${sig.entryClock} -> ${sig.toClock}; ${sig.direction}`);
            console.log(`  Entry: ${entryP.toFixed(5)} -> Expiry Close: ${closeP.toFixed(5)}`);
            console.log(`=======================================================\n`);
          } else if (draw) {
            console.log(`\n-------------------------------------------------------`);
            console.log(`  SIGNAL DRAW  ${sig.displayPair}; ${sig.entryClock} -> ${sig.toClock}; ${sig.direction}`);
            console.log(`  Entry: ${entryP.toFixed(5)} -> Expiry Close: ${closeP.toFixed(5)}`);
            console.log(`-------------------------------------------------------\n`);
          } else {
            console.log(`\n-------------------------------------------------------`);
            console.log(`  \x1b[41m\x1b[97m SIGNAL LOSS \x1b[0m  ${sig.displayPair}; ${sig.entryClock} -> ${sig.toClock}; ${sig.direction}`);
            console.log(`  Entry: ${entryP.toFixed(5)} -> Expiry Close: ${closeP.toFixed(5)} (No Martingale)`);
            console.log(`-------------------------------------------------------\n`);
          }
          this.activeTrackedSignal = null;
        }
      }

      setTimeout(() => {
        evaluateForSignal('CANDLE_OPEN').catch(() => {});
      }, 600);
    });

    this.preCandleTimer = setInterval(() => {
      const activeTf = sniffer.getActiveTimeframe() || 300;
      const cycleMs = activeTf * 1000;
      const now = Date.now();
      const nextOpen = Math.ceil(now / cycleMs) * cycleMs;
      const remMs = nextOpen - now;
      const windowMs = Math.min(20000, Math.max(3000, cycleMs * 0.2));

      if (remMs <= windowMs && remMs >= 1500) {
        evaluateForSignal('PRE_CANDLE').catch(() => {});
      }
    }, 2000);

    watcher.on('tradeSettled', (trade) => {
      const tag = trade.status === 'WON' ? '\x1b[32mWON\x1b[0m' : trade.status === 'LOST' ? '\x1b[31mLOST\x1b[0m' : 'DRAW';
      console.log(
        `\n[Account Trade Result] ${trade.asset} (${trade.direction}) -> ${tag} | PnL: ${
          trade.profitLoss && trade.profitLoss >= 0 ? '+' : ''
        }$${trade.profitLoss?.toFixed(2) ?? '0.00'}`
      );
    });

    this.statusTimer = setInterval(() => {
      const activeTf = sniffer.getActiveTimeframe() || 300;
      const tfLabel = QuotexController.formatTimeframe(activeTf);
      const now = Date.now();
      const cycleMs = activeTf * 1000;
      const nextCandleOpen = Math.ceil(now / cycleMs) * cycleMs;
      const remainingSec = Math.max(0, Math.round((nextCandleOpen - now) / 1000));
      const minStr = String(Math.floor(remainingSec / 60)).padStart(2, '0');
      const secStr = String(remainingSec % 60).padStart(2, '0');
      const nextClock = formatClockHHMM(nextCandleOpen, activeTf < 60);

      const activeAsset = sniffer.getActiveAsset();
      const mode = sniffer.getAccountMode();
      const balanceInfo = sniffer.getBalance();
      const balFormatted = balanceInfo ? `$${balanceInfo.balance.toFixed(2)}` : '$0.00';
      const modeStr = mode === 'LIVE' ? `LIVE ${balFormatted}` : mode === 'DEMO' ? `DEMO ${balFormatted}` : `?? ${balFormatted}`;

      if (activeAsset) {
        const latestTick = sniffer.getLatestTick(activeAsset);
        const payout = sniffer.getPayout(activeAsset);
        const displayPair = formatPairDisplay(activeAsset, payout?.name);
        const history = aggregator.getHistory(activeAsset, activeTf);

        if (history.length >= 70) {
          const price = latestTick?.price ?? history[history.length - 1].close;
          const payoutPct = payout?.payoutPercent ?? 80;
          const cachedCal = this.getOrComputeCalibration(activeAsset, activeTf, payoutPct, history);
          const intel = brain.analyzeAdaptivePairIntelligence(
            activeAsset,
            payout?.isOtc ?? activeAsset.endsWith('_OTC'),
            history,
            payoutPct,
            visualEngine.analyzeCandles(history),
            undefined,
            price,
            activeTf,
            cachedCal
          );

          const closes = history.map((c) => c.close);
          const rsi = TechnicalIndicators.calculateRSI(closes, 14).at(-1);
          const rsiStr = rsi !== undefined ? rsi.toFixed(0) : '--';
          status.show(
            `[${modeStr}] ${displayPair} @ ${price.toFixed(5)} (${payout?.payoutPercent || '--'}%) | ${tfLabel} (Next ${nextClock} in ${minStr}:${secStr}) | RSI ${rsiStr} | ${intel.callLabel}`
          );
        } else {
          status.show(
            `[${modeStr}] ${displayPair} (${payout?.payoutPercent || '--'}%) | Archiving ${tfLabel} candles (${history.length}/70)...`
          );
        }
      } else {
        status.show(`[${modeStr}] Connected to Quotex — waiting for active chart...`);
      }
    }, 2000);
  }

  public stop(): void {
    if (this.preCandleTimer) {
      clearInterval(this.preCandleTimer);
      this.preCandleTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }
}
