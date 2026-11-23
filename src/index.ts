import { launchBrowserSession } from './browser/launcher.js';
import { QuotexController } from './browser/quotexController.js';
import { QxWsSniffer } from './stream/wsSniffer.js';
import { CandleAggregator } from './stream/candleAggregator.js';
import { TradingJournalDB } from './journal/database.js';
import { TradeWatcher } from './journal/tradeWatcher.js';
import { SignalEngine } from './analysis/signalEngine.js';
import { TechnicalIndicators } from './analysis/indicators.js';
import { VisualChartEngine } from './analysis/visualChartEngine.js';
import { StatusLine, installCleanConsole } from './ui/statusLine.js';
import { promptStartupConfiguration } from './cli/startupPrompt.js';
import { AutoTrader } from './engine/autoTrader.js';
import { ManualAssistant } from './engine/manualAssistant.js';
import { sleep } from './cli/format.js';

let activeCleanup: (() => Promise<void>) | null = null;

async function bootstrap() {
  const status = new StatusLine();
  installCleanConsole(status);

  console.log('=======================================================');
  console.log('   QX TS: QUOTEX ANALYTICS, MANUAL & AUTO ASSISTANT    ');
  console.log('=======================================================\n');

  const db = new TradingJournalDB();
  const sniffer = new QxWsSniffer();
  // Pass SQLite DB into CandleAggregator so closed candles are persisted automatically for walk-forward & backtesting
  const aggregator = new CandleAggregator(sniffer, db);

  // Wire live regime & indicator provider into TradeWatcher so EVERY trade (manual or auto) records regime & indicators
  const watcher = new TradeWatcher(sniffer, db, (asset, tf) => {
    const history = aggregator.getHistory(asset, tf);
    if (history.length < 25) return null;
    const closes = history.map((c) => c.close);
    const last = history[history.length - 1];
    const emaFast = TechnicalIndicators.calculateEMA(closes, 9).at(-1);
    const emaSlow = TechnicalIndicators.calculateEMA(closes, 21).at(-1);
    const rsi = TechnicalIndicators.calculateRSI(closes, 14).at(-1);
    const atr = TechnicalIndicators.calculateATR(history, 14).at(-1);
    const bb = TechnicalIndicators.calculateBollingerBands(closes, 20, 2);
    const wick = TechnicalIndicators.analyzeCandleWicks(last);
    return {
      regime: TechnicalIndicators.classifyRegime(history),
      indicators: {
        emaFast: emaFast ?? last.close,
        emaSlow: emaSlow ?? last.close,
        rsi: rsi ?? 50,
        atr: atr ?? 0,
        bbUpper: bb?.upper ?? last.close,
        bbLower: bb?.lower ?? last.close,
        bbMiddle: bb?.middle ?? last.close,
        candleWickRatio: Math.max(wick.upperWickRatio, wick.lowerWickRatio),
      },
    };
  });

  const { page, closeBrowser } = await launchBrowserSession(async (p) => {
    await sniffer.attachToPage(p);
  });

  const visualEngine = new VisualChartEngine();
  const controller = new QuotexController(page);
  const brain = new SignalEngine();

  // Allow initial Redux/DOM telemetry to populate account mode, balance, and available markets
  await sleep(1800);

  const startupConfig = await promptStartupConfiguration(controller, sniffer, db);

  const activeInds = await controller.ensureProIndicatorsOnChart();
  if (activeInds.length > 0) {
    console.log(`[Chart Indicators Active] ${activeInds.join(', ')}`);
  }

  sniffer.on('accountChanged', ({ mode, source }: { mode: string; previous: string; source: string }) => {
    const bal = sniffer.getBalance();
    const balStr = bal ? ` ($${bal.balance.toFixed(2)})` : '';
    if (mode === 'LIVE') {
      console.log(`\n\x1b[41m\x1b[97m [ACCOUNT SWITCH] LIVE ACCOUNT ACTIVE${balStr} - REAL MONEY \x1b[0m (${source})`);
    } else if (mode === 'DEMO') {
      console.log(`\n\x1b[42m\x1b[97m [ACCOUNT SWITCH] DEMO ACCOUNT ACTIVE${balStr} \x1b[0m (${source})`);
    }
  });

  let autoTrader: AutoTrader | null = null;
  let manualAssistant: ManualAssistant | null = null;
  let shuttingDown = false;

  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    status.clear();
    autoTrader?.stop();
    manualAssistant?.stop();
    sniffer.stop();
    try {
      db.close();
    } catch {}
    await closeBrowser().catch(() => {});
  };
  activeCleanup = cleanup;

  const handleSignal = async (sig: string) => {
    console.log(`\n[Shutdown] Received ${sig} — closing QX TS cleanly...`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => void handleSignal('SIGINT'));
  process.on('SIGTERM', () => void handleSignal('SIGTERM'));
  process.on('SIGHUP', () => void handleSignal('SIGHUP'));

  if (startupConfig.mode === 'AUTO') {
    autoTrader = new AutoTrader({
      page,
      db,
      sniffer,
      aggregator,
      watcher,
      controller,
      brain,
      visualEngine,
      status,
      limits: startupConfig.limits,
      allowPreliminaryOnLive: startupConfig.allowPreliminaryOnLive,
    });
    await autoTrader.start();
    await cleanup();
  } else {
    manualAssistant = new ManualAssistant({
      db,
      sniffer,
      aggregator,
      watcher,
      controller,
      brain,
      visualEngine,
      status,
      allowOtc: startupConfig.limits.allowOtc,
    });
    await manualAssistant.start();
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('\n[Unhandled Rejection]', reason instanceof Error ? reason.message : reason);
});

process.on('uncaughtException', async (err) => {
  console.error('\n[Fatal Uncaught Exception — Halting safely]', err?.stack || err?.message || err);
  if (activeCleanup) {
    await activeCleanup().catch(() => {});
  }
  process.exit(1);
});

bootstrap().catch(async (err) => {
  console.error('[Fatal Error]', err);
  if (activeCleanup) {
    await activeCleanup().catch(() => {});
  }
  process.exit(1);
});
