import { EventEmitter } from 'events';
import { QxWsSniffer } from '../stream/wsSniffer.js';
import { TradingJournalDB } from './database.js';
import { TradeDeal } from '../stream/types.js';
import { TradeRecord, IndicatorSnapshot } from './types.js';
import { isOtcAsset, normalizeAsset } from '../stream/assets.js';

export interface PendingSignalContext {
  confidence: number;
  reason: string;
  regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY';
  indicators: IndicatorSnapshot;
  createdAt: number;
}

export class TradeWatcher extends EventEmitter {
  private warnedUnknownMode = false;
  private pendingContextByAsset = new Map<string, PendingSignalContext>();

  constructor(
    private sniffer: QxWsSniffer,
    private db: TradingJournalDB
  ) {
    super();
    this.sniffer.on('deal', (deal: TradeDeal) => this.onDeal(deal));
  }

  /**
   * Registers the latest signal context for an asset so that when the deal packet
   * arrives via WebSocket or Redux store polling, its regime and indicator snapshot are stored.
   */
  public setPendingSignalContext(
    asset: string,
    confidence: number,
    reason: string,
    regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY',
    indicators: IndicatorSnapshot
  ): void {
    this.pendingContextByAsset.set(normalizeAsset(asset), {
      confidence,
      reason,
      regime,
      indicators,
      createdAt: Date.now(),
    });
  }

  private onDeal(deal: TradeDeal): void {
    const normAsset = normalizeAsset(deal.asset);
    const existing = this.db.getTrade(deal.id);
    const assetPayout = this.sniffer.getPayout(normAsset);
    const rawPayout = assetPayout?.payoutPercent ?? 80;
    const payoutPercent = TradingJournalDB.sanitizePayoutPercent(rawPayout, deal.amount);
    const isOtc = assetPayout?.isOtc ?? isOtcAsset(normAsset);

    // Which account was this trade on? Prefer what Quotex says about the deal itself, then the
    // account the bot currently sees open. Never silently assume demo.
    const mode = this.sniffer.getAccountMode();
    let isDemo: boolean;
    if (deal.isDemo !== undefined) {
      isDemo = deal.isDemo;
    } else if (mode !== 'UNKNOWN') {
      isDemo = mode === 'DEMO';
    } else {
      isDemo = true;
      if (!this.warnedUnknownMode) {
        this.warnedUnknownMode = true;
        console.warn('\n[TradeWatcher] WARNING: cannot tell if you are on Demo or Live. Logging this trade as DEMO.');
      }
    }

    if (!existing) {
      const pending = this.pendingContextByAsset.get(normAsset);
      const freshContext = pending && Date.now() - pending.createdAt < 90_000 ? pending : undefined;

      // New trade opening
      const newRecord: TradeRecord = {
        id: deal.id,
        asset: normAsset,
        isOtc,
        direction: deal.direction.toUpperCase() as 'CALL' | 'PUT',
        timeframeSeconds: TradingJournalDB.computeTimeframeSeconds(deal.openTime, deal.closeTime, 300),
        payoutPercent,
        stakeAmount: deal.amount,
        openTime: deal.openTime,
        closeTime: deal.closeTime,
        openPrice: deal.openPrice,
        status: 'OPEN',
        isDemo,
        signalConfidence: freshContext?.confidence,
        signalReason: freshContext?.reason,
        marketRegime: freshContext?.regime,
        indicatorsAtEntry: freshContext?.indicators,
      };

      this.db.recordTrade(newRecord);
      console.log(`\n[TradeWatcher] Recorded NEW trade: ${newRecord.direction} on ${newRecord.asset} ($${newRecord.stakeAmount})`);
      this.emit('tradeOpened', newRecord);
    }

    // Check if the deal has genuinely completed/settled (and hasn't already been settled)
    if (deal.status !== 'open' && (!existing || existing.status === 'OPEN')) {
      const statusMap = {
        won: 'WON' as const,
        lost: 'LOST' as const,
        draw: 'DRAW' as const,
      };
      const finalStatus = statusMap[deal.status] || 'DRAW';
      let profitLoss = 0;

      if (finalStatus === 'WON') {
        profitLoss = deal.profit !== undefined ? deal.profit : deal.amount * (payoutPercent / 100);
      } else if (finalStatus === 'LOST') {
        profitLoss = -Math.abs(deal.amount);
      } else {
        profitLoss = 0;
      }

      this.db.updateTradeOutcome(deal.id, deal.closePrice ?? deal.openPrice, profitLoss, finalStatus);
      console.log(`\n[TradeWatcher] Trade SETTLED: ID ${deal.id} -> ${finalStatus} (PnL: ${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)})`);

      const updated = this.db.getTrade(deal.id);
      if (updated) {
        this.emit('tradeSettled', updated);
      }
    }
  }

  /**
   * Allows attaching signal engine metadata to a pending or just-opened trade
   */
  public attachSignalContext(
    dealId: string,
    confidence: number,
    reason: string,
    regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY',
    indicators: IndicatorSnapshot
  ): void {
    const trade = this.db.getTrade(dealId);
    if (trade) {
      trade.signalConfidence = confidence;
      trade.signalReason = reason;
      trade.marketRegime = regime;
      trade.indicatorsAtEntry = indicators;
      this.db.recordTrade(trade);
    }
  }
}
