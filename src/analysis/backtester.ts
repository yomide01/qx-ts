import fs from 'fs';
import { pathToFileURL } from 'url';
import { Candle } from '../stream/types.js';
import { normalizeAsset } from '../stream/assets.js';
import { TradingJournalDB } from '../journal/database.js';
import {
  SignalEngine,
  ALL_PLAYBOOKS,
  ALL_PROFILES,
  PLAYBOOK_DISPLAY_NAMES,
  PlaybookName,
  IndicatorProfile,
  precomputeProfileSeries,
} from './signalEngine.js';
import {
  breakevenWinRate,
  wilsonInterval,
  bonferroniZ,
  binomialOneSidedPValue,
  expectedValuePerDollar,
  halfKellyFraction,
  edgeVerdict,
  EdgeVerdict,
} from './binaryMath.js';

export interface BacktestOptions {
  payoutPercent?: number;
  trainBars?: number;
  testBars?: number;
  stepBars?: number;
  minTrainTrades?: number;
  /** Number of sign-flip random-walk Monte Carlo trials for baseline comparison (default 50). */
  monteCarloTrials?: number;
  /** Deterministic PRNG seed for Monte Carlo trials. */
  seed?: number;
}

export interface SimulatedTrade {
  entryIdx: number;
  exitIdx: number;
  openTime: number;
  direction: 'CALL' | 'PUT';
  playbook: PlaybookName;
  profile: string;
  horizon: number;
  entryPrice: number;
  exitPrice: number;
  outcome: 'WON' | 'LOST' | 'DRAW';
  pnlUnits: number;
}

export interface StaticVariantResult {
  playbook: PlaybookName;
  profile: string;
  horizon: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  wilson95Low: number;
  wilson95High: number;
  rawPValue: number;
  bonferroniPValue: number;
  evPerDollar: number;
  netUnits: number;
}

export interface BacktestReport {
  asset: string;
  timeframeSeconds: number;
  candleCount: number;
  payoutPercent: number;
  breakevenWinRate: number;
  foldsEvaluated: number;
  trades: SimulatedTrade[];
  totalDecided: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  wilson95Low: number;
  wilson95High: number;
  pValue: number;
  evPerDollar: number;
  halfKelly: number;
  netUnits: number;
  maxDrawdownUnits: number;
  maxConsecutiveLosses: number;
  profitFactor: number;
  verdict: EdgeVerdict;
  variantsTested: number;
  bestStaticVariant: StaticVariantResult | null;
  monteCarloBaseline?: {
    trials: number;
    meanWinRate: number;
    p95WinRate: number;
    empiricalBeatsNoisePValue: number;
  };
}

/** Deterministic Mulberry32 PRNG for reproducible permutation baselines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a volatility-preserving random-walk candle series by randomly flipping
 * the direction of each candle's return and re-anchoring OHLC continuously.
 */
export function buildSignFlippedCandles(candles: Candle[], seed: number): Candle[] {
  if (candles.length === 0) return [];
  const rand = mulberry32(seed);
  const out: Candle[] = [];
  let price = candles[0].open;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const sign = rand() < 0.5 ? 1 : -1;
    const body = (c.close - c.open) * sign;
    const upperWick = Math.max(0, c.high - Math.max(c.open, c.close));
    const lowerWick = Math.max(0, Math.min(c.open, c.close) - c.low);

    const open = price;
    const close = Math.max(1e-6, open + body);
    const high = Math.max(open, close) + (sign > 0 ? upperWick : lowerWick);
    const low = Math.max(1e-6, Math.min(open, close) - (sign > 0 ? lowerWick : upperWick));

    out.push({
      asset: c.asset,
      timeframe: c.timeframe,
      openTime: c.openTime,
      open,
      high,
      low,
      close,
      isClosed: true,
    });
    price = close;
  }
  return out;
}

/**
 * Parses standard OHLC CSV files (time/timestamp/date, open, high, low, close).
 */
