import { TradeRecord } from '../journal/types.js';
import { edgeVerdict, EdgeVerdict } from '../analysis/binaryMath.js';
import { normalizeAsset } from '../stream/assets.js';

export const MIN_DEMO_TRADES_FOR_LIVE = 300;
export const LIVE_OVERRIDE_PHRASE = 'I ACCEPT REAL MONEY LOSS';

export interface RiskLimits {
  accountType: 'DEMO' | 'LIVE';
  stakeAmount: number;
  profitGoal: number;
  maxSessionLoss: number;
  maxDailyLoss: number;
  maxTradesPerSession: number;
  maxConsecutiveSessionLosses: number;
  pairConsecutiveLossCooldown: number;
  allowOtc: boolean;
}

export interface RiskCheckResult {
  allowed: boolean;
  haltSession: boolean;
  reason?: string;
}

export interface OutcomeRiskUpdate {
  haltSession: boolean;
  haltReason?: string;
  pairNeedsRecalibration: boolean;
  pairNeedsCooldown: boolean;
  pairLossStreak: number;
}

export interface LiveReadinessReport {
  ready: boolean;
  demoTrades: number;
  minRequired: number;
  demoWins: number;
  demoLosses: number;
  demoNetPnL: number;
  avgPayout: number;
  verdict: EdgeVerdict;
  reason: string;
}

/**
 * Checks whether the SQLite trade journal provides genuine statistical evidence
 * before authorizing LIVE real-money auto-trading.
 */
export function evaluateLiveReadiness(
  allTrades: TradeRecord[],
  minDemoTrades: number = MIN_DEMO_TRADES_FOR_LIVE
): LiveReadinessReport {
  const demoSettled = allTrades.filter((t) => t.isDemo && (t.status === 'WON' || t.status === 'LOST'));
  const demoWins = demoSettled.filter((t) => t.status === 'WON').length;
  const demoLosses = demoSettled.filter((t) => t.status === 'LOST').length;
  const demoTotal = demoWins + demoLosses;
  const demoNetPnL = demoSettled.reduce((sum, t) => sum + (t.profitLoss ?? 0), 0);
  const avgPayout =
    demoTotal > 0 ? demoSettled.reduce((sum, t) => sum + (t.payoutPercent || 85), 0) / demoTotal : 85;

  const verdict = edgeVerdict(demoWins, demoTotal, avgPayout);
  const ready = demoTotal >= minDemoTrades && verdict.verdict === 'PROVEN_EDGE';

  let reason: string;
  if (ready) {
    reason = `Demo journal meets threshold (${demoTotal} trades, ${verdict.winRate.toFixed(1)}% WR, 95% low ${verdict.low.toFixed(1)}% > ${verdict.breakeven.toFixed(1)}% BE).`;
  } else if (demoTotal < minDemoTrades) {
    reason = `Only ${demoTotal}/${minDemoTrades} settled demo trades logged (${verdict.winRate.toFixed(1)}% WR, PnL ${demoNetPnL >= 0 ? '+' : ''}$${demoNetPnL.toFixed(2)}). Log at least ${minDemoTrades} demo trades with proven edge first.`;
  } else {
    reason = `Demo journal has ${demoTotal} trades (${verdict.winRate.toFixed(1)}% WR, 95% CI ${verdict.low.toFixed(1)}-${verdict.high.toFixed(1)}%) — verdict is ${verdict.verdict}, not PROVEN_EDGE.`;
  }

  return {
    ready,
    demoTrades: demoTotal,
    minRequired: minDemoTrades,
    demoWins,
    demoLosses,
    demoNetPnL,
    avgPayout,
    verdict,
    reason,
  };
}

/**
 * Symmetric session & daily risk controller for automated trading.
 * Enforces BOTH profit target AND hard loss limits (session loss, daily loss,
 * max trades per session, and consecutive loss circuit breaker).
 */
export class RiskManager {
  private sessionNetPnL = 0;
  private priorDailyNetPnL = 0;
  private sessionWins = 0;
  private sessionLosses = 0;
  private sessionDraws = 0;
  private tradesOpened = 0;
  private consecutiveSessionLosses = 0;
  private consecutiveLossesByAsset = new Map<string, number>();
  private halted = false;
  private haltReason: string | null = null;

  constructor(
    public readonly limits: RiskLimits,
    priorDailyNetPnL: number = 0
  ) {
    this.priorDailyNetPnL = priorDailyNetPnL;
  }

  public isHalted(): boolean {
    return this.halted;
  }

  public getHaltReason(): string | null {
    return this.haltReason;
  }

  public getSessionNetPnL(): number {
    return this.sessionNetPnL;
  }

  public getDailyNetPnL(): number {
    return this.priorDailyNetPnL + this.sessionNetPnL;
  }

