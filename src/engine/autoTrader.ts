import { Page } from 'playwright';
import { QuotexController, OpenMarketTab } from '../browser/quotexController.js';
import { QxWsSniffer } from '../stream/wsSniffer.js';
import { CandleAggregator } from '../stream/candleAggregator.js';
import { TradingJournalDB } from '../journal/database.js';
import { TradeWatcher } from '../journal/tradeWatcher.js';
import { SignalEngine, PairCalibrationReport, PLAYBOOK_DISPLAY_NAMES } from '../analysis/signalEngine.js';
import { VisualChartEngine } from '../analysis/visualChartEngine.js';
import { normalizeAsset } from '../stream/assets.js';
import { StatusLine } from '../ui/statusLine.js';
import { playAlertSound } from '../ui/sound.js';
import { RiskManager, RiskLimits } from './riskManager.js';
import { formatClockHHMM, formatPairDisplay, sleep } from '../cli/format.js';

export interface AutoTraderDeps {
  page: Page;
  db: TradingJournalDB;
  sniffer: QxWsSniffer;
  aggregator: CandleAggregator;
  watcher: TradeWatcher;
  controller: QuotexController;
  brain: SignalEngine;
  visualEngine: VisualChartEngine;
  status: StatusLine;
  limits: RiskLimits;
  allowPreliminaryOnLive: boolean;
}