export function parseOhlcCsv(csvContent: string, asset: string, timeframeSeconds: number): Candle[] {
  const normAsset = normalizeAsset(asset);
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const candles: Candle[] = [];
  let startIdx = 0;
  let colMap = { time: 0, open: 1, high: 2, low: 3, close: 4 };

  // Detect optional header row
  const firstCols = lines[0].split(/[,;\t]/).map((s) => s.trim().toLowerCase());
  if (firstCols.some((c) => /open|close|high|low|time|date/.test(c))) {
    startIdx = 1;
    const find = (re: RegExp, fallback: number) => {
      const idx = firstCols.findIndex((c) => re.test(c));
      return idx >= 0 ? idx : fallback;
    };
    colMap = {
      time: find(/time|date|timestamp/, 0),
      open: find(/^open$|^o$/, 1),
      high: find(/^high$|^h$/, 2),
      low: find(/^low$|^l$/, 3),
      close: find(/^close$|^c$/, 4),
    };
  }

  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(/[,;\t]/).map((s) => s.trim());
    if (parts.length < 5) continue;
    const rawTime = parts[colMap.time];
    let openTime = Number(rawTime);
    if (!Number.isFinite(openTime)) {
      openTime = Date.parse(rawTime.includes('T') ? rawTime : rawTime.replace(' ', 'T') + 'Z');
    } else if (openTime < 1e11) {
      openTime = Math.round(openTime * 1000);
    }

    const open = Number(parts[colMap.open]);
    const high = Number(parts[colMap.high]);
    const low = Number(parts[colMap.low]);
    const close = Number(parts[colMap.close]);

    if (
      Number.isFinite(openTime) &&
      openTime > 0 &&
      Number.isFinite(open) &&
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close) &&
      open > 0
    ) {
      candles.push({
        asset: normAsset,
        timeframe: timeframeSeconds,
        openTime,
        open,
        high: Math.max(open, high, close),
        low: Math.min(open, low, close),
        close,
        isClosed: true,
      });
    }
  }

  return candles.sort((a, b) => a.openTime - b.openTime);
}

/**
 * Runs a strict, leak-free Rolling Walk-Forward Backtest over `candles`.
 *
 * For every fold:
 *  - Selects the single best (playbook, profile, horizon) strictly inside the Training window
 *    using Bonferroni-adjusted Wilson lower bound.
 *  - Simulates non-overlapping trades strictly inside the untouched forward Test window.
 *  - Aggregates all out-of-sample trades and compares against both break-even and a
 *    sign-flipped random-walk baseline.
 */
