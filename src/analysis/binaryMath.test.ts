import assert from 'node:assert/strict';
import { breakevenWinRate, expectedValuePerDollar, wilsonInterval, edgeVerdict, tradesNeededToProve, kellyFraction } from './binaryMath.js';
import { analyzePriceStructure } from './marketQuality.js';

console.log('--- Testing binary options maths ---');

assert.ok(Math.abs(breakevenWinRate(85) - 54.054) < 0.01);
assert.ok(Math.abs(breakevenWinRate(100) - 50) < 1e-9);
assert.ok(Math.abs(expectedValuePerDollar(50, 85) - -0.075) < 1e-9, 'a coin flip loses 7.5c per $1 at 85%');
assert.ok(kellyFraction(50, 85) < 0, 'no edge -> Kelly says do not trade');
assert.ok(kellyFraction(60, 85) > 0);
console.log('✓ Break-even, expected value and Kelly are right');

const w = wilsonInterval(60, 100);
assert.ok(w.low < 60 && w.high > 60 && w.low > 49 && w.high < 70);
console.log('✓ Win-rate confidence range is sensible');

assert.equal(edgeVerdict(8, 12, 85).verdict, 'INCONCLUSIVE', 'tiny samples prove nothing');
assert.equal(edgeVerdict(60, 100, 85).verdict, 'INCONCLUSIVE', '60% over 100 trades is not proof');
assert.equal(edgeVerdict(700, 1000, 85).verdict, 'PROVEN_EDGE');
assert.equal(edgeVerdict(400, 1000, 85).verdict, 'LIKELY_LOSING');
assert.ok(tradesNeededToProve(58, 85) > 400, 'a small edge needs hundreds of trades to prove');
assert.equal(tradesNeededToProve(50, 85), Infinity);
console.log('✓ Edge verdict refuses to call luck an edge');

// Coin-flip price series must be reported as such and almost never "beat break-even"
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let falseBeats = 0;
let flaggedStructure = 0;
const RUNS = 300;
for (let seed = 1; seed <= RUNS; seed++) {
  const rand = mulberry32(seed);
  let price = 1.0;
  const walk: number[] = [price];
  for (let i = 0; i < 400; i++) walk.push((price += (rand() - 0.5) * 0.001));
  const r = analyzePriceStructure(walk, 85);
  if (r.beatsBreakeven) falseBeats++;
  if (r.verdict === 'SOME_STRUCTURE') flaggedStructure++;
}
assert.ok(falseBeats / RUNS < 0.02, `random walks wrongly beat break-even ${falseBeats}/${RUNS} times`);
assert.ok(flaggedStructure / RUNS < 0.2, `random walks wrongly flagged ${flaggedStructure}/${RUNS} times`);
console.log(`✓ Across ${RUNS} random markets: wrongly "beat break-even" ${falseBeats}x, flagged as patterned ${flaggedStructure}x`);

// A strongly trending series should show structure
const trend: number[] = [1];
for (let i = 0; i < 100; i++) trend.push(trend[i] + (i % 10 === 9 ? -0.0004 : 0.001));
assert.equal(analyzePriceStructure(trend, 85).verdict, 'SOME_STRUCTURE');
assert.equal(analyzePriceStructure([1, 1.1, 1.2], 85).verdict, 'INSUFFICIENT_DATA');
console.log('✓ Structured series and too-short series are handled');

console.log('\nAll maths tests passed.');
process.exit(0);
