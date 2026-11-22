import { launchBrowserSession } from './browser/launcher.js';
import { QxWsSniffer } from './stream/wsSniffer.js';
import { CandleAggregator } from './stream/candleAggregator.js';
import { TradingJournalDB } from './journal/database.js';
import { TradeWatcher } from './journal/tradeWatcher.js';
import { SignalScheduler } from './analysis/signalScheduler.js';
import { SignalPromptUI } from './ui/prompt.js';
import { TradingSignal } from './analysis/signalEngine.js';
import { TechnicalIndicators } from './analysis/indicators.js';
import { normalizeAsset } from './stream/assets.js';
import { StatusLine, installCleanConsole } from './ui/statusLine.js';
import { analyzePriceStructure } from './analysis/marketQuality.js';

async function bootstrap() {
  // One tidy live status line; other messages never get glued onto it
  const status = new StatusLine();
  installCleanConsole(status);

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

  // Tell the user whenever the market on the chart changes
  sniffer.on('activeAssetChanged', ({ asset, previous }: { asset: string; previous: string | null }) => {
    const have = aggregator.getHistory(asset, 300).length;
    console.log(
      `\n[Market] Now analysing ${asset}${previous ? ` (was ${previous})` : ''}. ` +
        `M5 candles ready: ${have}/25${have < 25 ? ' - warming up, signals start once 25 are collected' : ''}`
    );
  });

  // Tell the user whenever the account changes (this is the safety-critical one)
  sniffer.on('accountChanged', ({ mode, previous, source }: { mode: string; previous: string; source: string }) => {
    if (mode === 'LIVE') {
      console.log(`\n\x1b[41m\x1b[97m [Account] LIVE ACCOUNT ACTIVE - REAL MONEY \x1b[0m (detected from ${source})`);
    } else if (mode === 'DEMO') {
      console.log(`\n[Account] DEMO account active (detected from ${source}).`);
    } else if (previous !== 'UNKNOWN') {
      console.log(`\n[Account] Cannot tell which account is open any more. Check Quotex before trading.`);
    }
  });

  // Notify when payouts update (at most once a minute, so the screen stays readable)
  let lastPayoutLogAt = 0;
  sniffer.on('payouts', (payouts: any[]) => {
    if (Date.now() - lastPayoutLogAt < 60000) return;
    const top = payouts
      .filter((p: any) => p.payoutPercent >= 80)
      .slice(0, 4)
      .map((p: any) => `${p.asset}: ${p.payoutPercent}%`)
      .join(' | ');
    if (top) {
      lastPayoutLogAt = Date.now();
      console.log(`[Payouts] Available High-Payout Pairs: ${top}`);
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
    const decision = await promptUI.promptUser(signal, sniffer.getAccountMode());

    if (decision.confirmed) {
      pendingArmedSignal = signal;
      console.log(`[Armed] Awaiting execution confirmation on Quotex platform...`);
    } else {
      pendingArmedSignal = null;
    }
  });

  // When a deal opens on Quotex, link the armed signal context if present
  watcher.on('tradeOpened', (trade) => {
    if (pendingArmedSignal && normalizeAsset(pendingArmedSignal.asset) === normalizeAsset(trade.asset)) {
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

  let waitingSince = 0;
  let hintShown = false;

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

    const activeAsset = sniffer.getActiveAsset();
    const mode = sniffer.getAccountMode();
    const modeStr = mode === 'LIVE' ? 'LIVE!' : mode === 'DEMO' ? 'demo' : '??';

    if (sniffer.totalTicksReceived > 0 && activeAsset) {
      const latestTick = sniffer.getLatestTick(activeAsset);
      const payout = sniffer.getPayout(activeAsset);
      const history = aggregator.getHistory(activeAsset, 300);
      const currentCandle = aggregator.getCurrentCandle(activeAsset, 300);

      const closes = history.map((c) => c.close);
      if (currentCandle) closes.push(currentCandle.close);

      let rsiStr = '--';
      let stochStr = '--';
      let trendStr = 'RANGING';

      if (closes.length >= 21) {
        const emaFast = TechnicalIndicators.calculateEMA(closes, 9);
        const emaSlow = TechnicalIndicators.calculateEMA(closes, 21);
        const rsi = TechnicalIndicators.calculateRSI(closes, 14);

        const ef = emaFast[emaFast.length - 1];
        const es = emaSlow[emaSlow.length - 1];
        const r = rsi[rsi.length - 1];

        rsiStr = r ? r.toFixed(1) : '--';
        const st = TechnicalIndicators.calculateStochastic(history.concat(currentCandle ? [currentCandle] : []), 14, 3, 3);
        if (st.k.length > 0) stochStr = st.k[st.k.length - 1].toFixed(0);
        trendStr = ef > es ? 'UPTREND' : ef < es ? 'DOWNTREND' : 'RANGING';
      }

      const structure = analyzePriceStructure(closes, payout?.payoutPercent ?? 85);
      const structureStr =
        structure.verdict === 'INSUFFICIENT_DATA'
          ? `warming up ${history.length}/25`
          : structure.verdict === 'RANDOM_WALK_LIKE'
            ? 'coin-flip-like'
            : 'some pattern';

      waitingSince = 0;
      status.show(
        `[${modeStr}] ${activeAsset} @ ${latestTick?.price.toFixed(5) || '--'} (${
          payout?.payoutPercent || '--'
        }%) | Next M5: ${minStr}:${secStr} | ${trendStr} | RSI ${rsiStr} | Stoch ${stochStr} | Structure: ${structureStr} | Ticks: ${
          sniffer.totalTicksReceived
        }`
      );
    } else {
      const accountLabel = mode === 'LIVE' ? 'LIVE ACCOUNT' : mode === 'DEMO' ? 'DEMO' : 'account ?';
      const frames = sniffer.totalFramesReceived;
      if (frames === 0) {
        status.show(`[${accountLabel}] Connecting to Quotex... no data yet | Next 5M candle: ${minStr}:${secStr}`);
      } else {
        status.show(
          `[${accountLabel}] Connected (${frames} messages, ${sniffer.getAllPayouts().length} markets) - waiting for a chart | Next 5M candle: ${minStr}:${secStr}`
        );
        // Data is flowing but no prices: almost always the chart has not finished loading
        if (waitingSince === 0) waitingSince = Date.now();
        if (!hintShown && Date.now() - waitingSince > 90000) {
          hintShown = true;
          console.log(
            '[Hint] Connected to Quotex but no prices yet. Prices only flow once a candlestick chart is showing in the Chrome window. ' +
              'If the page is stuck on grey boxes, press F5 in that window or check your internet.'
          );
        }
      }
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
