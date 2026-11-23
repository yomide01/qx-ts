import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  breakevenWinRate,
  expectedValuePerDollar,
  wilsonInterval,
  normalQuantile,
  bonferroniZ,
  binomialOneSidedPValue,
  empiricalBayesWinRate,
  edgeVerdict,
  tradesNeededToProve,
  kellyFraction,
  halfKellyFraction,
} from './binaryMath.js';

describe('binaryMath', () => {
  it('computes break-even win rate, EV, and Kelly accurately', () => {
    assert.ok(Math.abs(breakevenWinRate(85) - 54.054) < 0.01);
    assert.ok(Math.abs(breakevenWinRate(100) - 50) < 1e-9);
    assert.ok(Math.abs(expectedValuePerDollar(50, 85) - -0.075) < 1e-9);
    assert.ok(kellyFraction(50, 85) < 0);
    assert.ok(kellyFraction(60, 85) > 0);
    assert.equal(halfKellyFraction(50, 85), 0);
    assert.equal(halfKellyFraction(90, 85, 0.02), 0.02);
  });

  it('computes accurate normal quantiles and Bonferroni z-scores', () => {
    assert.ok(Math.abs(normalQuantile(0.5)) < 1e-9);
    assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-4);
    assert.ok(Math.abs(normalQuantile(0.95) - 1.644854) < 1e-4);
    assert.ok(bonferroniZ(27, 0.05, false) > bonferroniZ(1, 0.05, false));
    assert.ok(bonferroniZ(27, 0.05, false) > 2.8);
  });

  it('computes exact binomial upper-tail p-values', () => {
    // 5/10 at p=0.5: P(X>=5) = (252+210+120+45+10+1)/1024 = 638/1024 = 0.623046875
    assert.ok(Math.abs(binomialOneSidedPValue(5, 10, 0.5) - 638 / 1024) < 1e-6);
    assert.ok(binomialOneSidedPValue(70, 100, 0.54) < 0.001);
    assert.ok(binomialOneSidedPValue(50, 100, 0.54) > 0.75);
  });

  it('shrinks small-sample win rates honestly via Empirical Bayes', () => {
    // 5/6 raw = 83.3%, shrunk toward 50% with priorStrength=20 -> (5+10)/(6+20) = 57.69%
    const shrunk = empiricalBayesWinRate(5, 6, 50, 20);
    assert.ok(Math.abs(shrunk - 57.692) < 0.05);
    assert.ok(shrunk < 65, 'must not report inflated raw small-sample percentages');
  });

  it('evaluates Wilson intervals and honest edge verdicts', () => {
    const w = wilsonInterval(60, 100);
    assert.ok(w.low < 60 && w.high > 60 && w.low > 49 && w.high < 70);
    assert.equal(edgeVerdict(8, 12, 85).verdict, 'INCONCLUSIVE');
    assert.equal(edgeVerdict(60, 100, 85).verdict, 'INCONCLUSIVE');
    assert.equal(edgeVerdict(700, 1000, 85).verdict, 'PROVEN_EDGE');
    assert.equal(edgeVerdict(400, 1000, 85).verdict, 'LIKELY_LOSING');
    assert.ok(tradesNeededToProve(58, 85) > 400);
    assert.equal(tradesNeededToProve(50, 85), Infinity);
  });
});
