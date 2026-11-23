import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fitStatusLine, StatusLine } from './statusLine.js';

describe('StatusLine', () => {
  it('truncates cleanly to window width and clears without duplicate writes', () => {
    assert.equal(fitStatusLine('short', 40).length, 39);
    const long = fitStatusLine('x'.repeat(300), 80);
    assert.equal(long.length, 79);
    assert.ok(long.trimEnd().endsWith('…'));

    const written: string[] = [];
    const status = new StatusLine({ write: (t: string) => written.push(t), columns: 60 });
    status.show('Waiting for chart data...');
    assert.ok(written[0].startsWith('\r') && written[0].includes('Waiting for chart data...'));
    status.clear();
    assert.equal(written[1], '\r' + ' '.repeat(59) + '\r');
    status.clear();
    assert.equal(written.length, 2);
  });
});
