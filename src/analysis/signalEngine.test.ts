import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SignalEngine,
  ALL_PLAYBOOKS,
  ALL_PROFILES,
  precomputeProfileSeries,
} from './signalEngine.js';
import { VisualChartEngine } from './visualChartEngine.js';
import { Candle } from '../stream/types.js';
import { TradeRecord } from '../journal/types.js';

function makeTrendingCandles(count: number, step: number = 0.0002): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1;
  const startMs = Date.now() - count * 300_000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const delta = i % 4 === 2 ? -step * 0.6 : step;
    const close = open + delta;
    const high = Math.max(open, close) + step * 0.3;
    const low = Math.min(open, close) - step * 0.4;
    candles.push({
      asset: 'EURUSD',
      timeframe: 300,
      openTime: startMs + i * 300_000,
      open,
      high,
      low,
      close,
      isClosed: true,
    });
    price = close;
  }
  return candles;
}

function makeRandomWalkCandles(count: number, seed: number): Candle[] {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const candles: Candle[] = [];
  let price = 1.1;
  const startMs = 1_700_000_000_000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const step = (rand() - 0.5) * 0.0016;
    const close = Math.max(0.5, open + step);
    const wickUp = rand() * 0.0005;
    const wickDown = rand() * 0.0005;
    candles.push({
      asset: 'RANDUSD',
      timeframe: 300,
      openTime: startMs + i * 300_000,
      open,
      high: Math.max(open, close) + wickUp,
      low: Math.min(open, close) - wickDown,
      close,
      isClosed: true,
    });
    price = close;
  }
  return candles;
}

describe('SignalEngine & VisualChartEngine', () => {
  const engine = new SignalEngine();
  const visualEngine = new VisualChartEngine();

  it('rejects low payouts (< 80%)', () => {
    const candles = makeTrendingCandles(100);
    const report = engine.calibratePairPlaybook('EURUSD', candles, 75, 300);
    assert.equal(report.isTradeable, false);
    assert.equal(report.shouldRemovePair, true);
    assert.equal(report.tier, 'NO_EDGE');
  });

  it('O(N) precomputeProfileSeries matches evaluatePlaybook exactly at every index', () => {
    const candles = makeRandomWalkCandles(140, 12345);
    for (const prof of ALL_PROFILES) {
      const series = precomputeProfileSeries(candles, prof);
      for (const pb of ALL_PLAYBOOKS) {
        for (let i = 30; i < candles.length; i++) {
          const fast = engine.evaluatePlaybookAt(pb, series, i);
          const direct = engine.evaluatePlaybook(pb, candles.slice(0, i + 1), prof);
          assert.equal(fast?.direction ?? null, direct?.direction ?? null, `Mismatch for ${pb}/${prof.name} at i=${i}`);
          assert.equal(fast?.alignedPillars ?? null, direct?.alignedPillars ?? null);
        }
      }
    }
  });

  it('enforces zero OOS selection leakage (selecting winner ONLY on train split)', () => {
    const base = makeRandomWalkCandles(300, 99);
    const splitIdx = Math.floor(base.length * 0.6);

    // Run calibration on base series
    const repA = engine.calibratePairPlaybook('TEST', base, 88, 300);

    // Mutate ONLY the OOS portion [splitIdx..end] drastically — the TRAIN-selected playbook/profile/horizon MUST NOT CHANGE!
    const mutated = base.map((c, idx) => {
      if (idx < splitIdx) return c;
      const flip = idx % 2 === 0 ? 0.002 : -0.002;
      return {
        ...c,
        close: c.open + flip,
        high: Math.max(c.open, c.open + flip) + 0.0004,
        low: Math.min(c.open, c.open + flip) - 0.0004,
      };
    });
    const repB = engine.calibratePairPlaybook('TEST', mutated, 88, 300);

    assert.equal(
      repA.bestStats?.playbook ?? null,
      repB.bestStats?.playbook ?? null,
      'Selected playbook must not depend on OOS data'
    );
    assert.equal(
      repA.bestStats?.profile.name ?? null,
      repB.bestStats?.profile.name ?? null,
      'Selected profile must not depend on OOS data'
    );
    assert.equal(
      repA.bestStats?.horizonCandles ?? null,
      repB.bestStats?.horizonCandles ?? null,
      'Selected horizon must not depend on OOS data'
    );
  });

  it('does not falsely certify pure random walks as PROVEN_EDGE', () => {
    let provenCount = 0;
    const trials = 12;
    for (let s = 1; s <= trials; s++) {
      const rw = makeRandomWalkCandles(600, s * 7919);
      const rep = engine.calibratePairPlaybook('RANDUSD', rw, 85, 300, { strictProvenOnly: true });
      if (rep.tier === 'PROVEN_EDGE') provenCount++;
    }
    assert.ok(provenCount <= 1, `Expected <= 1 false PROVEN_EDGE on ${trials} random walks, got ${provenCount}`);
  });

  it('never uses fake hardcoded conviction scores (82/84/90/92) and triggers journal loss cooldown', () => {
    const candles = makeTrendingCandles(120);
    const visual = visualEngine.analyzeCandles(candles);
    assert.equal(visual.canvasFound, true);
    assert.equal(visual.trendDirection, 'UPTREND');

    const nowSec = Math.floor(Date.now() / 1000);
    const losses: TradeRecord[] = [0, 1, 2].map((n) => ({
      id: `loss-${n}`,
      asset: 'EURUSD',
      isOtc: false,
      direction: 'CALL',
      timeframeSeconds: 300,
      payoutPercent: 88,
      stakeAmount: 50,
      openTime: nowSec - (3 - n) * 300,
      closeTime: nowSec - (2 - n) * 300,
      openPrice: 1.1,
      closePrice: 1.099,
      status: 'LOST',
      profitLoss: -50,
      isDemo: true,
    }));

    const intel = engine.analyzeAdaptivePairIntelligence('EURUSD', false, candles, 88, visual, losses, 1.11, 300);
    assert.equal(intel.shouldSwitchPair, true);
    assert.ok(intel.switchReason?.includes('3 consecutive live losses'));
    assert.ok(intel.marketRegime);
    assert.equal(typeof intel.indicatorsAtEntry.rsi, 'number');
    assert.ok(intel.estimatedWinProb <= 85, 'Shrunk win prob should never report fake 92% on small samples');
  });
});
