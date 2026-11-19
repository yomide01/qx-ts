import assert from 'node:assert/strict';
import { QxWsSniffer, accountModeFromUrl } from './wsSniffer.js';
import { QxWsParser } from './wsParser.js';

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

console.log('\nAll account tests passed.');
process.exit(0);
