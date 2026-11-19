/**
 * How binary options (Quotex included) actually work, in code.
 *
 * You stake money and pick UP or DOWN. At expiry you either win the stake times the payout
 * (for example +85%) or lose the whole stake. Nothing else matters: there is no stop-loss and
 * no partial outcome. That makes the maths simple and unforgiving:
 *
 *   break-even win rate = 1 / (1 + payout)        (85% payout -> 54.05%)
 *   profit per $1 staked = winRate * payout - (1 - winRate)
 *
 * A strategy only has an "edge" if its TRUE win rate is above break-even, and with a limited
 * number of trades you can't know the true win rate, only estimate it. These helpers say how
 * sure we can really be.
 */

/** Win rate (in %) you need just to break even at a given payout (in %). */
export function breakevenWinRate(payoutPercent: number): number {
  return (1 / (1 + payoutPercent / 100)) * 100;
}

/** Expected profit per $1 staked, for a given win rate (%) and payout (%). */
export function expectedValuePerDollar(winRatePercent: number, payoutPercent: number): number {
  const p = winRatePercent / 100;
  return p * (payoutPercent / 100) - (1 - p);
}

/** Wilson score interval for a win rate. Returns percentages. */
export function wilsonInterval(wins: number, total: number, z: number = 1.96): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 100 };
  const p = wins / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { low: Math.max(0, (centre - margin) * 100), high: Math.min(100, (centre + margin) * 100) };
}

/** Roughly how many trades you need before a true win rate would show up as a proven edge. */
export function tradesNeededToProve(trueWinRatePercent: number, payoutPercent: number, z: number = 1.96): number {
  const be = breakevenWinRate(payoutPercent);
  if (trueWinRatePercent <= be) return Infinity;
  const p = trueWinRatePercent / 100;
  const gap = (trueWinRatePercent - be) / 100;
  return Math.ceil((z * z * p * (1 - p)) / (gap * gap));
}

/** Kelly fraction of your balance to stake. Zero or negative means: do not trade. */
export function kellyFraction(winRatePercent: number, payoutPercent: number): number {
  const b = payoutPercent / 100;
  const p = winRatePercent / 100;
  return (b * p - (1 - p)) / b;
}

export type EdgeVerdictKind = 'PROVEN_EDGE' | 'LIKELY_LOSING' | 'INCONCLUSIVE';

export interface EdgeVerdict {
  verdict: EdgeVerdictKind;
  winRate: number;
  breakeven: number;
  low: number;
  high: number;
  message: string;
}

/**
 * Judges a trade record honestly: is the win rate really above break-even, or could it
 * just be luck? "PROVEN_EDGE" needs the LOW end of the 95% range to clear break-even.
 */
export function edgeVerdict(wins: number, total: number, payoutPercent: number): EdgeVerdict {
  const breakeven = breakevenWinRate(payoutPercent);
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const { low, high } = wilsonInterval(wins, total);

  if (total < 30) {
    return {
      verdict: 'INCONCLUSIVE',
      winRate,
      breakeven,
      low,
      high,
      message: `Only ${total} trades: far too few to tell skill from luck (need hundreds). Break-even is ${breakeven.toFixed(1)}%.`,
    };
  }
  if (low > breakeven) {
    return {
      verdict: 'PROVEN_EDGE',
      winRate,
      breakeven,
      low,
      high,
      message: `Win rate ${winRate.toFixed(1)}% (95% range ${low.toFixed(1)}-${high.toFixed(1)}%) is above break-even ${breakeven.toFixed(1)}%.`,
    };
  }
  if (high < breakeven) {
    return {
      verdict: 'LIKELY_LOSING',
      winRate,
      breakeven,
      low,
      high,
      message: `Win rate ${winRate.toFixed(1)}% (95% range ${low.toFixed(1)}-${high.toFixed(1)}%) is below break-even ${breakeven.toFixed(1)}%: this approach loses money.`,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    winRate,
    breakeven,
    low,
    high,
    message: `Win rate ${winRate.toFixed(1)}% (95% range ${low.toFixed(1)}-${high.toFixed(1)}%) overlaps break-even ${breakeven.toFixed(1)}%: no proven edge yet.`,
  };
}