export function runRollingWalkForwardBacktest(
  candles: Candle[],
  options: BacktestOptions = {}
): BacktestReport {
  const payoutPercent = options.payoutPercent ?? 85;
  const payoutDec = payoutPercent / 100;
  const beWinRate = breakevenWinRate(payoutPercent);
  const trainBars = options.trainBars ?? Math.min(180, Math.max(80, Math.floor(candles.length * 0.45)));
  const testBars = options.testBars ?? Math.min(60, Math.max(30, Math.floor(candles.length * 0.15)));
  const stepBars = options.stepBars ?? testBars;
  const minTrainTrades = options.minTrainTrades ?? 5;
  const mcTrials = options.monteCarloTrials ?? 40;
  const seed = options.seed ?? 42;

  const asset = candles[0]?.asset ?? 'UNKNOWN';
  const timeframeSeconds = candles[0]?.timeframe ?? 300;
  const horizons = timeframeSeconds <= 60 || timeframeSeconds === 300 ? [1, 2, 3] : [1, 2];

  const engine = new SignalEngine();

  // Precompute all 3 profiles ONCE in O(N) for ultra-fast rolling folds and static audit
  const profileSignals = new Map<
    string,
    { playbook: PlaybookName; profile: IndicatorProfile; signals: Map<number, 'CALL' | 'PUT'> }
  >();

  for (const prof of ALL_PROFILES) {
    const series = precomputeProfileSeries(candles, prof);
    for (const pb of ALL_PLAYBOOKS) {
      const sigMap = new Map<number, 'CALL' | 'PUT'>();
      for (let i = series.minNeeded - 1; i < candles.length - 1; i++) {
        const res = engine.evaluatePlaybookAt(pb, series, i);
        if (res) sigMap.set(i, res.direction);
      }
      profileSignals.set(`${pb}|${prof.name}`, { playbook: pb, profile: prof, signals: sigMap });
    }
  }

  const totalVariants = ALL_PLAYBOOKS.length * ALL_PROFILES.length * horizons.length;
  const bonfZ = bonferroniZ(totalVariants, 0.05, false);

  // ── 1. ROLLING WALK-FORWARD SIMULATION ──
  const trades: SimulatedTrade[] = [];
  let foldsEvaluated = 0;

  if (candles.length >= trainBars + 10) {
    for (let foldStart = 0; foldStart + trainBars < candles.length - 1; foldStart += stepBars) {
      const splitIdx = foldStart + trainBars;
      const testEnd = Math.min(candles.length, splitIdx + testBars);
      if (testEnd - splitIdx < 3) break;
      foldsEvaluated++;

      // Step A: Select #1 variant strictly within [foldStart .. splitIdx - 1]
      let bestChoice: {
        playbook: PlaybookName;
        profile: IndicatorProfile;
        horizon: number;
        signals: Map<number, 'CALL' | 'PUT'>;
        score: number;
        trainWr: number;
      } | null = null;

      for (const entry of profileSignals.values()) {
        for (const h of horizons) {
          let tw = 0;
          let tl = 0;
          let nextAllowedEntry = foldStart;

          for (let i = foldStart; i < splitIdx - 1; i++) {
            const dir = entry.signals.get(i);
            if (!dir) continue;
            const entryIdx = i + 1;
            const exitIdx = i + h;
            if (entryIdx < nextAllowedEntry || exitIdx >= splitIdx) continue;

            const ep = candles[entryIdx].open;
            const xp = candles[exitIdx].close;
            nextAllowedEntry = exitIdx + 1;
            if (xp === ep) continue;

            const won = (dir === 'CALL' && xp > ep) || (dir === 'PUT' && xp < ep);
            if (won) tw++;
            else tl++;
          }

          const tot = tw + tl;
          if (tot < minTrainTrades) continue;
          const wr = (tw / tot) * 100;
          if (wr <= beWinRate) continue;

          const score = wilsonInterval(tw, tot, bonfZ).low;
          if (!bestChoice || score > bestChoice.score || (score === bestChoice.score && wr > bestChoice.trainWr)) {
            bestChoice = {
              playbook: entry.playbook,
              profile: entry.profile,
              horizon: h,
              signals: entry.signals,
              score,
              trainWr: wr,
            };
          }
        }
      }

      if (!bestChoice) continue;

      // Step B: Simulate ONLY bestChoice on untouched forward window [splitIdx .. testEnd - 1]
      let nextAllowed = splitIdx;
      for (let i = splitIdx; i < testEnd - 1; i++) {
        const dir = bestChoice.signals.get(i);
        if (!dir) continue;
        const entryIdx = i + 1;
        const exitIdx = i + bestChoice.horizon;
        if (entryIdx < nextAllowed || exitIdx >= candles.length) continue;

        const entryPrice = candles[entryIdx].open;
        const exitPrice = candles[exitIdx].close;
        nextAllowed = exitIdx + 1;

        let outcome: SimulatedTrade['outcome'] = 'DRAW';
        let pnlUnits = 0;
        if (exitPrice !== entryPrice) {
          const won = (dir === 'CALL' && exitPrice > entryPrice) || (dir === 'PUT' && exitPrice < entryPrice);
          outcome = won ? 'WON' : 'LOST';
          pnlUnits = won ? payoutDec : -1;
        }

        trades.push({
          entryIdx,
          exitIdx,
          openTime: candles[entryIdx].openTime,
          direction: dir,
          playbook: bestChoice.playbook,
          profile: bestChoice.profile.name,
          horizon: bestChoice.horizon,
          entryPrice,
          exitPrice,
          outcome,
          pnlUnits,
        });
      }
    }
  }

  // ── 2. COMPUTE EQUITY, DRAWDOWN, STREAKS & STATISTICAL VERDICT ──
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownUnits = 0;
  let curLossStreak = 0;
  let maxConsecutiveLosses = 0;
  let grossWin = 0;
  let grossLoss = 0;

  for (const t of trades) {
    equity += t.pnlUnits;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownUnits) maxDrawdownUnits = dd;

    if (t.outcome === 'WON') {
      wins++;
      grossWin += t.pnlUnits;
      curLossStreak = 0;
    } else if (t.outcome === 'LOST') {
      losses++;
      grossLoss += Math.abs(t.pnlUnits);
      curLossStreak++;
      if (curLossStreak > maxConsecutiveLosses) maxConsecutiveLosses = curLossStreak;
    } else {
      draws++;
    }
  }

  const totalDecided = wins + losses;
  const winRate = totalDecided > 0 ? (wins / totalDecided) * 100 : 0;
  const ci95 = wilsonInterval(wins, totalDecided, 1.96);
  const pValue = binomialOneSidedPValue(wins, totalDecided, beWinRate / 100);
  const evPerDollar = totalDecided > 0 ? expectedValuePerDollar(winRate, payoutPercent) : 0;
  const hk = totalDecided > 0 ? halfKellyFraction(winRate, payoutPercent) : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const verdict = edgeVerdict(wins, totalDecided, payoutPercent);

  // ── 3. STATIC VARIANT AUDIT WITH BONFERRONI CORRECTION ──
  const staticResults: StaticVariantResult[] = [];
  for (const entry of profileSignals.values()) {
    for (const h of horizons) {
      let sw = 0;
      let sl = 0;
      let sd = 0;
      let nextAllowed = 0;
      for (let i = 0; i < candles.length - 1; i++) {
        const dir = entry.signals.get(i);
        if (!dir) continue;
        const entryIdx = i + 1;
        const exitIdx = i + h;
        if (entryIdx < nextAllowed || exitIdx >= candles.length) continue;
        nextAllowed = exitIdx + 1;
        const ep = candles[entryIdx].open;
        const xp = candles[exitIdx].close;
        if (xp === ep) {
          sd++;
          continue;
        }
        const won = (dir === 'CALL' && xp > ep) || (dir === 'PUT' && xp < ep);
        if (won) sw++;
        else sl++;
      }
      const tot = sw + sl;
      if (tot < 5) continue;
      const wr = (sw / tot) * 100;
      const w95 = wilsonInterval(sw, tot, 1.96);
      const rawP = binomialOneSidedPValue(sw, tot, beWinRate / 100);
      staticResults.push({
        playbook: entry.playbook,
        profile: entry.profile.name,
        horizon: h,
        wins: sw,
        losses: sl,
        draws: sd,
        winRate: wr,
        wilson95Low: w95.low,
        wilson95High: w95.high,
        rawPValue: rawP,
        bonferroniPValue: Math.min(1, rawP * totalVariants),
        evPerDollar: expectedValuePerDollar(wr, payoutPercent),
        netUnits: sw * payoutDec - sl,
      });
    }
  }
  staticResults.sort((a, b) => b.wilson95Low - a.wilson95Low);
  const bestStaticVariant = staticResults[0] ?? null;

  // ── 4. SIGN-FLIPPED RANDOM WALK PERMUTATION BASELINE ──
  let monteCarloBaseline: BacktestReport['monteCarloBaseline'];
  if (mcTrials > 0 && candles.length >= trainBars + 10) {
    const nullWinRates: number[] = [];
    let geObserved = 0;
    for (let t = 0; t < mcTrials; t++) {
      const shuffled = buildSignFlippedCandles(candles, seed + t * 9973);
      const res = runRollingWalkForwardBacktest(shuffled, {
        payoutPercent,
        trainBars,
        testBars,
        stepBars,
        minTrainTrades,
        monteCarloTrials: 0,
      });
      const wr = res.totalDecided > 0 ? res.winRate : 50;
      nullWinRates.push(wr);
      if (wr >= winRate) geObserved++;
    }
    nullWinRates.sort((a, b) => a - b);
    const meanWinRate = nullWinRates.reduce((a, b) => a + b, 0) / nullWinRates.length;
    const p95WinRate = nullWinRates[Math.min(nullWinRates.length - 1, Math.floor(nullWinRates.length * 0.95))];
    monteCarloBaseline = {
      trials: mcTrials,
      meanWinRate,
      p95WinRate,
      empiricalBeatsNoisePValue: (geObserved + 1) / (mcTrials + 1),
    };
  }

  return {
    asset,
    timeframeSeconds,
    candleCount: candles.length,
    payoutPercent,
    breakevenWinRate: beWinRate,
    foldsEvaluated,
    trades,
    totalDecided,
    wins,
    losses,
    draws,
    winRate,
    wilson95Low: ci95.low,
    wilson95High: ci95.high,
    pValue,
    evPerDollar,
    halfKelly: hk,
    netUnits: equity,
    maxDrawdownUnits,
    maxConsecutiveLosses,
    profitFactor,
    verdict,
    variantsTested: totalVariants,
    bestStaticVariant,
    monteCarloBaseline,
  };
}

