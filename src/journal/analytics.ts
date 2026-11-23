import { TradeRecord, AnalyticsSummary } from './types.js';
import { TradingJournalDB } from './database.js';

export class JournalAnalytics {
  /**
   * Computes performance analytics from a list of completed trades.
   * All win rates consistently exclude DRAWs from the denominator.
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
    let liveDecided = 0;
    let otcWins = 0;
    let otcDecided = 0;

    const byAsset: Record<string, { total: number; decided: number; wins: number; winRate: number; pnl: number }> = {};
    const byRegime: Record<string, { total: number; decided: number; wins: number; winRate: number }> = {};

    for (const trade of closed) {
      const pnl = trade.profitLoss ?? 0;
      const cleanPayout = TradingJournalDB.sanitizePayoutPercent(trade.payoutPercent, trade.stakeAmount);
      totalPnL += pnl;
      totalPayout += cleanPayout;

      if (!byAsset[trade.asset]) {
        byAsset[trade.asset] = { total: 0, decided: 0, wins: 0, winRate: 0, pnl: 0 };
      }
      byAsset[trade.asset].total++;
      byAsset[trade.asset].pnl += pnl;

      const regime = trade.marketRegime || 'UNRECORDED (legacy)';
      if (!byRegime[regime]) {
        byRegime[regime] = { total: 0, decided: 0, wins: 0, winRate: 0 };
      }
      byRegime[regime].total++;

      if (trade.status === 'WON') {
        wonTrades++;
        byAsset[trade.asset].wins++;
        byAsset[trade.asset].decided++;
        byRegime[regime].wins++;
        byRegime[regime].decided++;
        if (trade.isOtc) {
          otcWins++;
          otcDecided++;
        } else {
          liveWins++;
          liveDecided++;
        }
      } else if (trade.status === 'LOST') {
        lostTrades++;
        byAsset[trade.asset].decided++;
        byRegime[regime].decided++;
        if (trade.isOtc) otcDecided++;
        else liveDecided++;
      } else if (trade.status === 'DRAW') {
        drawTrades++;
      }
    }

    const effectiveTotal = wonTrades + lostTrades;
    const overallWinRate = effectiveTotal > 0 ? (wonTrades / effectiveTotal) * 100 : 0;
    const liveWinRate = liveDecided > 0 ? (liveWins / liveDecided) * 100 : 0;
    const otcWinRate = otcDecided > 0 ? (otcWins / otcDecided) * 100 : 0;
    const averagePayout = totalTrades > 0 ? totalPayout / totalTrades : 0;

    const pWin = effectiveTotal > 0 ? wonTrades / effectiveTotal : 0;
    const pLoss = effectiveTotal > 0 ? lostTrades / effectiveTotal : 0;
    const expectedValue = pWin * (averagePayout / 100) - pLoss * 1.0;

    const cleanByAsset: AnalyticsSummary['byAsset'] = {};
    for (const key of Object.keys(byAsset)) {
      const a = byAsset[key];
      cleanByAsset[key] = {
        total: a.total,
        wins: a.wins,
        winRate: a.decided > 0 ? (a.wins / a.decided) * 100 : 0,
        pnl: a.pnl,
      };
    }

    const cleanByRegime: AnalyticsSummary['byRegime'] = {};
    for (const key of Object.keys(byRegime)) {
      const r = byRegime[key];
      cleanByRegime[key] = {
        total: r.total,
        wins: r.wins,
        winRate: r.decided > 0 ? (r.wins / r.decided) * 100 : 0,
      };
    }

    return {
      totalTrades,
      wonTrades,
      lostTrades,
      drawTrades,
      overallWinRate,
      liveWinRate,
      liveTotal: liveDecided,
      otcWinRate,
      otcTotal: otcDecided,
      totalPnL,
      averagePayout,
      expectedValue,
      isMathematicallyProfitable: expectedValue > 0,
      byAsset: cleanByAsset,
      byRegime: cleanByRegime,
    };
  }

  public static calculateBreakevenWinRate(payoutPercent: number): number {
    return (1 / (1 + payoutPercent / 100)) * 100;
  }
}
