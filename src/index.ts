import readline from 'readline';
import { launchBrowserSession } from './browser/launcher.js';
import { QuotexController, OpenMarketTab } from './browser/quotexController.js';
import { QxWsSniffer } from './stream/wsSniffer.js';
import { CandleAggregator } from './stream/candleAggregator.js';
import { TradingJournalDB } from './journal/database.js';
import { TradeWatcher } from './journal/tradeWatcher.js';
import { SignalEngine, PairCalibrationReport } from './analysis/signalEngine.js';
import { TechnicalIndicators } from './analysis/indicators.js';
import { VisualChartEngine } from './analysis/visualChartEngine.js';
import { normalizeAsset } from './stream/assets.js';
import { StatusLine, installCleanConsole } from './ui/statusLine.js';
import { playAlertSound } from './ui/sound.js';

type BotOperatingMode = 'MANUAL' | 'AUTO';
type TargetAccountType = 'DEMO' | 'LIVE';

interface StartupConfig {
  accountType: TargetAccountType;
  mode: BotOperatingMode;
  stakeAmount: number;
  profitGoal: number;
}

interface TrackedSignalCall {
  key: string;
  asset: string;
  displayPair: string;
  direction: 'CALL' | 'PUT';
  timeframeSeconds: number;
  entryTimeMs: number;
  expiryTimeMs: number;
  entryClock: string;
  toClock: string;
  entryPrice: number;
  payoutPercent: number;
  confidence: number;
}

