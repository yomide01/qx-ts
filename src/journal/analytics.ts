import { TradeRecord, AnalyticsSummary } from './types.js';

export class JournalAnalytics {
  /**
   * Computes comprehensive performance analytics from a list of completed trades.
   */
  public static computeSummary(trades: TradeRecord[]): AnalyticsSummary {
    const closed = trades.filter((t) => t.status !== 'OPEN');
    const totalTrades = closed.length;

    let wonTrades = 0;
    let lostTrades = 0;
    let drawTrades = 0;
    let totalPnL = 0;
    let totalPayout = 0;

    let liveWins = 0;
    let liveTotal = 0;
    let otcWins = 0;
    let otcTotal = 0;

    const byAsset: Record<string, { total: number; wins: number; winRate: number; pnl: number }> = {};
    const byRegime: Record<string, { total: number; wins: number; winRate: number }> = {};

    for (const trade of closed) {
      const pnl = trade.profitLoss ?? 0;
      totalPnL += pnl;
      totalPayout += trade.payoutPercent;

      // Asset stats
      if (!byAsset[trade.asset]) {
        byAsset[trade.asset] = { total: 0, wins: 0, winRate: 0, pnl: 0 };
      }
      byAsset[trade.asset].total++;
      byAsset[trade.asset].pnl += pnl;

      // Regime stats
      const regime = trade.marketRegime || 'UNKNOWN';
      if (!byRegime[regime]) {
        byRegime[regime] = { total: 0, wins: 0, winRate: 0 };
      }
      byRegime[regime].total++;

      // Win/Loss counting
      if (trade.status === 'WON') {
        wonTrades++;
        byAsset[trade.asset].wins++;
        byRegime[regime].wins++;
        if (trade.isOtc) otcWins++;
        else liveWins++;
      } else if (trade.status === 'LOST') {
        lostTrades++;
      } else if (trade.status === 'DRAW') {
        drawTrades++;
      }

      if (trade.isOtc) otcTotal++;
      else liveTotal++;
    }

    // Win rates (excluding draws from denominator for standard binary winrate)
    const effectiveTotal = wonTrades + lostTrades;
    const overallWinRate = effectiveTotal > 0 ? (wonTrades / effectiveTotal) * 100 : 0;
    const liveWinRate = liveTotal > 0 ? (liveWins / liveTotal) * 100 : 0;
    const otcWinRate = otcTotal > 0 ? (otcWins / otcTotal) * 100 : 0;
    const averagePayout = totalTrades > 0 ? totalPayout / totalTrades : 0;

    // Expected Value per 1 unit stake: EV = (P_win * (payout/100)) - (P_loss * 1.0)
    const pWin = effectiveTotal > 0 ? wonTrades / effectiveTotal : 0;
    const pLoss = effectiveTotal > 0 ? lostTrades / effectiveTotal : 0;
    const expectedValue = pWin * (averagePayout / 100) - pLoss * 1.0;

    // Compute winrates per asset & regime
    for (const key of Object.keys(byAsset)) {
      const a = byAsset[key];
      a.winRate = a.total > 0 ? (a.wins / a.total) * 100 : 0;
    }
    for (const key of Object.keys(byRegime)) {
      const r = byRegime[key];
      r.winRate = r.total > 0 ? (r.wins / r.total) * 100 : 0;
    }

    return {
      totalTrades,
      wonTrades,
      lostTrades,
      drawTrades,
      overallWinRate,
      liveWinRate,
      liveTotal,
      otcWinRate,
      otcTotal,
      totalPnL,
      averagePayout,
      expectedValue,
      isMathematicallyProfitable: expectedValue > 0,
      byAsset,
      byRegime,
    };
  }

  /**
   * Calculates the minimum win rate required to break even at a given payout percentage.
   */
  public static calculateBreakevenWinRate(payoutPercent: number): number {
    return (1 / (1 + payoutPercent / 100)) * 100;
  }
}
