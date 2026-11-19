import { TradingJournalDB } from './database.js';
import { JournalAnalytics } from './analytics.js';

function generateReport() {
  console.log('================================================================');
  console.log('            QUOTEX TRADING PERFORMANCE & ANALYTICS REPORT        ');
  console.log('================================================================\n');

  const db = new TradingJournalDB();
  const trades = db.getAllTrades();

  if (trades.length === 0) {
    console.log('[Notice] No trade history recorded in database yet.');
    console.log('[Notice] Trades will automatically record as you trade with the bot running.\n');
    return;
  }

  const summary = JournalAnalytics.computeSummary(trades);
  const breakeven = JournalAnalytics.calculateBreakevenWinRate(summary.averagePayout || 85);

  console.log(`Total Trades Recorded : ${summary.totalTrades}`);
  console.log(`Wins                  : ${summary.wonTrades}`);
  console.log(`Losses                : ${summary.lostTrades}`);
  console.log(`Draws                 : ${summary.drawTrades}`);
  console.log(`----------------------------------------------------------------`);
  console.log(`Overall Win Rate      : ${summary.overallWinRate.toFixed(1)}% (Breakeven required: ~${breakeven.toFixed(1)}%)`);
  console.log(`Live Pairs Win Rate   : ${summary.liveWinRate.toFixed(1)}%`);
  console.log(`OTC Pairs Win Rate    : ${summary.otcWinRate.toFixed(1)}%`);
  console.log(`Average Payout        : ${summary.averagePayout.toFixed(1)}%`);
  console.log(`Total Net PnL         : ${summary.totalPnL >= 0 ? '+' : ''}$${summary.totalPnL.toFixed(2)}`);
  console.log(`Expected Value (EV)   : ${summary.expectedValue >= 0 ? '+' : ''}${(summary.expectedValue * 100).toFixed(2)}% per trade`);
  console.log(
    `Mathematical Edge     : ${
      summary.isMathematicallyProfitable
        ? '✓ POSITIVE EDGE (Profitable)'
        : '✗ NEGATIVE EV (Requires tuning)'
    }`
  );
  console.log(`----------------------------------------------------------------\n`);

  // Asset Breakdown
  console.log('--- PERFORMANCE BY ASSET ---');
  for (const [asset, stat] of Object.entries(summary.byAsset)) {
    console.log(
      `• ${asset.padEnd(14)}: ${stat.wins}/${stat.total} (${stat.winRate.toFixed(1)}% Win) | PnL: ${
        stat.pnl >= 0 ? '+' : ''
      }$${stat.pnl.toFixed(2)}`
    );
  }

  // Regime Breakdown
  console.log('\n--- PERFORMANCE BY MARKET REGIME ---');
  for (const [regime, stat] of Object.entries(summary.byRegime)) {
    console.log(
      `• ${regime.padEnd(16)}: ${stat.wins}/${stat.total} (${stat.winRate.toFixed(1)}% Win)`
    );
  }

  // Self-Learning Recommendations
  console.log('\n--- SELF-LEARNING RECOMMENDATIONS ---');
  if (summary.totalTrades < 10) {
    console.log('• Sample size is small (< 10 trades). Continue logging to build statistical confidence.');
  } else {
    if (summary.otcTotal > 0 && summary.otcWinRate < breakeven) {
      console.log(`• CAUTION: OTC win rate (${summary.otcWinRate.toFixed(1)}%) is below breakeven (${breakeven.toFixed(1)}%). Consider restricting bot to Live market hours.`);
    }
    if (summary.liveWinRate >= breakeven) {
      console.log(`• STRENGTH: Live market pairs are achieving ${(summary.liveWinRate - breakeven).toFixed(1)}% above breakeven threshold.`);
    }
  }

  console.log('================================================================\n');
  db.close();
}

generateReport();
