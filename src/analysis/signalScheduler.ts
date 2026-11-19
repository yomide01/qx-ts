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

    // Evaluate on every M5 candle close
    this.aggregator.on('candleClosed', (candle) => {
      if (candle.timeframe === 300) {
        this.evaluateAsset(candle.asset, candle.openTime + 300000);
      }
    });

    // Also run an evaluation check 30 seconds prior to candle boundaries
    setInterval(() => this.checkPreCandleScans(), 10000);
  }

  private checkPreCandleScans(): void {
    const now = Date.now();
    const cycleMs = 300 * 1000;
    const nextCandleOpen = Math.ceil(now / cycleMs) * cycleMs;
    const timeUntilOpen = nextCandleOpen - now;

    // Within 45 seconds of candle open
    if (timeUntilOpen <= 45000 && timeUntilOpen >= 5000) {
      const payouts = this.sniffer.getAllPayouts();
      for (const p of payouts) {
        if (p.payoutPercent >= this.engine.minPayoutPercent && p.isActive) {
          this.evaluateAsset(p.asset, nextCandleOpen);
        }
      }
    }
  }

  private evaluateAsset(asset: string, targetEntryTime: number): void {
    const key = `${asset}_${targetEntryTime}`;
    if (this.lastEvaluatedCycle.has(key)) {
      return; // Already evaluated this asset for this cycle
    }

    const history = this.aggregator.getHistory(asset, 300);
    const payout = this.sniffer.getPayout(asset);
    const payoutPercent = payout?.payoutPercent ?? 80;
    const isOtc = payout?.isOtc ?? asset.toLowerCase().includes('otc');

    const signal = this.engine.evaluateSetup(
      asset,
      isOtc,
      history,
      payoutPercent,
      targetEntryTime
    );

    this.lastEvaluatedCycle.set(key, Date.now());

    if (signal) {
      console.log(`\n================== [SIGNAL DETECTED] ==================`);
      console.log(`Asset      : ${signal.asset} (${signal.isOtc ? 'OTC' : 'Live'})`);
      console.log(`Direction  : ${signal.direction} (${signal.direction === 'CALL' ? 'GREEN / UP' : 'RED / DOWN'})`);
      console.log(`Entry Time : ${new Date(signal.entryTime).toLocaleTimeString()}`);
      console.log(`Expiry     : ${new Date(signal.expiryTime).toLocaleTimeString()} (5M)`);
      console.log(`Confidence : ${signal.confidence}%`);
      console.log(`Payout     : ${signal.payoutPercent}%`);
      console.log(`Reasons    : ${signal.reasons.join(' | ')}`);
      console.log(`=======================================================\n`);

      this.emit('signal', signal);
    }
  }
}
