import { EventEmitter } from 'events';
import { QxWsSniffer } from '../stream/wsSniffer.js';
import { TradingJournalDB } from './database.js';
import { TradeDeal } from '../stream/types.js';
import { TradeRecord, IndicatorSnapshot } from './types.js';
import { isOtcAsset } from '../stream/assets.js';

export class TradeWatcher extends EventEmitter {
  private warnedUnknownMode = false;

  constructor(
    private sniffer: QxWsSniffer,
    private db: TradingJournalDB
  ) {
    super();
    this.sniffer.on('deal', (deal: TradeDeal) => this.onDeal(deal));
  }

  private onDeal(deal: TradeDeal): void {
    const existing = this.db.getTrade(deal.id);
    const assetPayout = this.sniffer.getPayout(deal.asset);
    const payoutPercent = assetPayout?.payoutPercent ?? 80;
    const isOtc = assetPayout?.isOtc ?? isOtcAsset(deal.asset);

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
      // New trade opening
      const newRecord: TradeRecord = {
        id: deal.id,
        asset: deal.asset,
        isOtc,
        direction: deal.direction.toUpperCase() as 'CALL' | 'PUT',
        timeframeSeconds: deal.closeTime > deal.openTime ? Math.round((deal.closeTime - deal.openTime) / 1000) : 300,
        payoutPercent,
        stakeAmount: deal.amount,
        openTime: deal.openTime,
        closeTime: deal.closeTime,
        openPrice: deal.openPrice,
        status: 'OPEN',
        isDemo,
      };

      this.db.recordTrade(newRecord);
      console.log(`\n[TradeWatcher] Recorded NEW trade: ${newRecord.direction} on ${newRecord.asset} ($${newRecord.stakeAmount})`);
      this.emit('tradeOpened', newRecord);
    }

    // Check if the deal has completed/settled
    if (deal.status !== 'open') {
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
