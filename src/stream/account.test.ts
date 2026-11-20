import assert from 'node:assert/strict';
import { QxWsSniffer, accountModeFromUrl } from './wsSniffer.js';
import { QxWsParser } from './wsParser.js';
import { AccountModeTracker } from './accountTracker.js';

console.log('--- Testing demo / live account detection ---');

// 1. Page address
assert.equal(accountModeFromUrl('https://qxbroker.com/en/demo-trade'), 'DEMO');
assert.equal(accountModeFromUrl('https://qxbroker.com/en/trade'), 'LIVE');
assert.equal(accountModeFromUrl('https://quotex.com/pt/trade?x=1'), 'LIVE');
assert.equal(accountModeFromUrl('https://qxbroker.com/en/sign-in'), 'UNKNOWN');
assert.equal(accountModeFromUrl('about:blank'), 'UNKNOWN');
console.log('✓ Page address tells demo from live');

// 2. Balance packets: a missing flag must NOT be treated as demo
const parser = new QxWsParser();
assert.equal(parser.extractBalance('balance', { balance: 500 }), null);
assert.equal(parser.extractBalance('balance', { balance: 500, is_demo: 0 })?.isDemo, false);
assert.equal(parser.extractBalance('balance', { balance: 500, is_demo: 1 })?.isDemo, true);
assert.equal(parser.extractBalance('balance', { live_balance: 80, demo_balance: 10000, isDemo: false })?.balance, 80);
console.log('✓ Missing demo flag is no longer assumed to be demo');

// 3. Switching accounts is noticed every time, in both directions
const sniffer = new QxWsSniffer();
const seen: string[] = [];
sniffer.on('accountChanged', ({ mode }: { mode: string }) => seen.push(mode));
assert.equal(sniffer.getAccountMode(), 'UNKNOWN');

sniffer.handleIncomingFrame('42["balance",{"balance":10000,"is_demo":true}]');
assert.equal(sniffer.getAccountMode(), 'DEMO');
sniffer.handleIncomingFrame('42["balance",{"balance":85.5,"is_demo":false}]');
assert.equal(sniffer.getAccountMode(), 'LIVE');
assert.equal(sniffer.getBalance()?.isDemo, false);
sniffer.handleIncomingFrame('42["balance",{"balance":10000,"is_demo":true}]');
assert.equal(sniffer.getAccountMode(), 'DEMO');
assert.deepEqual(seen, ['DEMO', 'LIVE', 'DEMO']);
console.log('✓ Switching Demo -> Live -> Demo is detected every time');

// 4. A deal can carry its own account flag
const deal = parser.extractDeal('deal', { id: 'abc', asset: 'EURGBP_otc', dir: 'call', amount: 5, is_demo: false });
assert.equal(deal?.isDemo, false);
assert.equal(deal?.asset, 'EURGBP_OTC');
console.log('✓ Deals keep their own account flag');

// 5. Quotex's real message names: { liveBalance, demoBalance } carries BOTH accounts
const s2 = new QxWsSniffer();
s2.handleIncomingFrame('{"liveBalance":85.5,"demoBalance":10000}');
assert.equal(s2.getBalance(), null, 'balance unknown until we know which account is open');
s2.handleOutgoingFrame('42["account/change",{"demo":1,"tournamentId":0}]');
assert.equal(s2.getAccountMode(), 'DEMO');
assert.equal(s2.getBalance()?.balance, 10000);
s2.handleOutgoingFrame('42["account/change",{"demo":0,"tournamentId":0}]');
assert.equal(s2.getAccountMode(), 'LIVE');
assert.equal(s2.getBalance()?.balance, 85.5);
assert.equal(s2.getBalance()?.isDemo, false);
s2.handleIncomingFrame('{"liveBalance":90,"demoBalance":10000}');
assert.equal(s2.getBalance()?.balance, 90, 'balance follows updates');
console.log('✓ liveBalance/demoBalance read correctly; balance follows the open account');

// 6. Messages the browser sends: only the demo flag is read, never the session
assert.equal(QxWsParser.parseOutgoingAccountFrame('42["authorization",{"session":"SECRET","isDemo":1,"tournamentId":0}]'), true);
assert.equal(QxWsParser.parseOutgoingAccountFrame('42["authorization",{"session":"SECRET","isDemo":0}]'), false);
assert.equal(QxWsParser.parseOutgoingAccountFrame('42["account/change",{"demo":1}]'), true);
assert.equal(QxWsParser.parseOutgoingAccountFrame('42["instruments/follow",{"asset":"EURUSD"}]'), null);
assert.equal(QxWsParser.parseOutgoingAccountFrame('not json'), null);
console.log('✓ Outgoing account messages understood');

// 7. Most recent change wins, whichever clue it came from
const t = new AccountModeTracker();
t.update('page address', 'LIVE', 1000);
assert.equal(t.current(), 'LIVE');
t.update('Quotex request', 'DEMO', 2000); // user switches; page address did not change
assert.equal(t.current(), 'DEMO');
t.update('page address', 'DEMO', 2500); // address changes to the demo page
assert.equal(t.current(), 'DEMO');
t.update('page address', 'LIVE', 3000); // and later back to the live page
assert.equal(t.current(), 'LIVE');
const t2 = new AccountModeTracker();
t2.update('screen label', 'DEMO');
assert.equal(t2.current(), 'DEMO', 'screen label is the fallback');
t2.update('page address', 'LIVE', 5);
assert.equal(t2.current(), 'LIVE', 'but any real clue beats the screen label');
console.log('✓ Latest account change always wins');

// 8. Per-timeframe payout
const row = (sym: string, name: string, general: number, p1: number, p5: number) => {
  const r: any[] = new Array(24).fill(0);
  r[0] = 1; r[1] = sym; r[2] = name; r[5] = general; r[14] = true;
  r[r.length - 10] = 80; r[r.length - 9] = p1; r[r.length - 8] = p5;
  return r;
};
const payouts = parser.extractPayouts('instruments', [row('EURGBP_otc', 'EUR/GBP (OTC)', 90, 88, 84), row('USDJPY', 'USD/JPY', 86, 0, 0)]);
assert.equal(payouts[0].payoutPercent, 84, 'a 5-minute trade must use the 5-minute payout');
assert.equal(payouts[0].payout1mPercent, 88);
assert.equal(payouts[0].payout5mPercent, 84);
assert.equal(payouts[1].payoutPercent, 86, 'falls back to the general payout when no 5-minute figure');
console.log('✓ 5-minute payout is used (falls back to general payout)');

console.log('\nAll account tests passed.');
process.exit(0);
