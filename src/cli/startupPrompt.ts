import readline from 'readline';
import { QuotexController } from '../browser/quotexController.js';
import { QxWsSniffer } from '../stream/wsSniffer.js';
import { TradingJournalDB } from '../journal/database.js';
import {
  RiskLimits,
  evaluateLiveReadiness,
  LIVE_OVERRIDE_PHRASE,
  MIN_DEMO_TRADES_FOR_LIVE,
} from '../engine/riskManager.js';
import { sleep } from './format.js';

export type BotOperatingMode = 'MANUAL' | 'AUTO';
export type TargetAccountType = 'DEMO' | 'LIVE';

export interface StartupConfig {
  accountType: TargetAccountType;
  mode: BotOperatingMode;
  limits: RiskLimits;
  /** True only if user explicitly passed/overrode LIVE readiness gate. */
  allowPreliminaryOnLive: boolean;
}

function askQuestion(rl: readline.Interface, promptText: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      resolve((answer || '').trim());
    });
  });
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : fallback;
}

export async function promptStartupConfiguration(
  controller: QuotexController,
  sniffer: QxWsSniffer,
  db: TradingJournalDB
): Promise<StartupConfig> {
  const defaultProfitGoal = parsePositiveNumber(process.env.AUTO_PROFIT_GOAL, 100);
  const defaultMaxTrades = Math.max(1, Math.round(parsePositiveNumber(process.env.AUTO_MAX_TRADES, 20)));
  const defaultMaxConsec = Math.max(1, Math.round(parsePositiveNumber(process.env.AUTO_MAX_CONSEC_LOSSES, 4)));
  const defaultPairCooldown = Math.max(2, Math.round(parsePositiveNumber(process.env.PAIR_LOSS_COOLDOWN_STREAK, 3)));
  const envAllowOtc = (process.env.ALLOW_OTC ?? 'true').trim().toLowerCase() !== 'false';

  // Non-interactive env support for automated / scripted runs
  const envMode = (process.env.BOT_MODE || '').trim().toUpperCase();
  const envAcc = (process.env.BOT_ACCOUNT || '').trim().toUpperCase() as TargetAccountType | '';
  if (envMode === 'MANUAL' || envMode === 'AUTO') {
    let accountType: TargetAccountType = envAcc === 'LIVE' ? 'LIVE' : 'DEMO';
    let mode: BotOperatingMode = envMode;
    let allowPreliminaryOnLive = false;

    if (accountType === 'LIVE' && mode === 'AUTO') {
      const readiness = evaluateLiveReadiness(db.getAllTrades());
      const envOverride = (process.env.ALLOW_UNPROVEN_LIVE || '').trim() === 'YES_I_ACCEPT_LOSS';
      if (!readiness.ready && !envOverride) {
        console.log(`\n[LIVE SAFETY GATE] BLOCKED LIVE AUTO-TRADING: ${readiness.reason}`);
        console.log(`[LIVE SAFETY GATE] Falling back safely to MANUAL mode on DEMO.`);
        accountType = 'DEMO';
        mode = 'MANUAL';
      } else if (!readiness.ready && envOverride) {
        allowPreliminaryOnLive = true;
      }
    }

    await controller.switchAccountMode(accountType);
    await sleep(1000);
    const stake = Math.max(1, parsePositiveNumber(process.env.AUTO_STAKE, 10));
    const maxSessionLoss = parsePositiveNumber(process.env.AUTO_MAX_SESSION_LOSS, Math.max(stake * 3, 30));
    const maxDailyLoss = parsePositiveNumber(process.env.AUTO_MAX_DAILY_LOSS, Math.round(maxSessionLoss * 1.5));

    return {
      accountType,
      mode,
      allowPreliminaryOnLive,
      limits: {
        accountType,
        stakeAmount: stake,
        profitGoal: defaultProfitGoal,
        maxSessionLoss,
        maxDailyLoss,
        maxTradesPerSession: defaultMaxTrades,
        maxConsecutiveSessionLosses: defaultMaxConsec,
        pairConsecutiveLossCooldown: defaultPairCooldown,
        allowOtc: envAllowOtc,
      },
    };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const currentMode = sniffer.getAccountMode();
    const currentBal = sniffer.getBalance()?.balance ?? 0;

    // ── STEP 1: DEMO vs LIVE ──
    console.log(`\n=======================================================`);
    console.log(`  STEP 1: SELECT QUOTEX ACCOUNT (DEMO vs LIVE)`);
    console.log(`=======================================================`);
    console.log(`  Currently Open : ${currentMode} Account (Balance: $${currentBal.toFixed(2)})`);
    console.log(`  [1] DEMO       : Practice balance (recommended for testing)`);
    console.log(`  [2] LIVE       : Real money balance (requires >= ${MIN_DEMO_TRADES_FOR_LIVE} proven demo trades for AUTO)`);
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
      await sleep(1200);
      if (switched) {
        console.log(`[Account Switch] Active on ${accountType} Account.`);
      } else {
        console.log(`[Account Switch] Could not verify switch automatically — confirm ${accountType} in Chrome.`);
      }
    } else {
      console.log(`\n[Account] Staying on ${accountType} Account.`);
    }

    const activeBalance = sniffer.getBalance()?.balance ?? currentBal;

    // ── STEP 2: MANUAL vs AUTO ──
    console.log(`\n=======================================================`);
    console.log(`  STEP 2: SELECT OPERATING MODE`);
    console.log(`=======================================================`);
    console.log(`  Active Account : ${accountType} Account (Balance: $${activeBalance.toFixed(2)})`);
    console.log(`  [1] MANUAL     : Watch chart, archive candles & emit calibrated signals (no auto-clicks)`);
    console.log(`  [2] AUTOMATIC  : Multi-market scan with leak-free OOS check & hard loss limits`);
    console.log(`-------------------------------------------------------`);

    let selectedMode: BotOperatingMode = 'MANUAL';
    while (true) {
      const modeInput = (
        await askQuestion(rl, `Choose Mode — Enter [1] for MANUAL or [2] for AUTOMATIC: `)
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

    // ── STEP 3: OTC vs Exchange-Backed Live Markets ──
    const avail = sniffer.getMarketAvailabilityCounts();
    console.log(`\n-------------------------------------------------------`);
    console.log(`  MARKET FEED SELECTION (Available >=80%: ${avail.liveCount} Live, ${avail.otcCount} OTC)`);
    console.log(`  NOTE: OTC prices are generated by Quotex (your counterparty), not a central exchange.`);
    console.log(`  [1] Allow OTC + Live markets`);
    console.log(`  [2] Exchange-backed Live markets ONLY (skip OTC)`);
    const otcInput = (await askQuestion(rl, `Market feed [1=All / 2=Live Only] (default 1): `)).toLowerCase();
    const allowOtc = !(otcInput === '2' || otcInput === 'live' || otcInput === 'no' || otcInput === 'n');
    if (!allowOtc && avail.liveCount === 0) {
      console.log(`  [Notice] 0 exchange-backed live markets (>=80%) are open right now. Bot will wait for live hours.`);
    }

    if (selectedMode === 'MANUAL') {
      console.log(`\n>>> [MODE: MANUAL SIGNAL ASSISTANT on ${accountType}] Watching market & archiving candles.\n`);
      return {
        accountType,
        mode: 'MANUAL',
        allowPreliminaryOnLive: false,
        limits: {
          accountType,
          stakeAmount: 10,
          profitGoal: defaultProfitGoal,
          maxSessionLoss: 30,
          maxDailyLoss: 50,
          maxTradesPerSession: defaultMaxTrades,
          maxConsecutiveSessionLosses: defaultMaxConsec,
          pairConsecutiveLossCooldown: defaultPairCooldown,
          allowOtc,
        },
      };
    }

    // ── LIVE AUTO-TRADING READINESS GATE ──
    let allowPreliminaryOnLive = false;
    if (accountType === 'LIVE') {
      const readiness = evaluateLiveReadiness(db.getAllTrades());
      if (!readiness.ready) {
        console.log(`\n=======================================================`);
        console.log(`  \x1b[41m\x1b[97m LIVE AUTO-TRADING BLOCKED BY STATISTICAL GATE \x1b[0m`);
        console.log(`=======================================================`);
        console.log(`  ${readiness.reason}`);
        console.log(`  Journal verdict: ${readiness.verdict.verdict} — ${readiness.verdict.message}`);
        console.log(`  Run at least ${MIN_DEMO_TRADES_FOR_LIVE} demo trades and check 'npm run journal:report' first.`);
        console.log(`  To override anyway, type EXACTLY: ${LIVE_OVERRIDE_PHRASE}`);
        console.log(`  Press Enter (or anything else) to switch safely to MANUAL mode.`);
        console.log(`=======================================================`);

        const override = await askQuestion(rl, `Confirmation: `);
        if (override !== LIVE_OVERRIDE_PHRASE) {
          console.log(`\n>>> LIVE Auto-Trading refused. Switching safely to MANUAL Signal Assistant.\n`);
          return {
            accountType,
            mode: 'MANUAL',
            allowPreliminaryOnLive: false,
            limits: {
              accountType,
              stakeAmount: 10,
              profitGoal: defaultProfitGoal,
              maxSessionLoss: 30,
              maxDailyLoss: 50,
              maxTradesPerSession: defaultMaxTrades,
              maxConsecutiveSessionLosses: defaultMaxConsec,
              pairConsecutiveLossCooldown: defaultPairCooldown,
              allowOtc,
            },
          };
        }
        allowPreliminaryOnLive = true;
      }
    }

    // ── STEP 4 (AUTO): Stake + Symmetric Profit Goal & Loss Limits ──
    let stakeAmount = 10;
    while (true) {
      const stakeInput = await askQuestion(
        rl,
        `\nStake per trade ($) (${accountType} Balance: $${activeBalance.toFixed(2)}, suggested <= 2%): $`
      );
      const parsed = parseFloat(stakeInput.replace(/[^0-9.]/g, ''));
      if (!isNaN(parsed) && parsed >= 1) {
        if (activeBalance > 0 && parsed > activeBalance) {
          console.log(`  Stake ($${parsed.toFixed(2)}) exceeds ${accountType} balance ($${activeBalance.toFixed(2)}).`);
          continue;
        }
        stakeAmount = Math.round(parsed * 100) / 100;
        if (activeBalance > 0 && stakeAmount / activeBalance > 0.05) {
          console.log(
            `  [Risk Warning] $${stakeAmount.toFixed(2)} is ${((stakeAmount / activeBalance) * 100).toFixed(
              1
            )}% of balance (>5% risks rapid ruin).`
          );
        }
        break;
      }
      console.log(`  Please enter a valid stake of at least $1.`);
    }

    const suggestedLossLimit = Math.max(stakeAmount * 3, Math.round(stakeAmount * 4));
    const lossInput = await askQuestion(
      rl,
      `Hard MAX SESSION LOSS stop ($) [default $${suggestedLossLimit}]: $`
    );
    const maxSessionLoss = parsePositiveNumber(lossInput, suggestedLossLimit);

    const suggestedDailyLoss = Math.round(maxSessionLoss * 1.5);
    const dailyLossInput = await askQuestion(
      rl,
      `Hard MAX DAILY LOSS stop across restarts ($) [default $${suggestedDailyLoss}]: $`
    );
    const maxDailyLoss = parsePositiveNumber(dailyLossInput, suggestedDailyLoss);

    const suggestedGoal = Math.max(stakeAmount * 5, defaultProfitGoal);
    const goalInput = await askQuestion(rl, `Session PROFIT GOAL stop ($) [default $${suggestedGoal}]: $`);
    const profitGoal = parsePositiveNumber(goalInput, suggestedGoal);

    console.log(`\n=======================================================`);
    console.log(`  \x1b[41m\x1b[97m WARNING: AUTOMATED TRADING & ACCOUNT RISK \x1b[0m`);
    console.log(`=======================================================`);
    console.log(`  1. Account        : ${accountType} | Stake: $${stakeAmount.toFixed(2)} | OTC: ${allowOtc ? 'ALLOWED' : 'BLOCKED'}`);
    console.log(`  2. Hard Stops     : Stop at +$${profitGoal.toFixed(2)} profit OR -$${maxSessionLoss.toFixed(2)} session loss OR -$${maxDailyLoss.toFixed(2)} daily loss`);
    console.log(`  3. Circuit Breaker: Stop after ${defaultMaxConsec} consecutive losses OR ${defaultMaxTrades} session trades`);
    console.log(`  4. Broker Risk    : Automated trading violates Quotex ToS and may result in bans or withheld withdrawals.`);
    console.log(`=======================================================`);

    const confirm = (
      await askQuestion(rl, `Authorize Auto-Trading with these hard limits? (Type YES or Y): `)
    ).toLowerCase();

    if (confirm !== 'yes' && confirm !== 'y') {
      console.log(`\n>>> Auto-Trading not confirmed. Switching safely to MANUAL mode.\n`);
      return {
        accountType,
        mode: 'MANUAL',
        allowPreliminaryOnLive: false,
        limits: {
          accountType,
          stakeAmount,
          profitGoal,
          maxSessionLoss,
          maxDailyLoss,
          maxTradesPerSession: defaultMaxTrades,
          maxConsecutiveSessionLosses: defaultMaxConsec,
          pairConsecutiveLossCooldown: defaultPairCooldown,
          allowOtc,
        },
      };
    }

    console.log(
      `\n>>> \x1b[42m\x1b[97m [AUTO-TRADER ACTIVE (${accountType})] \x1b[0m Stake: $${stakeAmount.toFixed(
        2
      )} | Goal: +$${profitGoal.toFixed(2)} | Max Loss: -$${maxSessionLoss.toFixed(2)} / -$${maxDailyLoss.toFixed(2)} daily\n`
    );

    return {
      accountType,
      mode: 'AUTO',
      allowPreliminaryOnLive,
      limits: {
        accountType,
        stakeAmount,
        profitGoal,
        maxSessionLoss,
        maxDailyLoss,
        maxTradesPerSession: defaultMaxTrades,
        maxConsecutiveSessionLosses: defaultMaxConsec,
        pairConsecutiveLossCooldown: defaultPairCooldown,
        allowOtc,
      },
    };
  } finally {
    rl.close();
  }
}
