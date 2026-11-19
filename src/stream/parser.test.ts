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

  // Test 4: Deal update
  const dealPayload = '42["deal_open",{"id":"d12345","asset":"EURUSD","dir":"call","amount":50,"open_time":1700000000,"open_price":1.05400}]';
  const parsedDealMsg = parser.parseFrame(dealPayload);
  const deal = parser.extractDeal(parsedDealMsg!.eventName, parsedDealMsg!.data);
  if (!deal || deal.direction !== 'call' || deal.amount !== 50) {
    throw new Error(`Deal extraction failed: ${JSON.stringify(deal)}`);
  }
  console.log('✓ Deal frame parsing passed');

  // Test 5: Heartbeat frames (should be ignored cleanly)
  if (parser.parseFrame('2') !== null || parser.parseFrame('3') !== null) {
    throw new Error('Heartbeat frames should return null');
  }
  console.log('✓ Heartbeat frame filtering passed');

  console.log('\nAll Parser Unit Tests Passed Successfully!\n');
}

runParserTests();