export function formatBacktestReport(r: BacktestReport): string {
  const lines: string[] = [];
  lines.push('================================================================');
  lines.push(`  WALK-FORWARD BACKTEST: ${r.asset} (${r.timeframeSeconds}s) | ${r.candleCount} closed candles`);
  lines.push('================================================================');
  lines.push(`Assumed Payout        : ${r.payoutPercent.toFixed(1)}% (Break-even WR: ${r.breakevenWinRate.toFixed(2)}%)`);
  lines.push(`Walk-Forward Folds    : ${r.foldsEvaluated}`);
  lines.push(`OOS Trades Executed   : ${r.totalDecided} decided (${r.wins}W - ${r.losses}L - ${r.draws}D)`);
  lines.push(`OOS Win Rate          : ${r.winRate.toFixed(2)}% (95% Wilson CI: ${r.wilson95Low.toFixed(1)}% - ${r.wilson95High.toFixed(1)}%)`);
  lines.push(`Exact Binomial p-val  : ${r.pValue.toFixed(4)} (vs break-even)`);
  lines.push(`Expected Value (EV)   : ${r.evPerDollar >= 0 ? '+' : ''}${(r.evPerDollar * 100).toFixed(2)}% per $1 staked`);
  lines.push(`Net PnL (1-unit stake): ${r.netUnits >= 0 ? '+' : ''}${r.netUnits.toFixed(2)} units | Profit Factor: ${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'inf'}`);
  lines.push(`Risk Profile          : Max Drawdown ${r.maxDrawdownUnits.toFixed(2)}u | Max Losing Streak: ${r.maxConsecutiveLosses} | Half-Kelly: ${(r.halfKelly * 100).toFixed(2)}%`);
  if (r.bestStaticVariant) {
    const s = r.bestStaticVariant;
    lines.push('----------------------------------------------------------------');
    lines.push(
      `Best Static Variant   : ${PLAYBOOK_DISPLAY_NAMES[s.playbook]}/${s.profile} (${s.horizon}c) -> ${s.wins}W-${s.losses}L (${s.winRate.toFixed(
        1
      )}%, 95% CI ${s.wilson95Low.toFixed(1)}-${s.wilson95High.toFixed(1)}%)`
    );
    lines.push(
      `Multiple-Test Adj (K=${r.variantsTested}): Raw p=${s.rawPValue.toFixed(4)} | Bonferroni p=${s.bonferroniPValue.toFixed(4)}`
    );
  }
  if (r.monteCarloBaseline) {
    const mc = r.monteCarloBaseline;
    lines.push('----------------------------------------------------------------');
    lines.push(
      `Random-Walk Baseline  : ${mc.trials} sign-flip trials -> Mean WR ${mc.meanWinRate.toFixed(
        1
      )}% | 95th pct ${mc.p95WinRate.toFixed(1)}% | Empirical p=${mc.empiricalBeatsNoisePValue.toFixed(3)}`
    );
  }
  lines.push('----------------------------------------------------------------');
  lines.push(`VERDICT [${r.verdict.verdict}]: ${r.verdict.message}`);
  lines.push('================================================================\n');
  return lines.join('\n');
}