function formatClockHHMM(timestampMs: number, includeSeconds: boolean = false): string {
  const d = new Date(timestampMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!includeSeconds) return `${hh}:${mm}`;
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatPairDisplay(asset: string, rawName?: string): string {
  if (rawName && rawName.includes('/')) return rawName;
  const isOtc = asset.endsWith('_OTC');
  const base = asset.replace(/_OTC$/i, '');
  if (base.length === 6) {
    return `${base.slice(0, 3)}/${base.slice(3)}${isOtc ? ' (OTC)' : ''}`;
  }
  return isOtc ? `${base} (OTC)` : base;
}

function askQuestion(rl: readline.Interface, promptText: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      resolve((answer || '').trim());
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function promptStartupConfiguration(
  controller: QuotexController,
  sniffer: QxWsSniffer
): Promise<StartupConfig> {
  const profitGoal = process.env.AUTO_PROFIT_GOAL ? Number(process.env.AUTO_PROFIT_GOAL) : 1000;

  // Non-interactive env support for automated testing
  const envMode = (process.env.BOT_MODE || '').trim().toUpperCase();
  const envAcc = (process.env.BOT_ACCOUNT || '').trim().toUpperCase() as TargetAccountType | '';
  if (envMode === 'MANUAL' || envMode === 'AUTO') {
    const accountType: TargetAccountType = envAcc === 'LIVE' ? 'LIVE' : 'DEMO';
    await controller.switchAccountMode(accountType);
    await sleep(1200);
    const bal = sniffer.getBalance()?.balance ?? 0;
    const stake = Math.max(1, Number(process.env.AUTO_STAKE || 10));
    return { mode: envMode, accountType, stakeAmount: stake, profitGoal };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const currentMode = sniffer.getAccountMode();
    const currentBal = sniffer.getBalance()?.balance ?? 0;

    // ── STEP 1: Ask DEMO or LIVE Account (Applies to BOTH Manual and Automatic Modes) ──
    console.log(`\n=======================================================`);
    console.log(`  STEP 1: SELECT QUOTEX ACCOUNT (DEMO vs LIVE)`);
    console.log(`=======================================================`);
    console.log(`  Currently Open : ${currentMode} Account (Balance: $${currentBal.toFixed(2)})`);
    console.log(`  [1] DEMO       : Practice balance (switches to or stays in Demo)`);
    console.log(`  [2] LIVE       : Real money balance (switches Chrome to Live Account)`);
    console.log(`-------------------------------------------------------`);

    let accountType: TargetAccountType = 'DEMO';
    while (true) {
      const accInput = (
        await askQuestion(rl, `Choose Account — Enter [1] for DEMO or [2] for LIVE: `)
      ).toLowerCase();
      if (accInput === '1' || accInput === 'demo' || accInput === 'd') {
        accountType = 'DEMO';
        break;
      }
      if (accInput === '2' || accInput === 'live' || accInput === 'l' || accInput === 'real') {
        accountType = 'LIVE';
        break;
      }
      console.log(`  Please enter 1 (Demo) or 2 (Live).`);
    }

    if (accountType !== currentMode) {
      console.log(`\n[Account Switch] Switching Quotex Chrome window to ${accountType} Account...`);
      const switched = await controller.switchAccountMode(accountType);
      await sleep(1500);
      if (switched) {
        console.log(`[Account Switch] ✅ Now active on ${accountType} Account.`);
      } else {
        console.log(`[Account Switch] ⚠️ Could not verify switch automatically — please confirm ${accountType} is selected in Chrome.`);
      }
    } else {
      console.log(`\n[Account] Staying on ${accountType} Account.`);
    }

    const activeBalance = sniffer.getBalance()?.balance ?? currentBal;

    // ── STEP 2: Ask MANUAL or AUTOMATIC Trading Mode ──
    console.log(`\n=======================================================`);
    console.log(`  STEP 2: SELECT BOT OPERATING MODE`);
    console.log(`=======================================================`);
    console.log(`  Active Account    : ${accountType} Account (Balance: $${activeBalance.toFixed(2)})`);
    console.log(`  [1] MANUAL        : Calmly analyze & give Telegram-style Signal Calls only`);
    console.log(`  [2] AUTOMATIC     : Open & self-calibrate markets, auto-remove bad/low-payout`);
    console.log(`                      pairs, and auto-trade until +$${profitGoal.toFixed(2)} profit goal`);
    console.log(`-------------------------------------------------------`);

    let selectedMode: BotOperatingMode = 'MANUAL';
    while (true) {
      const modeInput = (
        await askQuestion(rl, `Choose Trading Mode — Enter [1] for MANUAL or [2] for AUTOMATIC: `)
      ).toLowerCase();
      if (modeInput === '1' || modeInput === 'manual' || modeInput === 'm') {
        selectedMode = 'MANUAL';
        break;
      }
      if (modeInput === '2' || modeInput === 'auto' || modeInput === 'automatic' || modeInput === 'a') {
        selectedMode = 'AUTO';
        break;
      }
      console.log(`  Please enter 1 (Manual) or 2 (Automatic).`);
    }

    if (selectedMode === 'MANUAL') {
      console.log(`\n>>> [MODE: MANUAL SIGNAL ASSISTANT on ${accountType}] Watching market & issuing calibrated calls.\n`);
      return { accountType, mode: 'MANUAL', stakeAmount: 100, profitGoal };
    }

    // ── STEP 3 (Auto Only): Ask Stake Amount & Display Quotex Ban Risk Warning ──
    let stakeAmount = 10;
    while (true) {
      const stakeInput = await askQuestion(
        rl,
        `\nHow much ($) do you want the bot to use per trade? (${accountType} Balance: $${activeBalance.toFixed(2)}): $`
      );
      const parsed = parseFloat(stakeInput.replace(/[^0-9.]/g, ''));
      if (!isNaN(parsed) && parsed >= 1) {
        if (activeBalance > 0 && parsed > activeBalance) {
          console.log(`  Stake ($${parsed.toFixed(2)}) exceeds your ${accountType} balance ($${activeBalance.toFixed(2)}).`);
          continue;
        }
        stakeAmount = Math.round(parsed * 100) / 100;
        break;
      }
      console.log(`  Please enter a valid trade amount of at least $1 (e.g. 5, 10, 25, 50, 100).`);
    }

    console.log(`\n=======================================================`);
    console.log(`  \x1b[41m\x1b[97m ⚠️  WARNING: AUTOMATED TRADING & QUOTEX BAN RISK ⚠️ \x1b[0m`);
    console.log(`=======================================================`);
    console.log(`  1. FULL ACCOUNT PERMISSION: You are authorizing this bot to automatically`);
    console.log(`     place trades using $${stakeAmount.toFixed(2)} per trade on your ${accountType} account.`);
    console.log(`  2. QUOTEX BAN RISK: Using automated trading bots violates Quotex's Terms`);
    console.log(`     of Service. If caught or flagged by broker anti-bot systems, your`);
    console.log(`     Quotex account may be restricted or permanently banned.`);
    console.log(`  3. PRO HUMAN STEALTH ACTIVE: Calm human-paced observation (20-35s per chart,`);
    console.log(`     no rapid tab-switching), humanized mouse curves, Walk-Forward self-calibration`);
    console.log(`     on each pair's own history, and auto-removal of erratic or low-payout pairs.`);
    console.log(`  4. PROFIT GOAL: Trades until you close the bot (Ctrl+C) or hit +$${profitGoal.toFixed(2)}.`);
    console.log(`=======================================================`);

    const confirm = (
      await askQuestion(rl, `Do you understand the risks and authorize Full Auto-Trading? (Type YES or Y): `)
    ).toLowerCase();

    if (confirm !== 'yes' && confirm !== 'y') {
      console.log(`\n>>> Auto-Trading not confirmed. Switching safely to MANUAL Signal Assistant mode.\n`);
      return { accountType, mode: 'MANUAL', stakeAmount, profitGoal };
    }

    console.log(
      `\n>>> \x1b[42m\x1b[97m [MODE: FULL AUTO-TRADER ACTIVE (${accountType})] \x1b[0m Stake: $${stakeAmount.toFixed(
        2
      )} | Target: +$${profitGoal.toFixed(2)} Profit\n`
    );
    return { accountType, mode: 'AUTO', stakeAmount, profitGoal };
  } finally {
    rl.close();
  }
}

async function bootstrap() {
  const status = new StatusLine();
  installCleanConsole(status);

  console.log('=======================================================');
  console.log('   QX PRO EXPERT TRADING BOT: MANUAL & AUTO-TRADER     ');
  console.log('=======================================================\n');

  const db = new TradingJournalDB();
  const sniffer = new QxWsSniffer();
  const aggregator = new CandleAggregator(sniffer);
  const watcher = new TradeWatcher(sniffer, db);

  const { context, page, isExternalChrome } = await launchBrowserSession(async (p) => {
    await sniffer.attachToPage(p);
  });

  const visualEngine = new VisualChartEngine();
  const controller = new QuotexController(page);
  const brain = new SignalEngine();

  // Wait 1.8s for initial Redux/DOM read of account mode & balance
  await sleep(1800);

  const startupConfig = await promptStartupConfiguration(controller, sniffer);

  // Ensure Quotex built-in indicators (MA, BB, RSI, Stochastic) are enabled on the chart
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

  // ============================================================================
  // BRANCH A: PRO HUMAN-PACED SELF-CALIBRATING AUTO-TRADING ENGINE
  // ============================================================================
  if (startupConfig.mode === 'AUTO') {
    const stakeAmount = startupConfig.stakeAmount;
    const profitGoal = startupConfig.profitGoal;
    const sessionStartBalance = sniffer.getBalance()?.balance ?? 0;
    let settledProfitLoss = 0;
    let sessionWins = 0;
    let sessionLosses = 0;
    let goalReached = false;

    const openTradesByAsset = new Set<string>();
    const tradedCycles = new Set<string>();
    const consecutiveLossesByAsset = new Map<string, number>();
    const blacklistedUntil = new Map<string, number>(); // normAsset -> expiry timestamp
    const pairLastProductiveAt = new Map<string, number>(); // normAsset -> last time pair produced a setup or was added
    const urgentRecalibrateAssets = new Set<string>(); // triggered on 1st loss to detect regime shift
    let needsWatchlistRefill = false;

    const calibrationCache = new Map<
      string,
      { report: PairCalibrationReport; rawSymbol: string; label: string; updatedAt: number }
    >();

    const getBlacklistedSet = (): Set<string> => {
      const now = Date.now();
      const set = new Set<string>();
      for (const [asset, until] of blacklistedUntil.entries()) {
        if (until > now) set.add(asset);
        else blacklistedUntil.delete(asset);
      }
      return set;
    };

    const blacklistAndRemoveTab = async (
      rawSymbol: string,
      normAsset: string,
      label: string,
      reason: string,
      cooldownMinutes: number = 45
    ) => {
      blacklistedUntil.set(normAsset, Date.now() + cooldownMinutes * 60 * 1000);
      calibrationCache.delete(normAsset);
      pairLastProductiveAt.delete(normAsset);
      urgentRecalibrateAssets.delete(normAsset);
      needsWatchlistRefill = true;
      console.log(`\n[Market Guard] Removing ${label} — ${reason} (${cooldownMinutes}m cooldown; finding replacement...)`);
      await controller.closeMarketTab(rawSymbol);
    };

    const getCurrentNetProfit = (): number => {
      const liveBal = sniffer.getBalance()?.balance;
      if (typeof liveBal === 'number' && liveBal > 0 && openTradesByAsset.size === 0 && sessionStartBalance > 0) {
        return liveBal - sessionStartBalance;
      }
      return settledProfitLoss;
    };

    watcher.on('tradeOpened', (trade) => {
      const norm = normalizeAsset(trade.asset);
      openTradesByAsset.add(norm);
      pairLastProductiveAt.set(norm, Date.now());
    });

    watcher.on('tradeSettled', async (trade) => {
      const norm = normalizeAsset(trade.asset);
      openTradesByAsset.delete(norm);

      const pnl = trade.profitLoss ?? 0;
      settledProfitLoss += pnl;
      if (trade.status === 'WON') {
        sessionWins++;
        consecutiveLossesByAsset.set(norm, 0);
      } else if (trade.status === 'LOST') {
        sessionLosses++;
        const streak = (consecutiveLossesByAsset.get(norm) || 0) + 1;
        consecutiveLossesByAsset.set(norm, streak);
        if (streak === 1) {
          // Stage 1: On 1st loss, immediately schedule urgent re-calibration on this pair to detect regime shifts!
          urgentRecalibrateAssets.add(norm);
          console.log(
            `\n[Regime Monitor] 1st loss on ${formatPairDisplay(
              trade.asset
            )} — scheduling immediate Out-of-Sample re-calibration to check if market regime shifted...`
          );
        } else if (streak >= 2) {
          // Stage 2: On 2nd consecutive loss, immediately remove & replace toxic market!
          const cached = calibrationCache.get(norm);
          const rawSym = cached?.rawSymbol || trade.asset;
          await blacklistAndRemoveTab(
            rawSym,
            norm,
            formatPairDisplay(trade.asset),
            `2 consecutive live losses (market acting erratically against indicators)`,
            45
          );
        }
      }

      const netProfit = getCurrentNetProfit();
      const tag =
        trade.status === 'WON'
          ? '\x1b[42m\x1b[97m GAIN / WON \x1b[0m'
          : trade.status === 'LOST'
          ? '\x1b[41m\x1b[97m LOSS \x1b[0m'
          : 'DRAW';

      console.log(`\n=======================================================`);
      console.log(
        `  ${tag}  ${formatPairDisplay(trade.asset)} (${trade.direction}) | Trade PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
      );
      console.log(
        `  Session Profit: ${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)} / +$${profitGoal.toFixed(
          2
        )} Goal | Record: ${sessionWins}W - ${sessionLosses}L`
      );
      console.log(`=======================================================\n`);

      if (netProfit >= profitGoal && !goalReached) {
        goalReached = true;
        console.log(`\n╔═══════════════════════════════════════════════════════╗`);
        console.log(`║  🎯 +$${profitGoal.toFixed(2)} PROFIT GOAL ACHIEVED! (+$${netProfit.toFixed(2)})        ║`);
        console.log(`║  Auto-Trader has locked in your profits and stopped.  ║`);
        console.log(`╚═══════════════════════════════════════════════════════╝\n`);
        playAlertSound(
          `Congratulations! Profit goal of ${profitGoal} dollars achieved. Auto trader has stopped.`,
          `PROFIT GOAL ACHIEVED (+$${netProfit.toFixed(2)})`,
          `Target of +$${profitGoal.toFixed(2)} reached (${sessionWins}W - ${sessionLosses}L)`
        );
      }
    });

    // ── PHASE 1: Calm Watchlist Setup & Strict Out-of-Sample Walk-Forward Self-Calibration ──
    await controller.setInvestmentStake(stakeAmount);
    console.log(
      `[Auto-Trader] Setting up calm multi-market watchlist & running Out-of-Sample Walk-Forward Calibration (3 Playbooks x 3 Indicator Profiles x Multi-Expiry)...`
    );

    let lastFirstPtVal = -1;

    const calibrateAndPruneWatchlist = async (desiredCleanTabs: number = 3) => {
      needsWatchlistRefill = false;
      for (let round = 0; round < 4; round++) {
        if (goalReached || page.isClosed()) break;
        const tabs = await controller.ensureMultiMarketTabsOpen(4, 84, getBlacklistedSet());
        let verifiedCleanCount = 0;

        for (const tab of tabs) {
          if (goalReached || page.isClosed()) break;

          if (tab.payout < 80 && tabs.length > 1) {
            await blacklistAndRemoveTab(tab.rawSymbol, tab.normAsset, tab.label, `Payout dropped too low (${tab.payout}%)`, 30);
            continue;
          }

          const existing = calibrationCache.get(tab.normAsset);
          const forceRecal = urgentRecalibrateAssets.has(tab.normAsset);
          if (!forceRecal && existing && Date.now() - existing.updatedAt < 10 * 60 * 1000 && existing.report.isTradeable) {
            verifiedCleanCount++;
            continue;
          }
          urgentRecalibrateAssets.delete(tab.normAsset);

          const snap = await controller.switchToMarketTabAndVerify(tab.rawSymbol, lastFirstPtVal);
          if (!snap) continue;
          lastFirstPtVal = snap.firstPointValue;

          sniffer.setOnScreenPayout(snap.normAsset, snap.payout);
          aggregator.seedFromChartHistory(snap.normAsset, snap.timeframeSeconds, snap.historyPoints);
          const closedHistory = aggregator.getHistory(snap.normAsset, snap.timeframeSeconds);

          const report = brain.calibratePairPlaybook(snap.normAsset, closedHistory, snap.payout, snap.timeframeSeconds);
          if (report.isTradeable && report.bestStats) {
            calibrationCache.set(snap.normAsset, {
              report,
              rawSymbol: snap.rawSymbol,
              label: snap.label,
              updatedAt: Date.now(),
            });
            if (!pairLastProductiveAt.has(snap.normAsset)) {
              pairLastProductiveAt.set(snap.normAsset, Date.now());
            }
            verifiedCleanCount++;
            const expLbl = QuotexController.formatTimeframe(report.recommendedExpirySeconds);
            console.log(
              `  \x1b[32m✓ KEEP\x1b[0m   ${snap.label.padEnd(16)} (${snap.payout}%) | ${report.bestPlaybook} [${
                report.bestProfile.name
              } · ${expLbl} exp] | Total: ${report.bestStats.winRate.toFixed(1)}% (${report.bestStats.totalWins}W-${
                report.bestStats.totalLosses
              }L) | Unseen OOS: ${report.bestStats.oosWinRate.toFixed(0)}% (${report.candlesTested}c)`
            );
          } else {
            console.log(
              `  \x1b[31m✗ REMOVE\x1b[0m ${snap.label.padEnd(16)} (${snap.payout}%) | ${report.removeReason || 'No proven edge'}`
            );
            const curTabs = await controller.getOpenMarketTabs();
            if (curTabs.length > 1) {
              await blacklistAndRemoveTab(
                snap.rawSymbol,
                snap.normAsset,
                snap.label,
                report.removeReason || 'Failed Out-of-Sample Walk-Forward calibration',
                45
              );
            } else {
              blacklistedUntil.set(snap.normAsset, Date.now() + 30 * 60 * 1000);
            }
          }

          // Calm human reading pause (4s - 6s) between calibration tabs
          await sleep(4000 + Math.floor(Math.random() * 2000));
        }

        if (verifiedCleanCount >= desiredCleanTabs) break;
      }

      const finalVerified = Array.from(calibrationCache.values())
        .filter((c) => c.report.isTradeable)
        .map(
          (c) =>
            `${c.label} [${c.report.bestPlaybook}/${c.report.bestProfile.name} ${QuotexController.formatTimeframe(
              c.report.recommendedExpirySeconds
            )} · ${c.report.bestStats?.oosWinRate.toFixed(0)}% OOS]`
        );
      console.log(
        `\n[Auto-Trader] Verified Watchlist (${finalVerified.length} pairs): ${
          finalVerified.length > 0 ? finalVerified.join(' | ') : 'Searching for clean markets...'
        }\n`
      );
    };

    await calibrateAndPruneWatchlist(3);

    // Sync on-screen Quotex chart indicators to match the active calibrated pair right away
    const firstVerified = Array.from(calibrationCache.values()).find((c) => c.report.isTradeable);
    if (firstVerified) {
      await controller.configureOnScreenIndicators(firstVerified.report.bestProfile);
    }

    // ── PHASE 2: Calm 30s-40s Human-Paced Multi-Market Observation & Candle-Boundary Sniper Loop ──
    let currentTabIndex = 0;
    let lastTabSwitchAt = Date.now();
    let lastRecalibrationAt = Date.now();
    let nextQuietHoldMs = 30000 + Math.floor(Math.random() * 10000); // Calm 30s - 40s per chart!
    let lastLoopHeartbeatAt = Date.now();

    // Independent Watchdog: ensures terminal stays responsive and logs if anything ever stalls
    setInterval(() => {
      if (!goalReached && Date.now() - lastLoopHeartbeatAt > 25000) {
        console.log(`\n[Watchdog] Recovering slow browser poll (Chrome backgrounded/throttled) — continuing smoothly...`);
        lastLoopHeartbeatAt = Date.now();
      }
    }, 10000);

    const runCalmProTraderCycle = async () => {
      while (!goalReached && !page.isClosed()) {
        lastLoopHeartbeatAt = Date.now();
        try {
          const netProfit = getCurrentNetProfit();
          if (netProfit >= profitGoal) {
            goalReached = true;
            break;
          }

          const activeTf = sniffer.getActiveTimeframe() || 300;
          const tfLabel = QuotexController.formatTimeframe(activeTf);
          const cycleMs = activeTf * 1000;
          const now = Date.now();
          const nextCandleOpenMs = Math.ceil(now / cycleMs) * cycleMs;
          const prevCandleOpenMs = Math.floor(now / cycleMs) * cycleMs;
          const remMs = nextCandleOpenMs - now;
          const elapsedMs = now - prevCandleOpenMs;

          // 1. Immediate Replacement / Urgent 1st-Loss Re-Calibration (outside final 25s entry window)
          if ((needsWatchlistRefill || urgentRecalibrateAssets.size > 0) && remMs > 28000) {
            await calibrateAndPruneWatchlist(3);
            lastTabSwitchAt = Date.now();
            continue;
          }

          // 2. Periodic 12-minute refresh during calm mid-candle time
          if (Date.now() - lastRecalibrationAt > 12 * 60 * 1000 && remMs > 55000) {
            lastRecalibrationAt = Date.now();
            await calibrateAndPruneWatchlist(3);
            continue;
          }

          const openTabs = await controller.getOpenMarketTabs();
          if (openTabs.length === 0) {
            await sleep(2500);
            continue;
          }

          // 3. Immediate removal of any tab whose payout dropped below 80% OR sat unproductive for >= 3 candle cycles (15m on 5m)
          const idleMaxMs = Math.max(3 * cycleMs, 12 * 60 * 1000);
          let prunedAny = false;
          for (const t of openTabs) {
            if (t.payout < 80 && openTabs.length > 1) {
              await blacklistAndRemoveTab(t.rawSymbol, t.normAsset, t.label, `Live payout dropped to ${t.payout}%`, 30);
              prunedAny = true;
              break;
            }
            const lastProd = pairLastProductiveAt.get(t.normAsset) ?? now;
            if (
              remMs > 50000 &&
              openTabs.length > 1 &&
              !openTradesByAsset.has(t.normAsset) &&
              now - lastProd >= idleMaxMs
            ) {
              const idleMins = Math.round((now - lastProd) / 60000);
              await blacklistAndRemoveTab(
                t.rawSymbol,
                t.normAsset,
                t.label,
                `Unproductive — 0 valid setups in ${idleMins}m (rotating for a more active pair)`,
                20
              );
              prunedAny = true;
              break;
            }
          }
          if (prunedAny) {
            continue; // Immediately triggers needsWatchlistRefill on next iteration!
          }

          const activeTab = openTabs.find((t) => t.isActive) || openTabs[0];

          const focusStartMs = activeTf >= 300 ? 44000 : Math.min(20000, cycleMs * 0.4);
          const entryWindowPreMs = activeTf >= 300 ? 12000 : Math.min(6000, cycleMs * 0.2);
          const entryWindowPostMs = activeTf >= 300 ? 9000 : Math.min(5000, cycleMs * 0.15);

          const evaluateVerifiedMarketNow = async (tab: OpenMarketTab, allowNearlyClosedForming: boolean) => {
            const snap = await controller.switchToMarketTabAndVerify(tab.rawSymbol, lastFirstPtVal);
            if (!snap) return null;
            lastFirstPtVal = snap.firstPointValue;

            // Reconcile local openTradesByAsset set with Quotex's authoritative Redux deals.openedById
            if (!snap.hasOpenDealOnSymbol && openTradesByAsset.has(snap.normAsset)) {
              openTradesByAsset.delete(snap.normAsset);
            }
            if (snap.totalOpenDealsCount === 0 && openTradesByAsset.size > 0) {
              openTradesByAsset.clear();
            }

            sniffer.setOnScreenPayout(snap.normAsset, snap.payout);
            aggregator.seedFromChartHistory(snap.normAsset, snap.timeframeSeconds, snap.historyPoints);

            const closedHistory = aggregator.getHistory(snap.normAsset, snap.timeframeSeconds);
            const formingCandle = aggregator.getCurrentCandle(snap.normAsset, snap.timeframeSeconds);
            if (closedHistory.length < 55) return null;

            // Never treat a mid-cycle forming candle as closed; only include it if within final 4s of candle close
            const remNowMs =
              Math.ceil(Date.now() / (snap.timeframeSeconds * 1000)) * (snap.timeframeSeconds * 1000) - Date.now();
            const useForming = allowNearlyClosedForming && formingCandle && remNowMs <= 4000;
            const evalCandles = useForming
              ? [...closedHistory, { ...formingCandle, isClosed: true }]
              : closedHistory;

            const visual = visualEngine.analyzeCandles(evalCandles);
            const isOtc = snap.normAsset.endsWith('_OTC');
            // Always calibrate strictly on closedHistory so unclosed candles never pollute calibration
            let cachedCal = calibrationCache.get(snap.normAsset)?.report ?? null;
            if (!cachedCal || cachedCal.payoutPercent !== snap.payout || cachedCal.timeframeSeconds !== snap.timeframeSeconds) {
              cachedCal = brain.calibratePairPlaybook(snap.normAsset, closedHistory, snap.payout, snap.timeframeSeconds);
            }

            const intel = brain.analyzeAdaptivePairIntelligence(
              snap.normAsset,
              isOtc,
              evalCandles,
              snap.payout,
              visual,
              db.getAllTrades(),
              snap.price,
              snap.timeframeSeconds,
              cachedCal
            );

            if (intel.calibration.isTradeable) {
              calibrationCache.set(snap.normAsset, {
                report: intel.calibration,
                rawSymbol: snap.rawSymbol,
                label: snap.label,
                updatedAt: Date.now(),
              });
            }

            return { snap, intel, evalCandles };
          };

          // ── B. EXACT CANDLE-BOUNDARY ENTRY EXECUTION WINDOW ──
          const isPreEntryWindow = remMs <= entryWindowPreMs && remMs >= 1000;
          const isPostOpenWindow = elapsedMs <= entryWindowPostMs;

          if (isPreEntryWindow || isPostOpenWindow) {
            const targetCycleMs = isPreEntryWindow ? nextCandleOpenMs : prevCandleOpenMs;
            const res = await evaluateVerifiedMarketNow(activeTab, isPreEntryWindow);
            if (res) {
              const { snap, intel } = res;
              const cycleKey = `${snap.normAsset}_${targetCycleMs}_${snap.timeframeSeconds}`;

              if (
                (intel.directionCall === 'CALL' || intel.directionCall === 'PUT') &&
                !tradedCycles.has(cycleKey) &&
                !openTradesByAsset.has(snap.normAsset) &&
                !snap.hasOpenDealOnSymbol &&
                openTradesByAsset.size < 2 &&
                snap.totalOpenDealsCount < 2
              ) {
                pairLastProductiveAt.set(snap.normAsset, Date.now());
                const optimalExpirySec = intel.recommendedExpirySeconds || snap.timeframeSeconds;
                const expLabel = QuotexController.formatTimeframe(optimalExpirySec);

                // Register signal context before clicking so TradeWatcher attaches regime & indicators on deal open
                watcher.setPendingSignalContext(
                  snap.normAsset,
                  intel.convictionScore,
                  intel.factors.join(' | '),
                  intel.marketRegime,
                  intel.indicatorsAtEntry
                );

                const execResult = await controller.executeTradeOnScreen({
                  expectedRawSymbol: snap.rawSymbol,
                  direction: intel.directionCall,
                  stakeAmount,
                  timeframeSeconds: optimalExpirySec,
                });

                if (execResult.executed) {
                  if (execResult.dealId) {
                    watcher.attachSignalContext(
                      execResult.dealId,
                      intel.convictionScore,
                      intel.factors.join(' | '),
                      intel.marketRegime,
                      intel.indicatorsAtEntry
                    );
                  }
                  tradedCycles.add(cycleKey);
                  openTradesByAsset.add(snap.normAsset);

                  const entryClock = formatClockHHMM(targetCycleMs, snap.timeframeSeconds < 60);
                  const toClock = formatClockHHMM(targetCycleMs + optimalExpirySec * 1000, snap.timeframeSeconds < 60);
                  const isCall = intel.directionCall === 'CALL';
                  const color = isCall ? '\x1b[32m' : '\x1b[31m';
                  const bold = '\x1b[1m';
                  const reset = '\x1b[0m';
                  const dirBadge = isCall ? 'CALL [BUY / UP]' : 'PUT [SELL / DOWN]';

                  console.log(`\n=======================================================`);
                  console.log(
                    `  \x1b[44m\x1b[97m 🤖 AUTO-TRADE EXECUTED \x1b[0m  ${bold}${snap.label}; ${entryClock}; ${color}${dirBadge}${reset}`
                  );
                  console.log(
                    `  Stake: ${bold}$${stakeAmount.toFixed(2)}${reset} | Expiry: ${bold}${expLabel} (TIME TO ${toClock})${reset} | Payout: ${
                      snap.payout
                    }% | Entry: ${(execResult.entryPrice ?? snap.price).toFixed(5)}`
                  );
                  console.log(`-------------------------------------------------------`);
                  console.log(
                    `  Playbook: ${intel.activePlaybook} [${intel.activeProfile.name}] (${intel.alignedPillars}/5 Aligned - ${intel.convictionScore}%)`
                  );
                  for (const reason of intel.factors) {
                    console.log(`  * ${reason}`);
                  }
                  console.log(`=======================================================\n`);

                  const spokenPair = snap.label.replace('(OTC)', 'O T C').replace('/', ' ');
                  playAlertSound(
                    `Auto trade placed: ${spokenPair}, ${isCall ? 'CALL UP' : 'PUT DOWN'}, ${stakeAmount} dollars, ${expLabel} expiry`,
                    `AUTO-TRADE: ${snap.label} (${intel.directionCall})`,
                    `Stake: $${stakeAmount.toFixed(2)} | Expiry: ${expLabel} (to ${toClock}) | Payout: ${snap.payout}%`
                  );
                }
              }
            }
            await sleep(2200);
            continue;
          }

          // ── C. PRE-CANDLE CALM FOCUS SCAN (Pick the #1 Verified Setup Right Before Candle Open) ──
          if (remMs <= focusStartMs && remMs > entryWindowPreMs) {
            const verifiedTabs = openTabs.filter((t) => calibrationCache.get(t.normAsset)?.report.isTradeable);
            const scanList = verifiedTabs.length > 0 ? verifiedTabs : openTabs.slice(0, 3);
            let bestCandidate: { tab: OpenMarketTab; score: number; profile: any } | null = null;

            for (const t of scanList) {
              if (goalReached || page.isClosed()) break;
              const remCheck = Math.ceil(Date.now() / cycleMs) * cycleMs - Date.now();
              if (remCheck <= entryWindowPreMs + 1500) break;

              const res = await evaluateVerifiedMarketNow(t, true);
              if (res && (res.intel.directionCall === 'CALL' || res.intel.directionCall === 'PUT')) {
                pairLastProductiveAt.set(res.snap.normAsset, Date.now());
                const oosWr = res.intel.calibration.bestStats?.oosWinRate ?? 60;
                const totWr = res.intel.calibration.bestStats?.winRate ?? 60;
                const rankScore = oosWr * 0.6 + totWr * 0.4 + res.snap.payout * 0.2;
                if (!bestCandidate || rankScore > bestCandidate.score) {
                  bestCandidate = { tab: t, score: rankScore, profile: res.intel.activeProfile };
                }
              }
              await sleep(5000 + Math.floor(Math.random() * 1500));
            }

            if (bestCandidate && bestCandidate.tab.rawSymbol !== activeTab.rawSymbol) {
              await controller.switchToMarketTabAndVerify(bestCandidate.tab.rawSymbol, lastFirstPtVal);
            }
            lastTabSwitchAt = Date.now();
            await sleep(2000);
            continue;
          }

          // ── D. QUIET MID-CANDLE OBSERVATION (Calm 30s-40s Human Reading Pace!) ──
          const shouldCalmlyGlanceNext = openTabs.length > 1 && Date.now() - lastTabSwitchAt >= nextQuietHoldMs;
          let tabToObserve = activeTab;
          if (shouldCalmlyGlanceNext) {
            currentTabIndex = (currentTabIndex + 1) % openTabs.length;
            tabToObserve = openTabs[currentTabIndex];
            lastTabSwitchAt = Date.now();
            nextQuietHoldMs = 30000 + Math.floor(Math.random() * 10000); // Calm 30s - 40s hold per chart!
          }

          const obs = await evaluateVerifiedMarketNow(tabToObserve, false);
          if (obs) {
            const { snap, intel } = obs;

            if (intel.shouldSwitchPair && openTabs.length > 1 && intel.volatilityState === 'ERRATIC_SPIKE') {
              await blacklistAndRemoveTab(snap.rawSymbol, snap.normAsset, snap.label, intel.switchReason || 'Erratic volatility', 45);
              continue;
            }

            const mode = sniffer.getAccountMode();
            const bal = sniffer.getBalance()?.balance ?? sessionStartBalance;
            const profitNow = getCurrentNetProfit();
            const profitStr = `${profitNow >= 0 ? '+' : ''}$${profitNow.toFixed(2)}/$${profitGoal}`;
            const remainingSec = Math.max(0, Math.round(remMs / 1000));
            const minStr = String(Math.floor(remainingSec / 60)).padStart(2, '0');
            const secStr = String(remainingSec % 60).padStart(2, '0');
            const nextClock = formatClockHHMM(nextCandleOpenMs, activeTf < 60);
            const expLbl = QuotexController.formatTimeframe(intel.recommendedExpirySeconds);
            const pbStr = intel.calibration.bestStats
              ? `${intel.activePlaybook}/${intel.activeProfile.name} ${expLbl} (${intel.calibration.bestStats.oosWinRate.toFixed(
                  0
                )}% OOS)`
              : 'Calibrating';

            status.show(
              `[AUTO ${mode} $${bal.toFixed(0)} | PnL ${profitStr}] ${snap.label} @ ${snap.price.toFixed(5)} (${
                snap.payout
              }%) | ${tfLabel} (Next ${nextClock} in ${minStr}:${secStr}) | ${pbStr}`
            );
          }

          await sleep(2500);
        } catch (err) {
          console.log(`\n[Auto-Trader Recovery] Transient error handled safely: ${(err as Error)?.message || 'unknown'}`);
          await sleep(3000);
        }
      }
    };

    runCalmProTraderCycle();

    process.on('SIGINT', async () => {
      console.log('\n[Shutdown] Closing QX Auto-Trader cleanly...');
      db.close();
      if (!isExternalChrome) {
        await context.close();
      }
      process.exit(0);
    });
    return;
  }

  // ============================================================================
  // BRANCH B: MANUAL TRADING MODE (SELF-CALIBRATED TELEGRAM SIGNAL ASSISTANT)
  // ============================================================================
  const calledCycles = new Set<string>();
  let activeTrackedSignal: TrackedSignalCall | null = null;
  let isEvaluating = false;

  const printCompactMarketSnapshot = async (headerLabel: string) => {
    const asset = sniffer.getActiveAsset();
    if (!asset) return;

    const tf = sniffer.getActiveTimeframe() || 300;
    const tfLabel = QuotexController.formatTimeframe(tf);
    await controller.syncExpiryToTimeframe(tf);

    const history = aggregator.getHistory(asset, tf);
    if (history.length < 15) return;
    const visual = visualEngine.analyzeCandles(history);

    const latestTick = sniffer.getLatestTick(asset);
    const price = latestTick?.price ?? history[history.length - 1].close;
    const payoutInfo = sniffer.getPayout(asset);
    const payoutPct = payoutInfo?.payoutPercent ?? 80;
    const displayPair = formatPairDisplay(asset, payoutInfo?.name);
    const isOtc = payoutInfo?.isOtc ?? asset.endsWith('_OTC');
    const balanceInfo = sniffer.getBalance();
    const mode = sniffer.getAccountMode();

    const intel = brain.analyzeAdaptivePairIntelligence(
      asset,
      isOtc,
      history,
      payoutPct,
      visual,
      db.getAllTrades(),
      price,
      tf
    );

    const closes = history.map((c) => c.close);
    const rsi = TechnicalIndicators.calculateRSI(closes, intel.activeProfile.rsiPeriod).at(-1) ?? 50;
    const cal = intel.calibration;
    if (cal.isTradeable) {
      await controller.configureOnScreenIndicators(cal.bestProfile);
    }
    const expLbl = QuotexController.formatTimeframe(cal.recommendedExpirySeconds);
    const calText = cal.bestStats
      ? `${cal.bestPlaybook} [${cal.bestProfile.name} · ${expLbl} exp] — Total ${cal.bestStats.winRate.toFixed(1)}% (${cal.bestStats.totalWins}W-${cal.bestStats.totalLosses}L) | Unseen OOS ${cal.bestStats.oosWinRate.toFixed(0)}% (${cal.candlesTested}c)`
      : cal.removeReason || 'Warming up history';

    console.log(`\n-------------------------------------------------------`);
    console.log(`  [${headerLabel}] ${displayPair} | Timeframe: ${tfLabel} | Payout: ${payoutPct}%`);
    console.log(`  Account     : ${mode} ($${balanceInfo?.balance.toFixed(2) ?? '0.00'}) | Price: ${price.toFixed(5)} | RSI(14): ${rsi.toFixed(1)}`);
    console.log(`  Calibration : ${calText}`);
    if (intel.shouldSwitchPair && intel.switchReason) {
      const alts = sniffer.getRecommendedAlternativePairs(asset, 2);
      const altText = alts.map((a) => `${a.label} (${a.payout}%)`).join(' or ');
      console.log(`  Advisor     : ${intel.switchReason}.${altText ? ` Try: ${altText}` : ''}`);
    } else {
      console.log(`  Status      : ${intel.callLabel}`);
    }
    console.log(`-------------------------------------------------------\n`);
  };

  const evaluateForTelegramSignal = async (triggerType: 'PRE_CANDLE' | 'CANDLE_OPEN') => {
    if (isEvaluating) return;
    const asset = sniffer.getActiveAsset();
    if (!asset) return;

    const tf = sniffer.getActiveTimeframe() || 300;
    const cycleMs = tf * 1000;
    const now = Date.now();
    const nextBoundaryMs = Math.ceil(now / cycleMs) * cycleMs;
    const nearestBoundaryMs = Math.round(now / cycleMs) * cycleMs;
    const remToNextMs = nextBoundaryMs - now;
    const preWindowMs = Math.min(20000, Math.max(3000, cycleMs * 0.2));
    const openWindowMs = Math.min(12000, Math.max(3000, cycleMs * 0.15));

    let targetEntryMs: number;
    if (triggerType === 'PRE_CANDLE') {
      if (remToNextMs > preWindowMs) return;
      targetEntryMs = nextBoundaryMs;
    } else {
      if (Math.abs(now - nearestBoundaryMs) > openWindowMs) return;
      targetEntryMs = nearestBoundaryMs;
    }

    const targetExpiryMs = targetEntryMs + cycleMs;
    const cycleKey = `${asset}_${targetEntryMs}_${tf}`;
    if (calledCycles.has(cycleKey)) return;

    const history = aggregator.getHistory(asset, tf);
    if (history.length < 35) return;

    isEvaluating = true;
    try {
      const currentCandle = aggregator.getCurrentCandle(asset, tf);
      // Only include forming candle if within the final 4 seconds before candle close
      const evalCandles =
        triggerType === 'PRE_CANDLE' && currentCandle && remToNextMs <= 4000
          ? [...history, { ...currentCandle, isClosed: true }]
          : history;

      const latestTick = sniffer.getLatestTick(asset);
      const price = latestTick?.price ?? evalCandles[evalCandles.length - 1].close;
      const payoutInfo = sniffer.getPayout(asset);
      const payoutPct = payoutInfo?.payoutPercent ?? 80;
      const displayPair = formatPairDisplay(asset, payoutInfo?.name);
      const isOtc = payoutInfo?.isOtc ?? asset.endsWith('_OTC');
      const tfLabel = QuotexController.formatTimeframe(tf);

      const visual = visualEngine.analyzeCandles(evalCandles);
      const intel = brain.analyzeAdaptivePairIntelligence(
        asset,
        isOtc,
        evalCandles,
        payoutPct,
        visual,
        db.getAllTrades(),
        price,
        tf
      );

      if (intel.directionCall === 'WAIT') return;

      calledCycles.add(cycleKey);
      const optimalExpirySec = intel.recommendedExpirySeconds || tf;
      const optExpLabel = QuotexController.formatTimeframe(optimalExpirySec);
      await controller.syncExpiryToTimeframe(optimalExpirySec);

      // Record pending signal context so if the user takes this trade, TradeWatcher logs its regime & indicators
      watcher.setPendingSignalContext(
        asset,
        intel.convictionScore,
        intel.factors.join(' | '),
        intel.marketRegime,
        intel.indicatorsAtEntry
      );

      const useSec = tf < 60;
      const entryClock = formatClockHHMM(targetEntryMs, useSec);
      const toClock = formatClockHHMM(targetEntryMs + optimalExpirySec * 1000, useSec);
      const isCall = intel.directionCall === 'CALL';
      const color = isCall ? '\x1b[32m' : '\x1b[31m';
      const bold = '\x1b[1m';
      const reset = '\x1b[0m';
      const dirBadge = isCall ? 'CALL [GREEN / UP]' : 'PUT [RED / DOWN]';

      console.log(`\n=======================================================`);
      console.log(`  ${bold}${displayPair}; ${entryClock}; ${color}${dirBadge}${reset}`);
      console.log(`  ${bold}TIME TO ${toClock}${reset}  (${optExpLabel} Expiry | Payout: ${payoutPct}%)`);
      console.log(`-------------------------------------------------------`);
      console.log(`  Why (${intel.activePlaybook} [${intel.activeProfile.name}] — ${intel.convictionScore}% Confluence):`);
      for (const reason of intel.factors) {
        console.log(`  * ${reason}`);
      }
      console.log(`=======================================================\n`);

      activeTrackedSignal = {
        key: cycleKey,
        asset,
        displayPair,
        direction: intel.directionCall,
        timeframeSeconds: tf,
        entryTimeMs: targetEntryMs,
        expiryTimeMs: targetExpiryMs,
        entryClock,
        toClock,
        entryPrice: price,
        payoutPercent: payoutPct,
        confidence: intel.convictionScore,
      };

      const spokenPair = displayPair.replace('(OTC)', 'O T C').replace('/', ' ');
      playAlertSound(
        `Signal Call: ${spokenPair}, ${entryClock}, ${isCall ? 'CALL UP' : 'PUT DOWN'}, Time to ${toClock}`,
        `${displayPair}; ${entryClock}; ${intel.directionCall}`,
        `TIME TO ${toClock} (${tfLabel} Expiry | Payout: ${payoutPct}% | ${intel.activePlaybook})`
      );

      await controller.triggerInBrowserSignalAlert({
        asset,
        displayPair,
        direction: intel.directionCall,
        timeframeSeconds: tf,
        entryTimeStr: entryClock,
        expiryTimeStr: toClock,
        confidence: intel.convictionScore,
        payoutPercent: payoutPct,
        reasons: intel.factors,
      });
    } catch {
      // Ignore transient navigation errors
    } finally {
      isEvaluating = false;
    }
  };

  await printCompactMarketSnapshot('WATCHING MARKET');
  await evaluateForTelegramSignal('CANDLE_OPEN');
  await evaluateForTelegramSignal('PRE_CANDLE');

  sniffer.on('activeAssetChanged', async ({ asset }: { asset: string; previous: string | null }) => {
    setTimeout(async () => {
      await printCompactMarketSnapshot(`SWITCHED TO ${asset}`);
      await evaluateForTelegramSignal('CANDLE_OPEN');
      await evaluateForTelegramSignal('PRE_CANDLE');
    }, 600);
  });

  sniffer.on('timeframeChanged', async ({ timeframe }: { timeframe: number; previous: number }) => {
    const tfLabel = QuotexController.formatTimeframe(timeframe);
    setTimeout(async () => {
      await printCompactMarketSnapshot(`TIMEFRAME SET TO ${tfLabel}`);
      await evaluateForTelegramSignal('CANDLE_OPEN');
      await evaluateForTelegramSignal('PRE_CANDLE');
    }, 600);
  });

  aggregator.on('candleClosed', async (candle: any) => {
    const activeTf = sniffer.getActiveTimeframe();
    const activeAsset = sniffer.getActiveAsset();
    if (!activeAsset || candle.timeframe !== activeTf || normalizeAsset(candle.asset) !== normalizeAsset(activeAsset)) {
      return;
    }

    if (activeTrackedSignal && normalizeAsset(activeTrackedSignal.asset) === normalizeAsset(activeAsset)) {
      const sig = activeTrackedSignal;
      if (Date.now() >= sig.expiryTimeMs - 3000) {
        const entryP = candle.open || sig.entryPrice;
        const closeP = candle.close;
        const won =
          (sig.direction === 'CALL' && closeP > entryP) || (sig.direction === 'PUT' && closeP < entryP);
        const draw = closeP === entryP;

        if (won) {
          console.log(`\n=======================================================`);
          console.log(`  \x1b[42m\x1b[97m GAIN / WIN \x1b[0m  ${sig.displayPair}; ${sig.entryClock} -> ${sig.toClock}; ${sig.direction}`);
          console.log(`  Entry: ${entryP.toFixed(5)} -> Expiry Close: ${closeP.toFixed(5)}`);
          console.log(`=======================================================\n`);
        } else if (draw) {
          console.log(`\n-------------------------------------------------------`);
          console.log(`  DRAW / REFUND  ${sig.displayPair}; ${sig.entryClock} -> ${sig.toClock}; ${sig.direction}`);
          console.log(`  Entry: ${entryP.toFixed(5)} -> Expiry Close: ${closeP.toFixed(5)}`);
          console.log(`-------------------------------------------------------\n`);
        } else {
          console.log(`\n-------------------------------------------------------`);
          console.log(`  \x1b[41m\x1b[97m LOSS \x1b[0m  ${sig.displayPair}; ${sig.entryClock} -> ${sig.toClock}; ${sig.direction}`);
          console.log(`  Entry: ${entryP.toFixed(5)} -> Expiry Close: ${closeP.toFixed(5)} (No Martingale - waiting for next setup)`);
          console.log(`-------------------------------------------------------\n`);
        }
        activeTrackedSignal = null;
      }
    }

    setTimeout(() => {
      evaluateForTelegramSignal('CANDLE_OPEN').catch(() => {});
    }, 600);
  });

  setInterval(() => {
    const activeTf = sniffer.getActiveTimeframe() || 300;
    const cycleMs = activeTf * 1000;
    const now = Date.now();
    const nextOpen = Math.ceil(now / cycleMs) * cycleMs;
    const remMs = nextOpen - now;
    const windowMs = Math.min(20000, Math.max(3000, cycleMs * 0.2));

    if (remMs <= windowMs && remMs >= 1500) {
      evaluateForTelegramSignal('PRE_CANDLE').catch(() => {});
    }
  }, 2000);

  watcher.on('tradeSettled', (trade) => {
    const tag = trade.status === 'WON' ? '\x1b[32mGAIN / WON\x1b[0m' : trade.status === 'LOST' ? '\x1b[31mLOST\x1b[0m' : 'DRAW';
    console.log(
      `\n[Account Trade Result] ${trade.asset} (${trade.direction}) -> ${tag} | PnL: ${
        trade.profitLoss && trade.profitLoss >= 0 ? '+' : ''
      }$${trade.profitLoss?.toFixed(2) ?? '0.00'}`
    );
  });

  setInterval(() => {
    const activeTf = sniffer.getActiveTimeframe() || 300;
    const tfLabel = QuotexController.formatTimeframe(activeTf);
    const now = Date.now();
    const cycleMs = activeTf * 1000;
    const nextCandleOpen = Math.ceil(now / cycleMs) * cycleMs;
    const remainingSec = Math.max(0, Math.round((nextCandleOpen - now) / 1000));
    const minStr = String(Math.floor(remainingSec / 60)).padStart(2, '0');
    const secStr = String(remainingSec % 60).padStart(2, '0');
    const nextClock = formatClockHHMM(nextCandleOpen, activeTf < 60);

    const activeAsset = sniffer.getActiveAsset();
    const mode = sniffer.getAccountMode();
    const balanceInfo = sniffer.getBalance();
    const balFormatted = balanceInfo ? `$${balanceInfo.balance.toFixed(2)}` : '$0.00';
    const modeStr = mode === 'LIVE' ? `LIVE ${balFormatted}` : mode === 'DEMO' ? `DEMO ${balFormatted}` : `?? ${balFormatted}`;

    if (activeAsset) {
      const latestTick = sniffer.getLatestTick(activeAsset);
      const payout = sniffer.getPayout(activeAsset);
      const displayPair = formatPairDisplay(activeAsset, payout?.name);
      const history = aggregator.getHistory(activeAsset, activeTf);

      if (history.length >= 15) {
        const price = latestTick?.price ?? history[history.length - 1].close;
        const intel = brain.analyzeAdaptivePairIntelligence(
          activeAsset,
          payout?.isOtc ?? activeAsset.endsWith('_OTC'),
          history,
          payout?.payoutPercent ?? 80,
          visualEngine.analyzeCandles(history),
          undefined,
          price,
          activeTf
        );

        const closes = history.map((c) => c.close);
        const rsi = TechnicalIndicators.calculateRSI(closes, 14).at(-1);
        const rsiStr = rsi !== undefined ? rsi.toFixed(0) : '--';
        status.show(
          `[${modeStr}] ${displayPair} @ ${price.toFixed(5)} (${payout?.payoutPercent || '--'}%) | ${tfLabel} (Next ${nextClock} in ${minStr}:${secStr}) | RSI ${rsiStr} | ${intel.callLabel}`
        );
      } else {
        status.show(
          `[${modeStr}] ${displayPair} (${payout?.payoutPercent || '--'}%) | Loading ${tfLabel} candles (${history.length}/45)...`
        );
      }
    } else {
      status.show(`[${modeStr}] Connected to Quotex - waiting for active chart...`);
    }
  }, 2000);

  process.on('SIGINT', async () => {
    console.log('\n[Shutdown] Closing QX Trading Assistant cleanly...');
    db.close();
    if (!isExternalChrome) {
      await context.close();
    }
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('\n[Recovered Unhandled Rejection]', reason instanceof Error ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  console.error('\n[Recovered Uncaught Exception]', err?.message || err);
});

bootstrap().catch((err) => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
