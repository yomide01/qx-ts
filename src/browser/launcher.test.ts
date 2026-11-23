import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCloseChromeOnExit, buildChromeLaunchArgs, checkSessionStatus } from './launcher.js';

describe('launcher helpers', () => {
  it('parses CLOSE_CHROME_ON_EXIT option with true default', () => {
    assert.equal(parseCloseChromeOnExit(undefined), true);
    assert.equal(parseCloseChromeOnExit(''), true);
    assert.equal(parseCloseChromeOnExit('true'), true);
    assert.equal(parseCloseChromeOnExit('TRUE'), true);
    assert.equal(parseCloseChromeOnExit('1'), true);
    assert.equal(parseCloseChromeOnExit('false'), false);
    assert.equal(parseCloseChromeOnExit('FALSE'), false);
    assert.equal(parseCloseChromeOnExit('0'), false);
    assert.equal(parseCloseChromeOnExit('no'), false);
  });

  it('builds isolated dedicated-profile Chrome launch arguments', () => {
    const args = buildChromeLaunchArgs(9222, 'C:\\bot\\qx_user_profile', 'https://quotex.com/en/demo-trade');
    assert.ok(args.includes('--remote-debugging-port=9222'));
    assert.ok(args.includes('--user-data-dir=C:\\bot\\qx_user_profile'));
    assert.ok(args.includes('--start-maximized'));
    assert.equal(args[args.length - 1], 'https://quotex.com/en/demo-trade');
  });

  it('detects authenticated session URLs accurately', () => {
    assert.equal(checkSessionStatus('https://quotex.com/en/demo-trade').isAuthenticated, true);
    assert.equal(checkSessionStatus('https://quotex.com/en/trade').isAuthenticated, true);
    assert.equal(checkSessionStatus('https://quotex.com/en/sign-in').isAuthenticated, false);
  });
});
