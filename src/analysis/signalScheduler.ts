import { EventEmitter } from 'events';
import { QxWsSniffer } from '../stream/wsSniffer.js';
import { CandleAggregator } from '../stream/candleAggregator.js';
import { SignalEngine, TradingSignal } from './signalEngine.js';

export class SignalScheduler extends EventEmitter {
  private engine: SignalEngine;
  private lastEvaluatedCycle: Map<string, number> = new Map();

  constructor(
    private sniffer: QxWsSniffer,
    private aggregator: CandleAggregator
  ) {
    super();
    this.engine = new SignalEngine();

    // Evaluate on every candle close that matches the active chart timeframe
    this.aggregator.on('candleClosed', (candle) => {
      const activeTf = this.sniffer.getActiveTimeframe();
      if (candle.timeframe === activeTf) {
        this.evaluateAsset(candle.asset, candle.openTime + activeTf * 1000, activeTf);
      }
    });

    // Also run an evaluation check prior to candle boundaries (every 3 seconds)
    setInterval(() => this.checkPreCandleScans(), 3000);
  }

  private checkPreCandleScans(): void {
    const now = Date.now();
    const activeTf = this.sniffer.getActiveTimeframe();
    const cycleMs = activeTf * 1000;
    const nextCandleOpen = Math.ceil(now / cycleMs) * cycleMs;
    const timeUntilOpen = nextCandleOpen - now;

    // Scan window: 15-45 seconds prior to next candle (or proportional for short candles)
    const scanThreshold = Math.min(45000, Math.max(5000, cycleMs * 0.3));
    if (timeUntilOpen <= scanThreshold && timeUntilOpen >= 2000) {
      const activeAsset = this.sniffer.getActiveAsset();
      if (activeAsset) {
        this.evaluateAsset(activeAsset, nextCandleOpen, activeTf);
      }
    }
  }

  private evaluateAsset(asset: string, targetEntryTime: number, timeframeSeconds?: number): void {
    const tf = timeframeSeconds || this.sniffer.getActiveTimeframe();
    const key = `${asset}_${targetEntryTime}_${tf}`;
    if (this.lastEvaluatedCycle.has(key)) {
      return; // Already evaluated this asset for this cycle
    }

    const history = this.aggregator.getHistory(asset, tf);
    const payout = this.sniffer.getPayout(asset);
    const payoutPercent = payout?.payoutPercent ?? 80;
    const isOtc = payout?.isOtc ?? asset.toLowerCase().includes('otc');

    const signal = this.engine.evaluateSetup(
      asset,
      isOtc,
      history,
      payoutPercent,
      targetEntryTime,
      tf
    );

    this.lastEvaluatedCycle.set(key, Date.now());

    if (signal) {
      const tfLabel = tf >= 60 ? `${tf / 60}M` : `${tf}s`;
      console.log(`\n================== [SIGNAL DETECTED] ==================`);
      console.log(`Asset      : ${signal.asset} (${signal.isOtc ? 'OTC' : 'Live'})`);
      console.log(`Direction  : ${signal.direction} (${signal.direction === 'CALL' ? 'GREEN / UP' : 'RED / DOWN'})`);
      console.log(`Entry Time : ${new Date(signal.entryTime).toLocaleTimeString()}`);
      console.log(`Expiry     : ${new Date(signal.expiryTime).toLocaleTimeString()} (${tfLabel})`);
      console.log(`Confidence : ${signal.confidence}%`);
      console.log(`Payout     : ${signal.payoutPercent}%`);
      console.log(`Reasons    : ${signal.reasons.join(' | ')}`);
      console.log(`=======================================================\n`);

      this.emit('signal', signal);
    }
  }
}
