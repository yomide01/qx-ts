import { launchBrowserSession } from '../browser/launcher.js';
import { QxWsSniffer } from './wsSniffer.js';
import { CandleAggregator } from './candleAggregator.js';
import { Tick, AssetPayout, AccountBalance, TradeDeal, Candle } from './types.js';

async function main() {
  console.log('======================================================');
  console.log('       Quotex Live Stream & Sniffer Test (Phase 2)    ');
  console.log('======================================================');

  // Instantiate passive sniffer BEFORE navigation so we catch the initial WS handshake
  const sniffer = new QxWsSniffer();
  const aggregator = new CandleAggregator(sniffer);

  // Launch persistent session — sniffer is attached as a callback BEFORE page.goto()
  const { context, page } = await launchBrowserSession(async (p) => {
    await sniffer.attachToPage(p);
  });

  // Throttle tick logging so terminal remains readable
  let tickCount = 0;
  const lastLoggedTick = new Map<string, number>();

  sniffer.on('tick', (tick: Tick) => {
    tickCount++;
    const now = Date.now();
    const last = lastLoggedTick.get(tick.asset) || 0;

    // Log at most once per 2 seconds per asset
    if (now - last > 2000) {
      lastLoggedTick.set(tick.asset, now);
      console.log(`[TICK] ${tick.asset} | Price: ${tick.price.toFixed(5)} | Total Ticks: ${tickCount}`);
    }
  });

  sniffer.on('payouts', (payouts: AssetPayout[]) => {
    console.log(`\n--- [PAYOUTS UPDATED: ${payouts.length} Assets] ---`);
    const topAssets = payouts
      .filter((p) => p.payoutPercent >= 80)
      .slice(0, 5)
      .map((p) => `${p.asset}: ${p.payoutPercent.toFixed(0)}% (${p.isOtc ? 'OTC' : 'Live'})`);

    if (topAssets.length > 0) {
      console.log(`Top Payouts (>=80%): ${topAssets.join(' | ')}`);
    }
  });

  sniffer.on('balance', (balance: AccountBalance) => {
    console.log(`\n>>> [ACCOUNT BALANCE] ${balance.isDemo ? 'DEMO' : 'LIVE'}: $${balance.balance.toLocaleString()} ${balance.currency}`);
  });

  sniffer.on('deal', (deal: TradeDeal) => {
    console.log(`\n>>> [TRADE DEAL] ${deal.direction.toUpperCase()} on ${deal.asset} | Stake: $${deal.amount} | Status: ${deal.status}`);
  });

  aggregator.on('candleClosed', (candle: Candle) => {
    const tfName = candle.timeframe === 60 ? 'M1' : candle.timeframe === 300 ? 'M5' : `${candle.timeframe}s`;
    console.log(
      `[CANDLE CLOSED] ${candle.asset} (${tfName}) | O: ${candle.open} H: ${candle.high} L: ${candle.low} C: ${candle.close}`
    );
  });

  console.log('\n[Stream] Passive sniffer listening. Make sure Quotex trading room is open.');
  console.log('[Stream] Press Ctrl+C in this terminal to stop.\n');

  process.on('SIGINT', async () => {
    console.log('\n[Stream] Closing session cleanly...');
    await context.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Stream Error]', err);
  process.exit(1);
});
