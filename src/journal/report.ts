import { TradingJournalDB } from './database.js';
import { JournalAnalytics } from './analytics.js';
import { edgeVerdict } from '../analysis/binaryMath.js';
import { evaluateLiveReadiness } from '../engine/riskManager.js';

function printAccountBlock(label: string, trades: ReturnType<TradingJournalDB['getAllTrades']>) {
  if (trades.length === 0) return;
  const summary = JournalAnalytics.computeSummary(trades);
  const breakeven = JournalAnalytics.calculateBreakevenWinRate(summary.averagePayout || 85);
  console.log(`--- ${label} ---`);
  console.log(
    `• Trades: ${summary.totalTrades} (${summary.wonTrades}W - ${summary.lostTrades}L - ${summary.drawTrades}D) | WR: ${summary.overallWinRate.toFixed(
      1
    )}% vs ${breakeven.toFixed(1)}% BE`
  );
  console.log(
    `• Net PnL: ${summary.totalPnL >= 0 ? '+' : ''}$${summary.totalPnL.toFixed(2)} | Avg Payout: ${summary.averagePayout.toFixed(
      1
    )}% | EV: ${summary.expectedValue >= 0 ? '+' : ''}${(summary.expectedValue * 100).toFixed(2)}% / trade`
  );
}

function generateReport() {
  console.log('================================================================');
  console.log('            QUOTEX TRADING PERFORMANCE & ANALYTICS REPORT        ');
  console.log('================================================================\n');

  const db = new TradingJournalDB();
  const trades = db.getAllTrades();
  const candleSeries = db.listCandleSeries();

  if (trades.length === 0) {
    console.log('[Notice] No trade history recorded in database yet.');
    console.log('[Notice] Trades will automatically record as you trade with the bot running.\n');
  } else {
    const summary = JournalAnalytics.computeSummary(trades);
    const breakeven = JournalAnalytics.calculateBreakevenWinRate(summary.averagePayout || 85);

    console.log(`Total Trades Recorded : ${summary.totalTrades}`);
    console.log(`Wins                  : ${summary.wonTrades}`);
    console.log(`Losses                : ${summary.lostTrades}`);
    console.log(`Draws                 : ${summary.drawTrades}`);
    console.log(`----------------------------------------------------------------`);
    console.log(`Overall Win Rate      : ${summary.overallWinRate.toFixed(1)}% (Breakeven required: ~${breakeven.toFixed(1)}%)`);
    console.log(`Live Pairs Win Rate   : ${summary.liveTotal > 0 ? `${summary.liveWinRate.toFixed(1)}% (${summary.liveTotal} trades)` : 'No live-market trades'}`);
    console.log(`OTC Pairs Win Rate    : ${summary.otcTotal > 0 ? `${summary.otcWinRate.toFixed(1)}% (${summary.otcTotal} trades)` : 'No OTC trades'}`);
    console.log(`Average Payout        : ${summary.averagePayout.toFixed(1)}%`);
    console.log(`Total Net PnL         : ${summary.totalPnL >= 0 ? '+' : ''}$${summary.totalPnL.toFixed(2)}`);
    console.log(`Expected Value (EV)   : ${summary.expectedValue >= 0 ? '+' : ''}${(summary.expectedValue * 100).toFixed(2)}% per trade`);
    console.log(
      `Mathematical Edge     : ${
        summary.isMathematicallyProfitable
          ? '✓ POSITIVE SAMPLE EV (Check statistical significance below)'
          : '✗ NEGATIVE EV (Losing expectation)'
      }`
    );
    console.log(`----------------------------------------------------------------\n`);

    console.log('--- PERFORMANCE BY ASSET ---');
    for (const [asset, stat] of Object.entries(summary.byAsset)) {
      console.log(
        `• ${asset.padEnd(14)}: ${stat.wins}/${stat.total} (${stat.winRate.toFixed(1)}% Win) | PnL: ${
          stat.pnl >= 0 ? '+' : ''
        }$${stat.pnl.toFixed(2)}`
      );
    }

    console.log('\n--- PERFORMANCE BY MARKET REGIME ---');
    for (const [regime, stat] of Object.entries(summary.byRegime)) {
      console.log(`• ${regime.padEnd(20)}: ${stat.wins}/${stat.total} (${stat.winRate.toFixed(1)}% Win)`);
    }

    console.log('\n--- RECOMMENDATIONS ---');
    if (summary.totalTrades < 30) {
      console.log('• Sample size is small (< 30 trades). Do not draw conclusions from small samples.');
    } else {
      if (summary.otcTotal > 0 && summary.otcWinRate < breakeven) {
        console.log(
          `• CAUTION: OTC win rate (${summary.otcWinRate.toFixed(1)}%) is below breakeven (${breakeven.toFixed(1)}%). Consider disabling OTC.`
        );
      }
      if (summary.liveTotal >= 30 && summary.liveWinRate >= breakeven) {
        console.log(
          `• Live-market pairs are ${(summary.liveWinRate - breakeven).toFixed(1)}pp above breakeven on ${summary.liveTotal} trades.`
        );
      }
    }

    console.log('\n--- IS THERE A REAL EDGE? (statistics, not hope) ---');
    const verdict = edgeVerdict(summary.wonTrades, summary.wonTrades + summary.lostTrades, summary.averagePayout || 85);
    console.log(`• ${verdict.message}`);
    if (verdict.verdict === 'PROVEN_EDGE') {
      console.log('• Edge clears 95% lower bound on this sample. Verify it holds on new forward trades.');
    } else if (verdict.verdict === 'LIKELY_LOSING') {
      console.log('• Stop and rethink the strategy. Trading real money is expected to lose.');
    } else {
      console.log('• Keep logging demo trades. Judging a strategy takes hundreds of trades, not dozens.');
    }

    const closedTrades = trades.filter((t) => t.status !== 'OPEN');
    const demoTrades = closedTrades.filter((t) => t.isDemo);
    const liveTrades = closedTrades.filter((t) => !t.isDemo);
    console.log('');
    printAccountBlock('DEMO ACCOUNT', demoTrades);
    printAccountBlock('LIVE ACCOUNT', liveTrades);

    const readiness = evaluateLiveReadiness(trades);
    console.log('\n--- LIVE AUTO-TRADING READINESS GATE ---');
    console.log(`• Status: ${readiness.ready ? 'READY' : 'BLOCKED'} — ${readiness.reason}`);
  }

  console.log('\n--- ARCHIVED CANDLE HISTORY (for npm run backtest) ---');
  if (candleSeries.length === 0) {
    console.log('• No closed candles archived yet. Run the bot or `npm run backtest -- --pull-chrome` to collect data.');
  } else {
    for (const s of candleSeries.slice(0, 12)) {
      console.log(`• ${s.asset.padEnd(14)} ${String(s.timeframe).padStart(4)}s : ${s.count} closed candles`);
    }
    if (candleSeries.length > 12) {
      console.log(`• ... and ${candleSeries.length - 12} more series`);
    }
  }

  console.log('\n================================================================\n');
  db.close();
}

generateReport();
