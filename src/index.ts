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
    const tf = sniffer.getActiveTimeframe();
    const have = aggregator.getHistory(asset, tf).length;
    const tfLabel = tf >= 60 ? `M${tf / 60}` : `${tf}s`;
    console.log(
      `\n[Market] Now analysing ${asset}${previous ? ` (was ${previous})` : ''} on ${tfLabel} timeframe. ` +
        `Candles ready: ${have}${have < 8 ? ' (warming up indicators, ready shortly)' : ' (active)'}`
    );
  });

  // Tell the user whenever the timeframe on the chart changes
  sniffer.on('timeframeChanged', ({ timeframe, previous }: { timeframe: number; previous: number }) => {
    const tfLabel = timeframe >= 60 ? `M${timeframe / 60}` : `${timeframe}s`;
    const prevLabel = previous >= 60 ? `M${previous / 60}` : `${previous}s`;
    console.log(`\n[Timeframe] Chart timeframe changed from ${prevLabel} to ${tfLabel}. Adapting analysis cycle.`);
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
    const activeAsset = sniffer.getActiveAsset();
    const isOtc = activeAsset ? activeAsset.endsWith('_OTC') : true;
    const top = payouts
      .filter((p: any) => p.payoutPercent >= 75 && p.isActive && (isOtc ? p.isOtc : true))
      .slice(0, 4)
      .map((p: any) => `${p.asset}: ${p.payoutPercent}%`)
      .join(' | ');
    if (top) {
      lastPayoutLogAt = Date.now();
      console.log(`\n[Payouts] Available High-Payout Pairs: ${top}`);
    }
  });

  // Notify when a candle closes on the active timeframe
  aggregator.on('candleClosed', (candle: any) => {
    const activeTf = sniffer.getActiveTimeframe();
    if (candle.timeframe === activeTf) {
      const tfName = activeTf >= 60 ? `M${activeTf / 60}` : `${activeTf}s`;
      console.log(
        `\n[${tfName} Candle Closed] ${candle.asset} | Open: ${candle.open} | High: ${candle.high} | Low: ${candle.low} | Close: ${candle.close}`
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

  // Active Real-Time Market Analysis Heartbeat (Updates every 2 seconds)
  setInterval(() => {
    const activeTf = sniffer.getActiveTimeframe() || 300;
    const tfLabel = activeTf >= 60 ? `M${activeTf / 60}` : `${activeTf}s`;
    const now = Date.now();
    const cycleMs = activeTf * 1000;
    const nextCandleOpen = Math.ceil(now / cycleMs) * cycleMs;
    const remainingSec = Math.max(0, Math.round((nextCandleOpen - now) / 1000));
    const minStr = Math.floor(remainingSec / 60)
      .toString()
      .padStart(2, '0');
    const secStr = (remainingSec % 60).toString().padStart(2, '0');

    const activeAsset = sniffer.getActiveAsset();
    const mode = sniffer.getAccountMode();
    const balanceInfo = sniffer.getBalance();
    const balFormatted = balanceInfo ? `$${balanceInfo.balance.toFixed(2)}` : '$0.00';
    const modeStr = mode === 'LIVE' ? `LIVE: ${balFormatted}` : mode === 'DEMO' ? `demo: ${balFormatted}` : `??: ${balFormatted}`;

    if (sniffer.totalTicksReceived > 0 && activeAsset) {
      const latestTick = sniffer.getLatestTick(activeAsset);
      const payout = sniffer.getPayout(activeAsset);
      const history = aggregator.getHistory(activeAsset, activeTf);
      const currentCandle = aggregator.getCurrentCandle(activeAsset, activeTf);

      const closes = history.map((c) => c.close);
      if (currentCandle) closes.push(currentCandle.close);

      let rsiStr = '--';
      let stochStr = '--';
      let trendStr = 'RANGING';
      let predictionStr = 'ANALYZING';

      if (closes.length >= 6) {
        const emaFast = TechnicalIndicators.calculateEMA(closes, Math.min(9, closes.length));
        const emaSlow = TechnicalIndicators.calculateEMA(closes, Math.min(21, closes.length));
        const rsi = TechnicalIndicators.calculateRSI(closes, Math.min(14, closes.length));

        const ef = emaFast[emaFast.length - 1];
        const es = emaSlow[emaSlow.length - 1];
        const r = rsi[rsi.length - 1];

        rsiStr = r !== undefined ? r.toFixed(1) : '--';
        const st = TechnicalIndicators.calculateStochastic(
          history.concat(currentCandle ? [currentCandle] : []),
          Math.min(14, closes.length),
          3,
          3
        );
        const kVal = st.k.length > 0 ? st.k[st.k.length - 1] : undefined;
        const dVal = st.d.length > 0 ? st.d[st.d.length - 1] : undefined;
        if (kVal !== undefined) stochStr = kVal.toFixed(0);

        if (ef !== undefined && es !== undefined) {
          trendStr = ef > es ? 'UPTREND' : ef < es ? 'DOWNTREND' : 'RANGING';
        }

        // Live directional prediction (calls out UP / DOWN direction for active candle/expiry)
        if (r !== undefined && kVal !== undefined && dVal !== undefined && ef !== undefined && es !== undefined) {
          if (ef > es && r > 48 && kVal < 80 && kVal > dVal) {
            predictionStr = 'CALL (UP) ⬆';
          } else if (ef < es && r < 52 && kVal > 20 && kVal < dVal) {
            predictionStr = 'PUT (DOWN) ⬇';
          } else if (r > 68 || kVal > 85) {
            predictionStr = 'OVERBOUGHT (Watch PUT)';
          } else if (r < 32 || kVal < 15) {
            predictionStr = 'OVERSOLD (Watch CALL)';
          } else if (ef > es) {
            predictionStr = 'BULLISH BIAS ↗';
          } else if (ef < es) {
            predictionStr = 'BEARISH BIAS ↘';
          } else {
            predictionStr = 'CONSOLIDATING ↔';
          }
        }
      }

      waitingSince = 0;
      status.show(
        `[${modeStr}] ${activeAsset} @ ${latestTick?.price.toFixed(5) || '--'} (${
          payout?.payoutPercent || '--'
        }%) | Next ${tfLabel}: ${minStr}:${secStr} | ${trendStr} | RSI ${rsiStr} | Stoch ${stochStr} | Prediction: ${predictionStr} | Ticks: ${
          sniffer.totalTicksReceived
        }`
      );
    } else {
      const accountLabel = mode === 'LIVE' ? `LIVE (${balFormatted})` : mode === 'DEMO' ? `DEMO (${balFormatted})` : 'connecting';
      const frames = sniffer.totalFramesReceived;
      if (frames === 0) {
        status.show(`[${accountLabel}] Connecting to Quotex... no data yet | Next ${tfLabel}: ${minStr}:${secStr}`);
      } else {
        status.show(
          `[${accountLabel}] Connected (${frames} msgs, ${sniffer.getAllPayouts().length} markets) - awaiting chart | Next ${tfLabel}: ${minStr}:${secStr}`
        );
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