async function pullHistoryFromOpenChrome(db: TradingJournalDB): Promise<Array<{ asset: string; timeframe: number; payout: number }>> {
  const { chromium } = await import('playwright');
  const { PERIOD_CODE_MAP_JS, REDUX_STORE_HELPER_JS } = await import('../browser/reduxBridge.js');
  const port = Number(process.env.CHROME_REMOTE_DEBUG || 9222);

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 4000 });
  } catch (err) {
    throw new Error(`Could not connect to Chrome on port ${port}: ${(err as Error).message}`);
  }

  const page = browser
    .contexts()[0]
    ?.pages()
    .find((p) => p.url().includes('quotex.com') || p.url().includes('qxbroker.com'));
  if (!page) {
    throw new Error('No open Quotex tab found in Chrome.');
  }

  const snap = (await page.evaluate(`(() => {
    ${REDUX_STORE_HELPER_JS}
    ${PERIOD_CODE_MAP_JS}
    const st = getReduxState();
    const g = st?.chartSettings?.chartById?.graph;
    if (!g || !g.currentAsset?.symbol || !Array.isArray(g.historyPoints)) return null;
    const tfSec = resolveCandleTimeframeSeconds(g);
    const obj = g.currentAsset.obj || {};
    const payout = tfSec >= 300 && obj.payout_5 ? obj.payout_5 : (obj.payout_1 || obj.payout || 85);
    return {
      symbol: g.currentAsset.symbol,
      timeframe: tfSec,
      payout,
      points: g.historyPoints,
    };
  })()`)) as { symbol: string; timeframe: number; payout: number; points: Array<{ value: number; time: number }> } | null;

  if (!snap || !snap.points || snap.points.length === 0) {
    throw new Error('Quotex Redux store did not return active chart historyPoints.');
  }

  const normAsset = normalizeAsset(snap.symbol);
  const tfMs = snap.timeframe * 1000;
  const map = new Map<number, Candle>();
  const sorted = [...snap.points].sort((a, b) => a.time - b.time);
  for (const pt of sorted) {
    const tMs = pt.time > 1e11 ? pt.time : pt.time * 1000;
    const openTime = Math.floor(tMs / tfMs) * tfMs;
    const cur = map.get(openTime);
    if (!cur) {
      map.set(openTime, {
        asset: normAsset,
        timeframe: snap.timeframe,
        openTime,
        open: pt.value,
        high: pt.value,
        low: pt.value,
        close: pt.value,
        isClosed: true,
      });
    } else {
      cur.high = Math.max(cur.high, pt.value);
      cur.low = Math.min(cur.low, pt.value);
      cur.close = pt.value;
    }
  }
  const candles = Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);
  if (candles.length > 0) candles.pop(); // exclude currently forming candle
  const saved = db.saveCandles(candles);
  console.log(`[Backtester] Pulled & archived ${saved} closed ${snap.timeframe}s candles for ${normAsset} (payout ${snap.payout}%).`);
  return [{ asset: normAsset, timeframe: snap.timeframe, payout: snap.payout }];
}

