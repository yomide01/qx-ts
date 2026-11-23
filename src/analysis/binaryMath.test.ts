import assert from 'node:assert/strict';
import { breakevenWinRate, expectedValuePerDollar, wilsonInterval, edgeVerdict, tradesNeededToProve, kellyFraction } from './binaryMath.js';

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

console.log('\nAll maths tests passed.');
process.exit(0);
