import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertSpawnArgs, encodePowerShellCommand } from './sound.js';

describe('sound.ts alert launcher', () => {
  it('never passes -WindowStyle Hidden (which hides the parent Windows terminal!)', () => {
    const args = buildAlertSpawnArgs('Write-Host "test"');
    const joined = args.join(' ').toLowerCase();
    assert.ok(!joined.includes('windowstyle'), 'must not use -WindowStyle Hidden');
    assert.ok(args.includes('-NoProfile'));
    assert.ok(args.includes('-NonInteractive'));
    assert.ok(args.includes('-EncodedCommand'));

    const encodedIdx = args.indexOf('-EncodedCommand') + 1;
    const decoded = Buffer.from(args[encodedIdx], 'base64').toString('utf16le');
    assert.equal(decoded, 'Write-Host "test"');
  });

  it('encodes PowerShell script cleanly as UTF-16LE base64', () => {
    const src = '$x = "hello $world"';
    const b64 = encodePowerShellCommand(src);
    assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), src);
  });
});