export class AutoTrader {
  private risk: RiskManager;
  private stopped = false;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: AutoTraderDeps) {
    const todayStats = deps.db.getTodayNetPnL(deps.limits.accountType === 'DEMO');
    this.risk = new RiskManager(deps.limits, todayStats.netPnL);
    if (todayStats.tradeCount > 0) {
      console.log(
        `[RiskManager] Prior today ${deps.limits.accountType} PnL: ${todayStats.netPnL >= 0 ? '+' : ''}$${todayStats.netPnL.toFixed(
          2
        )} (${todayStats.tradeCount} trades) | Daily stop: -$${deps.limits.maxDailyLoss.toFixed(2)}`
      );
    }
  }

  public stop(reason?: string): void {
    this.stopped = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (reason) {
      console.log(`\n[Auto-Trader Stopped] ${reason}`);
    }
  }

  public async start(): Promise<void> {
    const { page, db, sniffer, aggregator, watcher, controller, brain, visualEngine, status, limits } = this.deps;
    const strictProvenOnly = limits.accountType === 'LIVE' && !this.deps.allowPreliminaryOnLive;

    // Immediate pre-flight risk check (e.g. if daily loss limit is ALREADY breached before starting)
    const initialCheck = this.risk.canOpenTrade(sniffer.getBalance()?.balance);
    if (!initialCheck.allowed) {
      this.announceHalt(initialCheck.reason || 'Pre-flight risk limit hit');
      return;
    }

    // Platform DOM/Redux health check
    const health = await controller.checkPlatformHealth();
    if (!health.healthy) {
      console.log(`\n[Platform Health Warning] Issues detected on Quotex page: ${health.issues.join('; ')}`);
      console.log(`[Platform Health Warning] Auto-trader will pause entries until page health recovers.`);
    }

    const sessionStartBalance = sniffer.getBalance()?.balance ?? 0;
    const openTradesByAsset = new Set<string>();
    const tradedCycles = new Set<string>();
    const blacklistedUntil = new Map<string, number>();
    const pairLastProductiveAt = new Map<string, number>();
    const urgentRecalibrateAssets = new Set<string>();
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
      cooldownMinutes: number = 25
    ) => {
      blacklistedUntil.set(normAsset, Date.now() + cooldownMinutes * 60 * 1000);
      calibrationCache.delete(normAsset);
      pairLastProductiveAt.delete(normAsset);
      urgentRecalibrateAssets.delete(normAsset);
      needsWatchlistRefill = true;
      console.log(`\n[Market Guard] Removing ${label} — ${reason} (${cooldownMinutes}m cooldown)`);
      await controller.closeMarketTab(rawSymbol);
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
      const update = this.risk.recordTradeOutcome({
        asset: trade.asset,
        status: trade.status as 'WON' | 'LOST' | 'DRAW',
        pnl,
      });

      if (update.pairNeedsCooldown) {
        const cached = calibrationCache.get(norm);
        const rawSym = cached?.rawSymbol || trade.asset;
        await blacklistAndRemoveTab(
          rawSym,
          norm,
          formatPairDisplay(trade.asset),
          `${limits.pairConsecutiveLossCooldown} consecutive losses on pair — cooling down`,
          20
        );
      } else if (update.pairNeedsRecalibration) {
        urgentRecalibrateAssets.add(norm);
        console.log(
          `\n[Regime Monitor] Loss #${update.pairLossStreak} on ${formatPairDisplay(
            trade.asset
          )} — scheduling leak-free OOS re-calibration.`
        );
      }

      const st = this.risk.getStats();
      const tag =
        trade.status === 'WON'
          ? '\x1b[42m\x1b[97m WON \x1b[0m'
          : trade.status === 'LOST'
          ? '\x1b[41m\x1b[97m LOST \x1b[0m'
          : 'DRAW';

      console.log(`\n=======================================================`);
      console.log(
        `  ${tag}  ${formatPairDisplay(trade.asset)} (${trade.direction}) | Trade PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
      );
      console.log(
        `  Session PnL: ${st.sessionNetPnL >= 0 ? '+' : ''}$${st.sessionNetPnL.toFixed(2)} (Goal +$${limits.profitGoal.toFixed(
          2
        )} / Stop -$${limits.maxSessionLoss.toFixed(2)}) | Daily: ${st.dailyNetPnL >= 0 ? '+' : ''}$${st.dailyNetPnL.toFixed(
          2
        )} / -$${limits.maxDailyLoss.toFixed(2)}`
      );
      console.log(
        `  Record: ${st.sessionWins}W - ${st.sessionLosses}L - ${st.sessionDraws}D | Trades: ${st.tradesOpened}/${limits.maxTradesPerSession}`
      );
      console.log(`=======================================================\n`);

      if (update.haltSession) {
        this.announceHalt(update.haltReason || 'Risk limit reached');
      }
    });

    // Verify stake can actually be set in Quotex Redux store
    const stakeVerified = await controller.setInvestmentStake(limits.stakeAmount);
    if (!stakeVerified) {
      console.log(
        `[Warning] Could not immediately verify stake $${limits.stakeAmount} in Quotex Redux store; will re-verify before any entry.`
      );
    }

    console.log(
      `[Auto-Trader] Calibrating watchlist (strict train/holdout split, zero OOS peeking, ${
        strictProvenOnly ? 'PROVEN_EDGE only' : 'PRELIMINARY + PROVEN_EDGE'
      }, OTC: ${limits.allowOtc ? 'allowed' : 'blocked'})...`
    );

    let lastFirstPtVal = -1;

    const calibrateAndPruneWatchlist = async (desiredCleanTabs: number = 3) => {
      needsWatchlistRefill = false;
      const activeTf = sniffer.getActiveTimeframe() || 300;
      for (let round = 0; round < 3; round++) {
        if (this.stopped || this.risk.isHalted() || page.isClosed()) break;
        const tabs = await controller.ensureMultiMarketTabsOpen(4, 80, getBlacklistedSet(), {
          allowOtc: limits.allowOtc,
          activeTimeframeSeconds: activeTf,
        });
        let verifiedCleanCount = 0;

        for (const tab of tabs) {
          if (this.stopped || this.risk.isHalted() || page.isClosed()) break;

          if (!limits.allowOtc && tab.normAsset.endsWith('_OTC')) {
            if (tabs.length > 1) {
              await blacklistAndRemoveTab(tab.rawSymbol, tab.normAsset, tab.label, 'OTC disabled by user', 60);
            }
            continue;
          }

          if (tab.payout < 80 && tabs.length > 1) {
            await blacklistAndRemoveTab(tab.rawSymbol, tab.normAsset, tab.label, `Low payout (${tab.payout}%)`, 30);
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

          const report = brain.calibratePairPlaybook(
            snap.normAsset,
            closedHistory,
            snap.payout,
            snap.timeframeSeconds,
            { strictProvenOnly }
          );

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
            const pbLbl = PLAYBOOK_DISPLAY_NAMES[report.bestPlaybook];
            const s = report.bestStats;
            const oosTotal = s.oosWins + s.oosLosses;
            console.log(
              `  \x1b[32m✓ KEEP\x1b[0m   ${snap.label.padEnd(16)} (${snap.payout}%) | ${pbLbl} [${
                report.bestProfile.name
              } · ${expLbl}] | Untouched OOS: ${s.oosWins}/${oosTotal} (${s.oosWinRate.toFixed(
                1
              )}%, 95% CI ${s.oosWilsonLow95.toFixed(0)}-${s.oosWilsonHigh95.toFixed(0)}%) | Shrunk Est: ${s.estimatedWinRate.toFixed(
                1
              )}% | Tier: ${report.tier} (${report.candlesTested}c)`
            );
          } else {
            console.log(
              `  \x1b[31m✗ SKIP\x1b[0m   ${snap.label.padEnd(16)} (${snap.payout}%) | ${report.removeReason || 'No OOS edge'}`
            );
            const curTabs = await controller.getOpenMarketTabs();
            if (curTabs.length > 1) {
              await blacklistAndRemoveTab(
                snap.rawSymbol,
                snap.normAsset,
                snap.label,
                report.removeReason || 'Failed untouched OOS calibration',
                30
              );
            } else {
              blacklistedUntil.set(snap.normAsset, Date.now() + 20 * 60 * 1000);
            }
          }

          await sleep(3500 + Math.floor(Math.random() * 1500));
        }

        if (verifiedCleanCount >= desiredCleanTabs) break;
      }

      const finalVerified = Array.from(calibrationCache.values())
        .filter((c) => c.report.isTradeable)
        .map((c) => {
          const s = c.report.bestStats!;
          return `${c.label} [${PLAYBOOK_DISPLAY_NAMES[c.report.bestPlaybook]}/${c.report.bestProfile.name} ${QuotexController.formatTimeframe(
            c.report.recommendedExpirySeconds
          )} · OOS ${s.oosWins}/${s.oosWins + s.oosLosses} · ${c.report.tier}]`;
        });
      console.log(
        `\n[Auto-Trader] Calibrated Watchlist (${finalVerified.length} pairs): ${
          finalVerified.length > 0 ? finalVerified.join(' | ') : 'None passed untouched OOS check (waiting honestly)'
        }\n`
      );
    };

    await calibrateAndPruneWatchlist(3);

    const firstVerified = Array.from(calibrationCache.values()).find((c) => c.report.isTradeable);
    if (firstVerified) {
      await controller.configureOnScreenIndicators(firstVerified.report.bestProfile);
    }

    let currentTabIndex = 0;
    let lastTabSwitchAt = Date.now();
    let lastRecalibrationAt = Date.now();
    let nextQuietHoldMs = 30000 + Math.floor(Math.random() * 10000);
    let lastLoopHeartbeatAt = Date.now();

    this.watchdogTimer = setInterval(() => {
      if (!this.stopped && !this.risk.isHalted() && Date.now() - lastLoopHeartbeatAt > 25000) {
        console.log(`\n[Watchdog] Slow browser poll detected (Chrome throttled/backgrounded) — continuing...`);
        lastLoopHeartbeatAt = Date.now();
      }
    }, 10000);

    while (!this.stopped && !this.risk.isHalted() && !page.isClosed()) {
      lastLoopHeartbeatAt = Date.now();
      try {
        const riskCheck = this.risk.canOpenTrade(sniffer.getBalance()?.balance);
        if (!riskCheck.allowed && riskCheck.haltSession) {
          this.announceHalt(riskCheck.reason || 'Risk limit reached');
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

        if ((needsWatchlistRefill || urgentRecalibrateAssets.size > 0) && remMs > 28000) {
          await calibrateAndPruneWatchlist(3);
          lastTabSwitchAt = Date.now();
          continue;
        }

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

        const idleMaxMs = Math.max(3 * cycleMs, 12 * 60 * 1000);
        let prunedAny = false;
        for (const t of openTabs) {
          if (!limits.allowOtc && t.normAsset.endsWith('_OTC') && openTabs.length > 1) {
            await blacklistAndRemoveTab(t.rawSymbol, t.normAsset, t.label, 'OTC disabled by user', 60);
            prunedAny = true;
            break;
          }
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
              `0 valid setups in ${idleMins}m`,
              20
            );
            prunedAny = true;
            break;
          }
        }
        if (prunedAny) continue;

        const activeTab = openTabs.find((t) => t.isActive) || openTabs[0];
        const focusStartMs = activeTf >= 300 ? 44000 : Math.min(20000, cycleMs * 0.4);
        const entryWindowPreMs = activeTf >= 300 ? 12000 : Math.min(6000, cycleMs * 0.2);
        const entryWindowPostMs = activeTf >= 300 ? 9000 : Math.min(5000, cycleMs * 0.15);

        const evaluateVerifiedMarketNow = async (tab: OpenMarketTab, allowNearlyClosedForming: boolean) => {
          const snap = await controller.switchToMarketTabAndVerify(tab.rawSymbol, lastFirstPtVal);
          if (!snap) return null;
          lastFirstPtVal = snap.firstPointValue;

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
          if (closedHistory.length < 70) return null;

          const remNowMs =
            Math.ceil(Date.now() / (snap.timeframeSeconds * 1000)) * (snap.timeframeSeconds * 1000) - Date.now();
          const useForming = allowNearlyClosedForming && formingCandle && remNowMs <= 4000;
          const evalCandles = useForming
            ? [...closedHistory, { ...formingCandle, isClosed: true }]
            : closedHistory;

          const visual = visualEngine.analyzeCandles(evalCandles);
          const isOtc = snap.normAsset.endsWith('_OTC');

          let cachedCal = calibrationCache.get(snap.normAsset)?.report ?? null;
          if (!cachedCal || cachedCal.payoutPercent !== snap.payout || cachedCal.timeframeSeconds !== snap.timeframeSeconds) {
            cachedCal = brain.calibratePairPlaybook(
              snap.normAsset,
              closedHistory,
              snap.payout,
              snap.timeframeSeconds,
              { strictProvenOnly }
            );
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
            cachedCal,
            { strictProvenOnly, pairLossStreakLimit: limits.pairConsecutiveLossCooldown }
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

        // ── CANDLE-BOUNDARY ENTRY EXECUTION WINDOW ──
        const isPreEntryWindow = remMs <= entryWindowPreMs && remMs >= 1000;
        const isPostOpenWindow = elapsedMs <= entryWindowPostMs;

        if (isPreEntryWindow || isPostOpenWindow) {
          const targetCycleMs = isPreEntryWindow ? nextCandleOpenMs : prevCandleOpenMs;
          const res = await evaluateVerifiedMarketNow(activeTab, isPreEntryWindow);
          if (res) {
            const { snap, intel } = res;
            const cycleKey = `${snap.normAsset}_${targetCycleMs}_${snap.timeframeSeconds}`;
            const isOtcBlocked = !limits.allowOtc && snap.normAsset.endsWith('_OTC');

            if (
              !isOtcBlocked &&
              (intel.directionCall === 'CALL' || intel.directionCall === 'PUT') &&
              !tradedCycles.has(cycleKey) &&
              !openTradesByAsset.has(snap.normAsset) &&
              !snap.hasOpenDealOnSymbol &&
              openTradesByAsset.size < 2 &&
              snap.totalOpenDealsCount < 2
            ) {
              const preTradeCheck = this.risk.canOpenTrade(sniffer.getBalance()?.balance);
              if (!preTradeCheck.allowed) {
                if (preTradeCheck.haltSession) this.announceHalt(preTradeCheck.reason || 'Risk limit hit');
                break;
              }

              pairLastProductiveAt.set(snap.normAsset, Date.now());
              const optimalExpirySec = intel.recommendedExpirySeconds || snap.timeframeSeconds;
              const expLabel = QuotexController.formatTimeframe(optimalExpirySec);

              watcher.setPendingSignalContext(
                snap.normAsset,
                intel.estimatedWinProb,
                intel.factors.join(' | '),
                intel.marketRegime,
                intel.indicatorsAtEntry
              );

              const execResult = await controller.executeTradeOnScreen({
                expectedRawSymbol: snap.rawSymbol,
                direction: intel.directionCall,
                stakeAmount: limits.stakeAmount,
                timeframeSeconds: optimalExpirySec,
              });

              if (execResult.executed) {
                this.risk.recordTradeOpened();
                if (execResult.dealId) {
                  watcher.attachSignalContext(
                    execResult.dealId,
                    intel.estimatedWinProb,
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
                  `  \x1b[44m\x1b[97m AUTO-TRADE EXECUTED \x1b[0m  ${bold}${snap.label}; ${entryClock}; ${color}${dirBadge}${reset}`
                );
                console.log(
                  `  Stake: ${bold}$${limits.stakeAmount.toFixed(2)}${reset} | Expiry: ${bold}${expLabel} (TO ${toClock})${reset} | Payout: ${
                    snap.payout
                  }% | Entry: ${(execResult.entryPrice ?? snap.price).toFixed(5)}`
                );
                console.log(`-------------------------------------------------------`);
                console.log(
                  `  Playbook: ${intel.playbookLabel} [${intel.activeProfile.name}] | Tier: ${intel.calibrationTier} | Shrunk Est: ${intel.estimatedWinProb.toFixed(
                    1
                  )}% | EV: ${intel.expectedValuePerDollar >= 0 ? '+' : ''}$${intel.expectedValuePerDollar.toFixed(3)}/$1`
                );
                for (const reason of intel.factors) {
                  console.log(`  * ${reason}`);
                }
                console.log(`=======================================================\n`);

                const spokenPair = snap.label.replace('(OTC)', 'O T C').replace('/', ' ');
                playAlertSound(
                  `Auto trade placed: ${spokenPair}, ${isCall ? 'CALL UP' : 'PUT DOWN'}, ${limits.stakeAmount} dollars, ${expLabel} expiry`,
                  `AUTO-TRADE: ${snap.label} (${intel.directionCall})`,
                  `Stake: $${limits.stakeAmount.toFixed(2)} | Expiry: ${expLabel} (to ${toClock}) | Payout: ${snap.payout}%`
                );
              } else if (execResult.reason) {
                console.log(`\n[Auto-Trade Skipped] ${snap.label}: ${execResult.reason}`);
              }
            }
          }
          await sleep(2200);
          continue;
        }

        // ── PRE-CANDLE FOCUS SCAN ──
        if (remMs <= focusStartMs && remMs > entryWindowPreMs) {
          const verifiedTabs = openTabs.filter((t) => calibrationCache.get(t.normAsset)?.report.isTradeable);
          const scanList = verifiedTabs.length > 0 ? verifiedTabs : openTabs.slice(0, 3);
          let bestCandidate: { tab: OpenMarketTab; score: number } | null = null;

          for (const t of scanList) {
            if (this.stopped || this.risk.isHalted() || page.isClosed()) break;
            const remCheck = Math.ceil(Date.now() / cycleMs) * cycleMs - Date.now();
            if (remCheck <= entryWindowPreMs + 1500) break;

            const res = await evaluateVerifiedMarketNow(t, true);
            if (res && (res.intel.directionCall === 'CALL' || res.intel.directionCall === 'PUT')) {
              pairLastProductiveAt.set(res.snap.normAsset, Date.now());
              // Rank candidates strictly by untouched OOS EV per dollar
              const rankScore = res.intel.expectedValuePerDollar;
              if (!bestCandidate || rankScore > bestCandidate.score) {
                bestCandidate = { tab: t, score: rankScore };
              }
            }
            await sleep(4500 + Math.floor(Math.random() * 1500));
          }

          if (bestCandidate && bestCandidate.tab.rawSymbol !== activeTab.rawSymbol) {
            await controller.switchToMarketTabAndVerify(bestCandidate.tab.rawSymbol, lastFirstPtVal);
          }
          lastTabSwitchAt = Date.now();
          await sleep(2000);
          continue;
        }

        // ── QUIET MID-CANDLE OBSERVATION ──
        const shouldGlanceNext = openTabs.length > 1 && Date.now() - lastTabSwitchAt >= nextQuietHoldMs;
        let tabToObserve = activeTab;
        if (shouldGlanceNext) {
          currentTabIndex = (currentTabIndex + 1) % openTabs.length;
          tabToObserve = openTabs[currentTabIndex];
          lastTabSwitchAt = Date.now();
          nextQuietHoldMs = 30000 + Math.floor(Math.random() * 10000);
        }

        const obs = await evaluateVerifiedMarketNow(tabToObserve, false);
        if (obs) {
          const { snap, intel } = obs;

          if (intel.shouldSwitchPair && openTabs.length > 1 && intel.volatilityState === 'ERRATIC_SPIKE') {
            await blacklistAndRemoveTab(snap.rawSymbol, snap.normAsset, snap.label, intel.switchReason || 'Erratic volatility', 30);
            continue;
          }

          const mode = sniffer.getAccountMode();
          const bal = sniffer.getBalance()?.balance ?? sessionStartBalance;
          const st = this.risk.getStats();
          const pnlStr = `${st.sessionNetPnL >= 0 ? '+' : ''}$${st.sessionNetPnL.toFixed(0)} [+${limits.profitGoal}/-${limits.maxSessionLoss}]`;
          const remainingSec = Math.max(0, Math.round(remMs / 1000));
          const minStr = String(Math.floor(remainingSec / 60)).padStart(2, '0');
          const secStr = String(remainingSec % 60).padStart(2, '0');
          const nextClock = formatClockHHMM(nextCandleOpenMs, activeTf < 60);
          const expLbl = QuotexController.formatTimeframe(intel.recommendedExpirySeconds);
          const s = intel.calibration.bestStats;
          const pbStr =
            intel.calibration.isTradeable && s
              ? `${intel.playbookLabel}/${intel.activeProfile.name} ${expLbl} (OOS ${s.oosWins}/${s.oosWins + s.oosLosses} · ${intel.calibrationTier})`
              : 'No OOS edge';

          status.show(
            `[AUTO ${mode} $${bal.toFixed(0)} | PnL ${pnlStr}] ${snap.label} @ ${snap.price.toFixed(5)} (${
              snap.payout
            }%) | ${tfLabel} (Next ${nextClock} in ${minStr}:${secStr}) | ${pbStr}`
          );
        }

        await sleep(2500);
      } catch (err) {
        console.log(`\n[Auto-Trader Recovery] Transient error handled: ${(err as Error)?.message || 'unknown'}`);
        await sleep(3000);
      }
    }

    this.stop();
  }

  private announceHalt(reason: string): void {
    const st = this.risk.getStats();
    console.log(`\n╔═══════════════════════════════════════════════════════╗`);
    console.log(`║  AUTO-TRADER HALTED BY RISK CONTROL                   ║`);
    console.log(`║  Reason : ${reason.slice(0, 44).padEnd(44)}║`);
    console.log(
      `║  Session: ${(st.sessionNetPnL >= 0 ? '+' : '') + '$' + st.sessionNetPnL.toFixed(2)} (${st.sessionWins}W-${st.sessionLosses}L) | Daily: ${(st.dailyNetPnL >= 0 ? '+' : '') + '$' + st.dailyNetPnL.toFixed(2)}`.padEnd(
        56
      ) + `║`
    );
    console.log(`╚═══════════════════════════════════════════════════════╝\n`);
    playAlertSound(`Auto trader halted. ${reason}`, 'AUTO-TRADER HALTED', reason);
    this.stop();
  }
}
