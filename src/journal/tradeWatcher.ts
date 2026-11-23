import { EventEmitter } from 'events';
import { QxWsSniffer } from '../stream/wsSniffer.js';
import { TradingJournalDB } from './database.js';
import { TradeDeal } from '../stream/types.js';
import { TradeRecord, IndicatorSnapshot } from './types.js';
import { isOtcAsset, normalizeAsset } from '../stream/assets.js';

export type MarketRegimeValue = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY';

export interface PendingSignalContext {
  confidence: number;
  reason: string;
  regime: MarketRegimeValue;
  indicators: IndicatorSnapshot;
  createdAt: number;
}

export type LiveContextProvider = (
  asset: string,
  timeframeSeconds: number
) => { regime: MarketRegimeValue; indicators: IndicatorSnapshot } | null;

export class TradeWatcher extends EventEmitter {
  private warnedUnknownMode = false;
  private pendingContextByAsset = new Map<string, PendingSignalContext>();
  private liveContextProvider: LiveContextProvider | null = null;

  constructor(
    private sniffer: QxWsSniffer,
    private db: TradingJournalDB,
    liveContextProvider?: LiveContextProvider
  ) {
    super();
    if (liveContextProvider) {
      this.liveContextProvider = liveContextProvider;
    }
    this.sniffer.on('deal', (deal: TradeDeal) => this.onDeal(deal));
  }

  /**
   * Wires a live candle/indicator context provider so even manual trades taken
   * without a bot signal still record accurate marketRegime and indicatorsAtEntry.
   */
  public setLiveContextProvider(provider: LiveContextProvider): void {
    this.liveContextProvider = provider;
  }

  /**
   * Registers the latest signal context for an asset so that when the deal packet
   * arrives via WebSocket or Redux store polling, its regime and indicator snapshot are stored.
   */
  public setPendingSignalContext(
    asset: string,
    confidence: number,
    reason: string,
    regime: MarketRegimeValue,
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
    // Prefer Quotex's exact per-deal percentProfit when present, then sniffer payout
    const rawPayout = deal.payoutPercent ?? assetPayout?.payoutPercent ?? 80;
    const payoutPercent = TradingJournalDB.sanitizePayoutPercent(rawPayout, deal.amount);
    const isOtc = assetPayout?.isOtc ?? isOtcAsset(normAsset);

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

    const timeframeSeconds = TradingJournalDB.computeTimeframeSeconds(
      deal.openTime,
      deal.closeTime,
      this.sniffer.getActiveTimeframe() || 300
    );

    if (!existing) {
      const pending = this.pendingContextByAsset.get(normAsset);
      const freshContext = pending && Date.now() - pending.createdAt < 120_000 ? pending : undefined;

      // Fallback: compute live regime & indicators directly from CandleAggregator if no pending signal
      const fallbackContext =
        !freshContext && this.liveContextProvider
          ? this.liveContextProvider(normAsset, this.sniffer.getActiveTimeframe() || timeframeSeconds)
          : null;

      const newRecord: TradeRecord = {
        id: deal.id,
        asset: normAsset,
        isOtc,
        direction: deal.direction.toUpperCase() as 'CALL' | 'PUT',
        timeframeSeconds,
        payoutPercent,
        stakeAmount: deal.amount,
        openTime: deal.openTime,
        closeTime: deal.closeTime,
        openPrice: deal.openPrice,
        status: 'OPEN',
        isDemo,
        signalConfidence: freshContext?.confidence,
        signalReason: freshContext?.reason ?? (fallbackContext ? 'Manual / External Entry' : undefined),
        marketRegime: freshContext?.regime ?? fallbackContext?.regime,
        indicatorsAtEntry: freshContext?.indicators ?? fallbackContext?.indicators,
      };

      this.db.recordTrade(newRecord);
      const regimeTag = newRecord.marketRegime ? ` [${newRecord.marketRegime}]` : '';
      console.log(
        `\n[TradeWatcher] Recorded NEW trade: ${newRecord.direction} on ${newRecord.asset} ($${newRecord.stakeAmount}, ${payoutPercent}%)${regimeTag}`
      );
      this.emit('tradeOpened', newRecord);
    }

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
      console.log(
        `\n[TradeWatcher] Trade SETTLED: ID ${deal.id} -> ${finalStatus} (PnL: ${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)})`
      );

      const updated = this.db.getTrade(deal.id);
      if (updated) {
        this.emit('tradeSettled', updated);
      }
    }
  }

  public attachSignalContext(
    dealId: string,
    confidence: number,
    reason: string,
    regime: MarketRegimeValue,
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
