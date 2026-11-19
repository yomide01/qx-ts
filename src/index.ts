import { launchBrowserSession } from './browser/launcher.js';
import { QxWsSniffer } from './stream/wsSniffer.js';
import { CandleAggregator } from './stream/candleAggregator.js';
import { TradingJournalDB } from './journal/database.js';
import { TradeWatcher } from './journal/tradeWatcher.js';
import { SignalScheduler } from './analysis/signalScheduler.js';
import { SignalPromptUI } from './ui/prompt.js';
import { TradingSignal } from './analysis/signalEngine.js';
import { TechnicalIndicators } from './analysis/indicators.js';

async function bootstrap() {
  console.log('================================================================');
  console.log('       QX TRADING ASSISTANT: SEMI-AUTOMATED TRADING ENGINE      ');
  console.log('================================================================\n');

  // 1. Initialize Database
  const db = new TradingJournalDB();
  console.log('[Init] SQLite Trading Journal connected.');

  // 2. Instantiate WebSocket & CDP Sniffer early
  const sniffer = new QxWsSniffer();

  // 3. Launch Persistent Browser & attach sniffer BEFORE page navigates
  const { context, page } = await launchBrowserSession(async (p) => {
    await sniffer.attachToPage(p);
  });

  // 4. Initialize Candle Aggregator on top of sniffer
  const aggregator = new CandleAggregator(sniffer);

  // 5. Initialize Trade Watcher (Passively listens for deals & updates DB)
  const watcher = new TradeWatcher(sniffer, db);

  // 6. Initialize Signal Scheduler & Interactive UI
  const scheduler = new SignalScheduler(sniffer, aggregator);
  const promptUI = new SignalPromptUI();

  let pendingArmedSignal: TradingSignal | null = null;
  let lastMonitoredAsset = '';

  // Track active streaming asset
  sniffer.on('tick', (tick: any) => {
    lastMonitoredAsset = tick.asset;
  });

  // Notify when payouts update
  sniffer.on('payouts', (payouts: any[]) => {
    const top = payouts
      .filter((p: any) => p.payoutPercent >= 80)
      .slice(0, 4)
      .map((p: any) => `${p.asset}: ${p.payoutPercent}%`)
      .join(' | ');
    if (top) {
      console.log(`\n[Payouts] Available High-Payout Pairs: ${top}`);
    }
  });

  // Notify when a 5M candle closes
  aggregator.on('candleClosed', (candle: any) => {
    if (candle.timeframe === 300) {
      console.log(
        `\n[M5 Candle Closed] ${candle.asset} | Open: ${candle.open} | High: ${candle.high} | Low: ${candle.low} | Close: ${candle.close}`
      );
    }
  });

  // Handle incoming high-probability signals
  scheduler.on('signal', async (signal: TradingSignal) => {
    const decision = await promptUI.promptUser(signal);

    if (decision.confirmed) {
      pendingArmedSignal = signal;
      console.log(`[Armed] Awaiting execution confirmation on Quotex platform...`);
    } else {
      pendingArmedSignal = null;
    }
  });

  // When a deal opens on Quotex, link the armed signal context if present
  watcher.on('tradeOpened', (trade) => {
    if (pendingArmedSignal && pendingArmedSignal.asset === trade.asset) {
      watcher.attachSignalContext(
        trade.id,
        pendingArmedSignal.confidence,
        pendingArmedSignal.reasons.join(' | '),
        pendingArmedSignal.marketRegime,
        pendingArmedSignal.indicatorSnapshot
      );
      console.log(`[TradeWatcher] Linked signal confidence (${pendingArmedSignal.confidence}%) to trade ID ${trade.id}.`);
      pendingArmedSignal = null;
    }
  });

  // When a trade settles
  watcher.on('tradeSettled', (trade) => {
    console.log(
      `\n[Trade Settled] ${trade.asset} (${trade.direction}) -> ${trade.status} | Net PnL: ${
        trade.profitLoss && trade.profitLoss >= 0 ? '+' : ''
      }$${trade.profitLoss?.toFixed(2) ?? '0.00'}`
    );
    console.log(`[Tip] Run 'npm run journal:report' anytime to inspect updated win rates.`);
  });

  console.log('\n[System Active] Engine running. Monitoring ticks, payouts, and M5 candle setups...');
  console.log('[System Active] Keep the Quotex trading tab open. Press Ctrl+C to stop.\n');

  // Active Real-Time Market Analysis Heartbeat (Updates every 3 seconds)
  setInterval(() => {
    const now = Date.now();
    const cycleMs = 300 * 1000;
    const nextCandleOpen = Math.ceil(now / cycleMs) * cycleMs;
    const remainingSec = Math.max(0, Math.round((nextCandleOpen - now) / 1000));
    const elapsedSec = 300 - remainingSec;
    const minStr = Math.floor(remainingSec / 60)
      .toString()
      .padStart(2, '0');
    const secStr = (remainingSec % 60).toString().padStart(2, '0');

    if (sniffer.totalTicksReceived > 0 && lastMonitoredAsset) {
      const latestTick = sniffer.getLatestTick(lastMonitoredAsset);
      const payout = sniffer.getPayout(lastMonitoredAsset);
      const history = aggregator.getHistory(lastMonitoredAsset, 300);
      const currentCandle = aggregator.getCurrentCandle(lastMonitoredAsset, 300);

      const closes = history.map((c) => c.close);
      if (currentCandle) closes.push(currentCandle.close);

      let emaFastStr = '--';
      let emaSlowStr = '--';
      let rsiStr = '--';
      let trendStr = 'RANGING';

      if (closes.length >= 21) {
        const emaFast = TechnicalIndicators.calculateEMA(closes, 9);
        const emaSlow = TechnicalIndicators.calculateEMA(closes, 21);
        const rsi = TechnicalIndicators.calculateRSI(closes, 14);

        const ef = emaFast[emaFast.length - 1];
        const es = emaSlow[emaSlow.length - 1];
        const r = rsi[rsi.length - 1];

        emaFastStr = ef ? ef.toFixed(5) : '--';
        emaSlowStr = es ? es.toFixed(5) : '--';
        rsiStr = r ? r.toFixed(1) : '--';
        trendStr = ef > es ? 'UPTREND' : ef < es ? 'DOWNTREND' : 'RANGING';
      }

      process.stdout.write(
        `\r[LIVE M5 ANALYSIS] ${lastMonitoredAsset} @ ${latestTick?.price.toFixed(5) || '--'} (${
          payout?.payoutPercent || '--'
        }%) | Next Candle: ${minStr}:${secStr} | Trend: ${trendStr} | RSI: ${rsiStr} | Ticks: ${
          sniffer.totalTicksReceived
        } `
      );
    } else {
      process.stdout.write(
        `\r[STREAM ACTIVE] Waiting for active chart ticks... Next 5M candle in: ${minStr}:${secStr} | Total frames: ${sniffer.totalFramesReceived} `
      );
    }
  }, 2000);

  // Clean shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Shutdown] Closing QX Trading Assistant cleanly...');
    db.close();
    await context.close();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
