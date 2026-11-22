import assert from 'node:assert/strict';
import { fitStatusLine, StatusLine } from './statusLine.js';

console.log('--- Testing the on-screen status line ---');

// Never wider than the window, always padded so old text is overwritten
assert.equal(fitStatusLine('short', 40).length, 39);
const long = fitStatusLine('x'.repeat(300), 80);
assert.equal(long.length, 79);
assert.ok(long.trimEnd().endsWith('…'));
console.log('✓ Status line is cut to fit the window (never wraps)');

// Showing then clearing wipes the line; clearing twice does nothing extra
const written: string[] = [];
const status = new StatusLine({ write: (t: string) => written.push(t), columns: 60 });
status.show('Waiting for chart data...');
assert.ok(written[0].startsWith('\r') && written[0].includes('Waiting for chart data...'));
status.clear();
assert.equal(written[1], '\r' + ' '.repeat(59) + '\r');
status.clear();
assert.equal(written.length, 2);
console.log('✓ Status line is wiped before other messages are printed');

console.log('\nAll status line tests passed.');
process.exit(0);
