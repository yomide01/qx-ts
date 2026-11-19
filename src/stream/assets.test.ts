import assert from 'node:assert/strict';
import { normalizeAsset, AssetRegistry } from './assets.js';
import { QxWsSniffer } from './wsSniffer.js';
import { CandleAggregator } from './candleAggregator.js';

console.log('--- Testing asset names & market switching ---');

// 1. Every way Quotex writes a market name maps to ONE key
const cases: Record<string, string> = {
  EURGBP: 'EURGBP',
  eurgbp: 'EURGBP',
  'EUR/GBP': 'EURGBP',
  EURGBP_otc: 'EURGBP_OTC',
  'EUR/GBP (OTC)': 'EURGBP_OTC',
  'EUR/GBP OTC': 'EURGBP_OTC',
  'Notcoin (OTC)': 'NOTCOIN_OTC',
  NOTCOIN: 'NOTCOIN',
  ATOUSD_otc: 'ATOUSD_OTC',
  '': '',
};
for (const [input, expected] of Object.entries(cases)) {
  assert.equal(normalizeAsset(input), expected, `normalizeAsset(${JSON.stringify(input)})`);
}
console.log('✓ All name formats normalise to one key');

// 2. Registry resolves on-screen names to stream symbols
const reg = new AssetRegistry();
reg.learn('XAUUSD_otc', 'Gold (OTC)');
assert.equal(reg.resolve('Gold (OTC)'), 'XAUUSD_OTC');
assert.equal(reg.resolve('XAUUSD_otc'), 'XAUUSD_OTC');
console.log('✓ Registry maps on-screen names to stream symbols');

// 3. Switching markets: the bot must follow and keep separate candles for each
const sniffer = new QxWsSniffer();
const aggregator = new CandleAggregator(sniffer);
const switches: string[] = [];
sniffer.on('activeAssetChanged', ({ asset }: { asset: string }) => switches.push(asset));

const frame = (asset: string, t: number, price: number) =>
  `42["quotes/stream",[["${asset}",${t},${price},1]]]`;

const base = 1_800_000_000; // seconds, aligned to a 5-minute boundary
const aligned = base - (base % 300);
for (let i = 0; i < 3; i++) sniffer.handleIncomingFrame(frame('EURGBP', aligned + i * 300 + 10, 0.8377 + i * 0.0001));
assert.equal(sniffer.getActiveAsset(), 'EURGBP');

// User switches to an OTC market on the chart
for (let i = 0; i < 3; i++) sniffer.handleIncomingFrame(frame('GBPUSD_otc', aligned + i * 300 + 10, 1.25 + i * 0.001));
assert.equal(sniffer.getActiveAsset(), 'GBPUSD_OTC', 'bot must follow the switch to an OTC market');
assert.deepEqual(switches, ['EURGBP', 'GBPUSD_OTC']);

// Candles are stored under the OTC market, and found whichever way it is spelled
assert.equal(aggregator.getHistory('GBPUSD_otc', 300).length, 2);
assert.equal(aggregator.getHistory('GBPUSD (OTC)', 300).length, 2);
assert.equal(aggregator.getHistory('GBPUSD_OTC', 300).length, 2);
assert.equal(aggregator.getHistory('EURGBP', 300).length, 2);
assert.equal(sniffer.getLatestTick('gbpusd_otc')?.price, 1.252);
console.log('✓ Bot follows a switch from EURGBP to an OTC market and keeps separate candles');

// 4. Several markets streaming at once are all visible
assert.deepEqual(sniffer.getStreamingAssets().sort(), ['EURGBP', 'GBPUSD_OTC']);
console.log('✓ Streaming markets are tracked');

console.log('\nAll asset tests passed.');
process.exit(0);