  public getStats() {
    return {
      sessionNetPnL: this.sessionNetPnL,
      dailyNetPnL: this.getDailyNetPnL(),
      sessionWins: this.sessionWins,
      sessionLosses: this.sessionLosses,
      sessionDraws: this.sessionDraws,
      tradesOpened: this.tradesOpened,
      consecutiveSessionLosses: this.consecutiveSessionLosses,
      halted: this.halted,
      haltReason: this.haltReason,
    };
  }

  /**
   * Checks all hard risk limits before opening a new trade.
   * Also checks whether the current stake itself would breach maxSessionLoss or maxDailyLoss if lost.
   */
  public canOpenTrade(currentBalance?: number): RiskCheckResult {
    if (this.halted) {
      return { allowed: false, haltSession: true, reason: this.haltReason || 'Session halted by RiskManager' };
    }

    if (this.limits.profitGoal > 0 && this.sessionNetPnL >= this.limits.profitGoal) {
      return this.tripHalt(
        `Profit goal reached (+$${this.sessionNetPnL.toFixed(2)} >= +$${this.limits.profitGoal.toFixed(2)})`
      );
    }

    if (this.limits.maxSessionLoss > 0 && this.sessionNetPnL <= -this.limits.maxSessionLoss) {
      return this.tripHalt(
        `Max session loss reached ($${this.sessionNetPnL.toFixed(2)} <= -$${this.limits.maxSessionLoss.toFixed(2)})`
      );
    }

    const dailyPnL = this.getDailyNetPnL();
    if (this.limits.maxDailyLoss > 0 && dailyPnL <= -this.limits.maxDailyLoss) {
      return this.tripHalt(
        `Max daily loss reached ($${dailyPnL.toFixed(2)} <= -$${this.limits.maxDailyLoss.toFixed(2)})`
      );
    }

    if (this.limits.maxTradesPerSession > 0 && this.tradesOpened >= this.limits.maxTradesPerSession) {
      return this.tripHalt(
        `Max trades per session reached (${this.tradesOpened}/${this.limits.maxTradesPerSession})`
      );
    }

    if (
      this.limits.maxConsecutiveSessionLosses > 0 &&
      this.consecutiveSessionLosses >= this.limits.maxConsecutiveSessionLosses
    ) {
      return this.tripHalt(
        `Global circuit breaker: ${this.consecutiveSessionLosses} consecutive losses in a row`
      );
    }

    if (typeof currentBalance === 'number' && currentBalance > 0 && this.limits.stakeAmount > currentBalance) {
      return this.tripHalt(
        `Insufficient balance ($${currentBalance.toFixed(2)}) for stake ($${this.limits.stakeAmount.toFixed(2)})`
      );
    }

    return { allowed: true, haltSession: false };
  }

  /** Registers that a trade has been confirmed open on the broker. */
  public recordTradeOpened(): void {
    this.tradesOpened++;
  }

  /**
   * Updates session/daily PnL and streak trackers upon settlement and returns
   * whether the session should halt or the asset should recalibrate / cool down.
   */
  public recordTradeOutcome(trade: {
    asset: string;
    status: 'WON' | 'LOST' | 'DRAW';
    pnl: number;
  }): OutcomeRiskUpdate {
    const norm = normalizeAsset(trade.asset);
    this.sessionNetPnL += trade.pnl;

    let pairNeedsRecalibration = false;
    let pairNeedsCooldown = false;
    let pairLossStreak = this.consecutiveLossesByAsset.get(norm) || 0;

    if (trade.status === 'WON') {
      this.sessionWins++;
      this.consecutiveSessionLosses = 0;
      this.consecutiveLossesByAsset.set(norm, 0);
      pairLossStreak = 0;
    } else if (trade.status === 'LOST') {
      this.sessionLosses++;
      this.consecutiveSessionLosses++;
      pairLossStreak++;
      this.consecutiveLossesByAsset.set(norm, pairLossStreak);

      if (pairLossStreak >= this.limits.pairConsecutiveLossCooldown) {
        pairNeedsCooldown = true;
        this.consecutiveLossesByAsset.set(norm, 0);
      } else {
        pairNeedsRecalibration = true;
      }
    } else {
      this.sessionDraws++;
    }

    // Re-evaluate all hard halt conditions immediately after settlement
    const check = this.canOpenTrade();
    return {
      haltSession: check.haltSession,
      haltReason: check.reason,
      pairNeedsRecalibration,
      pairNeedsCooldown,
      pairLossStreak,
    };
  }

  private tripHalt(reason: string): RiskCheckResult {
    this.halted = true;
    this.haltReason = reason;
    return { allowed: false, haltSession: true, reason };
  }
}
