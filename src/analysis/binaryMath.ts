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

/** Wilson score interval for a win rate. Returns percentages (0..100). */
export function wilsonInterval(wins: number, total: number, z: number = 1.96): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 100 };
  const clampedWins = Math.max(0, Math.min(total, wins));
  const p = clampedWins / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { low: Math.max(0, (centre - margin) * 100), high: Math.min(100, (centre + margin) * 100) };
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, accurate to < 1.2e-9).
 * Used to compute z-scores for arbitrary confidence levels and multiple-testing corrections.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/**
 * Bonferroni-adjusted z-score when searching across `numHypotheses` strategy variants.
 * Example: K=1, alpha=0.05 (two-sided) -> z ~= 1.96. K=27 -> z ~= 3.11.
 */
export function bonferroniZ(numHypotheses: number, alpha: number = 0.05, twoSided: boolean = true): number {
  const k = Math.max(1, Math.round(numHypotheses));
  const tail = twoSided ? alpha / (2 * k) : alpha / k;
  return normalQuantile(1 - Math.min(0.499999, Math.max(1e-12, tail)));
}

function logGamma(z: number): number {
  // Lanczos approximation for ln(Gamma(z))
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = coef[0];
  for (let i = 1; i < g + 2; i++) {
    a += coef[i] / (x + i);
  }
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logFactorial(n: number): number {
  if (n <= 1) return 0;
  return logGamma(n + 1);
}

/**
 * Exact one-sided binomial upper-tail p-value: P(X >= wins | n = total, p = nullProb).
 * Answers: "If true win rate were merely break-even (`nullProb`), how likely is getting
 * at least `wins` out of `total` purely by luck?"
 */
export function binomialOneSidedPValue(wins: number, total: number, nullProb: number): number {
  if (total <= 0) return 1;
  if (wins <= 0) return 1;
  if (wins > total) return 0;
  const p = Math.min(1 - 1e-12, Math.max(1e-12, nullProb));
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  const logNFact = logFactorial(total);

  let sum = 0;
  for (let k = wins; k <= total; k++) {
    const logProb = logNFact - logFactorial(k) - logFactorial(total - k) + k * logP + (total - k) * logQ;
    sum += Math.exp(logProb);
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * Empirical Bayes (Beta-Binomial) shrunk win-rate estimate (in %).
 * Pulls noisy small samples aggressively toward a 50% coin-flip prior so e.g.
 * 5/6 (83.3% raw) becomes 57.7%, not an inflated "92% conviction".
 */
export function empiricalBayesWinRate(
  wins: number,
  total: number,
  priorMeanPercent: number = 50,
  priorStrength: number = 20
): number {
  const priorP = Math.min(0.99, Math.max(0.01, priorMeanPercent / 100));
  const alpha0 = priorP * priorStrength;
  const beta0 = (1 - priorP) * priorStrength;
  const cleanWins = Math.max(0, Math.min(total, wins));
  const cleanTotal = Math.max(0, total);
  return ((cleanWins + alpha0) / (cleanTotal + alpha0 + beta0)) * 100;
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

/** Conservative half-Kelly stake fraction capped at `maxCap` (default 2% of bankroll). */
export function halfKellyFraction(winRatePercent: number, payoutPercent: number, maxCap: number = 0.02): number {
  const raw = kellyFraction(winRatePercent, payoutPercent);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(maxCap, raw * 0.5);
}

export type EdgeVerdictKind = 'PROVEN_EDGE' | 'LIKELY_LOSING' | 'INCONCLUSIVE';

export interface EdgeVerdict {
  verdict: EdgeVerdictKind;
  winRate: number;
  breakeven: number;
  low: number;
  high: number;
  pValue: number;
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
  const pValue = binomialOneSidedPValue(wins, total, breakeven / 100);

  if (total < 30) {
    return {
      verdict: 'INCONCLUSIVE',
      winRate,
      breakeven,
      low,
      high,
      pValue,
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
      pValue,
      message: `Win rate ${winRate.toFixed(1)}% (95% range ${low.toFixed(1)}-${high.toFixed(1)}%, p=${pValue.toFixed(4)}) is above break-even ${breakeven.toFixed(1)}%.`,
    };
  }
  if (high < breakeven) {
    return {
      verdict: 'LIKELY_LOSING',
      winRate,
      breakeven,
      low,
      high,
      pValue,
      message: `Win rate ${winRate.toFixed(1)}% (95% range ${low.toFixed(1)}-${high.toFixed(1)}%) is below break-even ${breakeven.toFixed(1)}%: this approach loses money.`,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    winRate,
    breakeven,
    low,
    high,
    pValue,
    message: `Win rate ${winRate.toFixed(1)}% (95% range ${low.toFixed(1)}-${high.toFixed(1)}%, p=${pValue.toFixed(3)}) overlaps break-even ${breakeven.toFixed(1)}%: no proven edge yet.`,
  };
}
