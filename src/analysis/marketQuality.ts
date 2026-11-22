import { breakevenWinRate } from './binaryMath.js';

/**
 * Honest check of whether a price series has ANY pattern that a strategy could exploit.
 *
 * Indicators like EMA / RSI / Bollinger Bands can only help if the next candle's direction
 * is at least a little predictable from the past. If a market behaves like a random walk
 * (a coin flip each candle), no indicator can beat the broker's payout margin, no matter how
 * many "confluences" it stacks up. This tests that directly instead of assuming it.
 */
export type StructureVerdict = 'INSUFFICIENT_DATA' | 'RANDOM_WALK_LIKE' | 'SOME_STRUCTURE';

export interface StructureReport {
  verdict: StructureVerdict;
  samples: number;
  /** correlation between one candle's move and the next (0 = none) */
  lag1Autocorrelation: number;
  /** runs-test z-score: how streaky/choppy the up-down sequence is (beyond +-1.96 is unusual) */
  runsZ: number;
  /** % of the time "next candle repeats the last candle's direction" was right */
  momentumHitRate: number;
  /** % of the time "next candle reverses the last candle's direction" was right */
  reversionHitRate: number;
  /** % of candles that moved in the dominant direction (always betting that way) */
  biasHitRate: number;
  /** win rate needed to break even at the payout used */
  breakeven: number;
  /** true only if a naive rule beats break-even by more than random noise allows */
  beatsBreakeven: boolean;
  summary: string;
}

export function analyzePriceStructure(closes: number[], payoutPercent: number = 85): StructureReport {
  const breakeven = breakevenWinRate(payoutPercent);
  const minRequired = 10;
  const empty = (samples: number): StructureReport => ({
    verdict: 'INSUFFICIENT_DATA',
    samples,
    lag1Autocorrelation: 0,
    runsZ: 0,
    momentumHitRate: 50,
    reversionHitRate: 50,
    biasHitRate: 50,
    breakeven,
    beatsBreakeven: false,
    summary: `Collecting candles (${samples}/${minRequired}) to analyze market.`,
  });

  const moves: number[] = [];
  for (let i = 1; i < closes.length; i++) moves.push(closes[i] - closes[i - 1]);
  if (moves.length < minRequired) return empty(moves.length);

  // Lag-1 autocorrelation of candle moves
  const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < moves.length; i++) {
    den += (moves[i] - mean) ** 2;
    if (i > 0) num += (moves[i] - mean) * (moves[i - 1] - mean);
  }
  const rho = den === 0 ? 0 : num / den;

  // Direction sequence (ignore flat candles)
  const dirs = moves.filter((m) => m !== 0).map((m) => (m > 0 ? 1 : -1));
  const n = dirs.length;
  if (n < minRequired) return empty(n);

  // Wald-Wolfowitz runs test
  const ups = dirs.filter((d) => d === 1).length;
  const downs = n - ups;
  let runs = 1;
  for (let i = 1; i < n; i++) if (dirs[i] !== dirs[i - 1]) runs++;
  const expectedRuns = (2 * ups * downs) / n + 1;
  const varRuns = (2 * ups * downs * (2 * ups * downs - n)) / (n * n * (n - 1));
  const runsZ = varRuns > 0 ? (runs - expectedRuns) / Math.sqrt(varRuns) : 0;

  // Naive predictors
  let momentumHits = 0;
  let trials = 0;
  for (let i = 1; i < n; i++) {
    trials++;
    if (dirs[i] === dirs[i - 1]) momentumHits++;
  }
  const momentum = (momentumHits / trials) * 100;
  const reversion = 100 - momentum;

  // A naive rule must beat break-even by more than ~2 standard errors to be believable
  const stdErr = Math.sqrt(0.25 / trials) * 100;
  const bias = (Math.max(ups, downs) / n) * 100;
  const best = Math.max(momentum, reversion, bias);
  const beatsBreakeven = best - breakeven > 2 * stdErr;

  const autoLimit = 2 / Math.sqrt(moves.length);
  const driftZ = (ups / n - 0.5) / Math.sqrt(0.25 / n);
  const hasStructure = Math.abs(rho) > autoLimit || Math.abs(runsZ) > 1.96 || Math.abs(driftZ) > 1.96;
  const verdict: StructureVerdict = hasStructure ? 'SOME_STRUCTURE' : 'RANDOM_WALK_LIKE';

  const summary =
    verdict === 'RANDOM_WALK_LIKE'
      ? `Behaves like a coin flip (${momentum.toFixed(1)}% / ${reversion.toFixed(1)}% for repeat / reverse; need ${breakeven.toFixed(1)}% to break even). Indicators have nothing to work with here.`
      : beatsBreakeven
        ? `Some pattern found (repeat ${momentum.toFixed(1)}% / reverse ${reversion.toFixed(1)}%), enough to beat break-even ${breakeven.toFixed(1)}% on this sample. Verify on fresh data before trusting it.`
        : `Weak pattern found (repeat ${momentum.toFixed(1)}% / reverse ${reversion.toFixed(1)}%), but not enough to beat break-even ${breakeven.toFixed(1)}%.`;

  return {
    verdict,
    samples: n,
    lag1Autocorrelation: rho,
    runsZ,
    momentumHitRate: momentum,
    reversionHitRate: reversion,
    biasHitRate: bias,
    breakeven,
    beatsBreakeven,
    summary,
  };
}