async function runCli() {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const payoutOverride = getArg('--payout') ? Number(getArg('--payout')) : undefined;
  const csvPath = getArg('--csv');
  const assetArg = getArg('--asset');
  const tfArg = getArg('--tf') ? Number(getArg('--tf')) : undefined;

  const db = new TradingJournalDB();
  try {
    if (csvPath) {
      const content = fs.readFileSync(csvPath, 'utf-8');
      const asset = assetArg || 'CSV_ASSET';
      const tf = tfArg || 300;
      const candles = parseOhlcCsv(content, asset, tf);
      if (candles.length < 80) {
        console.error(`[Backtester] CSV only contained ${candles.length} valid candles (need at least 80).`);
        process.exitCode = 1;
        return;
      }
      if (hasFlag('--save')) {
        db.saveCandles(candles);
        console.log(`[Backtester] Saved ${candles.length} candles into SQLite archive.`);
      }
      const report = runRollingWalkForwardBacktest(candles, { payoutPercent: payoutOverride ?? 85 });
      console.log(formatBacktestReport(report));
      return;
    }

    if (hasFlag('--pull-chrome')) {
      const pulled = await pullHistoryFromOpenChrome(db);
      for (const item of pulled) {
        const candles = db.getCandles(item.asset, item.timeframe, 5000);
        const report = runRollingWalkForwardBacktest(candles, {
          payoutPercent: payoutOverride ?? item.payout ?? 85,
        });
        console.log(formatBacktestReport(report));
      }
      return;
    }

    if (assetArg) {
      const tf = tfArg || 300;
      const candles = db.getCandles(assetArg, tf, 5000);
      if (candles.length < 80) {
        console.log(`[Backtester] Only ${candles.length} archived ${tf}s candles for ${normalizeAsset(assetArg)}. Need >= 80.`);
        return;
      }
      const report = runRollingWalkForwardBacktest(candles, { payoutPercent: payoutOverride ?? 85 });
      console.log(formatBacktestReport(report));
      return;
    }

    const seriesList = db.listCandleSeries().filter((s) => s.count >= 80);
    if (seriesList.length === 0) {
      console.log('[Backtester] No archived candle series with >= 80 candles found in data/qx_trading.db yet.');
      console.log('Options:');
      console.log('  1. Pull live chart history from open Chrome : npm run backtest -- --pull-chrome');
      console.log('  2. Backtest an OHLC CSV file                : npm run backtest -- --csv path.csv --asset EURUSD --tf 300');
      console.log('  3. Run the bot to auto-archive live candles : npm start');
      return;
    }

    for (const s of seriesList) {
      const candles = db.getCandles(s.asset, s.timeframe, 5000);
      const report = runRollingWalkForwardBacktest(candles, { payoutPercent: payoutOverride ?? 85 });
      console.log(formatBacktestReport(report));
    }
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Backtester Error]', (err as Error).message);
      process.exit(1);
    });
}
