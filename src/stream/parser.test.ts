import { QxWsParser } from './wsParser.js';

function runParserTests() {
  console.log('--- Testing QxWsParser ---');
  const parser = new QxWsParser();

  // Test 1: Socket.IO Tick message
  const tickPayload = '42["tick",{"asset":"EURUSD","time":1700000000,"price":1.05432}]';
  const parsedTickMsg = parser.parseFrame(tickPayload);
  if (!parsedTickMsg || parsedTickMsg.eventName !== 'tick') {
    throw new Error('Failed to parse Socket.IO tick frame');
  }
  const tick = parser.extractTick(parsedTickMsg.eventName, parsedTickMsg.data);
  if (!tick || tick.asset !== 'EURUSD' || tick.price !== 1.05432) {
    throw new Error(`Tick extraction failed: ${JSON.stringify(tick)}`);
  }
  console.log('✓ Tick frame parsing passed');

  // Test 2: Payouts list
  const payoutsPayload = '42["instruments",[{"symbol":"EURUSD","name":"EUR/USD","payout":87,"is_otc":false},{"symbol":"GBPUSD_otc","name":"GBP/USD (OTC)","payout":92,"is_otc":true}]]';
  const parsedPayoutsMsg = parser.parseFrame(payoutsPayload);
  if (!parsedPayoutsMsg) {
    throw new Error('Failed to parse payouts frame');
  }
  const payouts = parser.extractPayouts(parsedPayoutsMsg.eventName, parsedPayoutsMsg.data);
  if (payouts.length !== 2 || payouts[0].payoutPercent !== 87 || !payouts[1].isOtc) {
    throw new Error(`Payout extraction failed: ${JSON.stringify(payouts)}`);
  }
  console.log('✓ Payouts list parsing passed');

  // Test 3: Balance update
  const balancePayload = '42["balance",{"balance":10450.5,"currency":"USD","is_demo":true}]';
  const parsedBalanceMsg = parser.parseFrame(balancePayload);
  const balance = parser.extractBalance(parsedBalanceMsg!.eventName, parsedBalanceMsg!.data);
  if (!balance || balance.balance !== 10450.5 || !balance.isDemo) {
    throw new Error(`Balance extraction failed: ${JSON.stringify(balance)}`);
  }
  console.log('✓ Balance frame parsing passed');

  // Test 4: Deal update (including protection against premature settlement on newly opened trades)
  const dealPayload = '42["deal_open",{"id":"d12345","asset":"EURUSD","dir":"call","amount":50,"open_time":1700000000,"open_price":1.05400}]';
  const parsedDealMsg = parser.parseFrame(dealPayload);
  const deal = parser.extractDeal(parsedDealMsg!.eventName, parsedDealMsg!.data);
  if (!deal || deal.direction !== 'call' || deal.amount !== 50 || deal.status !== 'open') {
    throw new Error(`Deal extraction failed: ${JSON.stringify(deal)}`);
  }

  // Quotex real open deal payload carries future closeTimestamp and potential profit
  const futureCloseSec = Math.floor(Date.now() / 1000) + 60;
  const openDealWithFutureExpiry = parser.extractDeal('deals/open', {
    id: 'qx-open-1',
    asset: 'EURNZD_otc',
    command: 0, // 0 = CALL (Buy)
    amount: 100,
    openTimestamp: Math.floor(Date.now() / 1000),
    closeTimestamp: futureCloseSec,
    openPrice: 2.025,
    closePrice: 0,
    profit: 88,
    isClosed: false,
  });
  if (!openDealWithFutureExpiry || openDealWithFutureExpiry.status !== 'open' || openDealWithFutureExpiry.direction !== 'call') {
    throw new Error(`Open deal with future closeTimestamp was falsely settled: ${JSON.stringify(openDealWithFutureExpiry)}`);
  }

  const settledDeal = parser.extractDeal('deals/close', {
    id: 'qx-open-1',
    asset: 'EURNZD_otc',
    command: 0,
    amount: 100,
    openTimestamp: Math.floor(Date.now() / 1000) - 60,
    closeTimestamp: Math.floor(Date.now() / 1000),
    openPrice: 2.025,
    closePrice: 2.0258,
    profit: 88,
    isClosed: true,
  });
  if (!settledDeal || settledDeal.status !== 'won') {
    throw new Error(`Settled deal was not marked won: ${JSON.stringify(settledDeal)}`);
  }
  console.log('✓ Deal frame parsing & anti-premature-settlement passed');

  // Test 5: Heartbeat frames (should be ignored cleanly)
  if (parser.parseFrame('2') !== null || parser.parseFrame('3') !== null) {
    throw new Error('Heartbeat frames should return null');
  }
  console.log('✓ Heartbeat frame filtering passed');

  // Test 6: Regression — deal objects with dollar profit (e.g. 1380 on $1500 stake) must NEVER be parsed as 1380% payout
  const fakePayoutsFromDeals = parser.extractPayouts('deals/close', [
    { id: 'deal-1', asset: 'EURJPY', amount: 1500, profit: 1380, open_price: 178.45, close_time: 1790674380 },
  ]);
  const fakePayoutsFromArray = parser.extractPayouts('array_data', [
    { id: 'deal-1', asset: 'EURJPY', amount: 1500, profit: 1380, open_price: 178.45 },
  ]);
  if (fakePayoutsFromDeals.length !== 0 || fakePayoutsFromArray.length !== 0) {
    throw new Error('extractPayouts falsely extracted dollar profit from a deal object as a payout percentage');
  }
  console.log('✓ Deal profit vs payout percentage isolation passed');

  console.log('\nAll Parser Unit Tests Passed Successfully!\n');
}

runParserTests();
