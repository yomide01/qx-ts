import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QxWsParser } from './wsParser.js';

describe('QxWsParser', () => {
  const parser = new QxWsParser();

  it('parses Socket.IO tick frames', () => {
    const msg = parser.parseFrame('42["tick",{"asset":"EURUSD","time":1700000000,"price":1.05432}]');
    assert.equal(msg?.eventName, 'tick');
    const tick = parser.extractTick(msg!.eventName, msg!.data);
    assert.equal(tick?.asset, 'EURUSD');
    assert.equal(tick?.price, 1.05432);
  });

  it('parses payouts list and isolates deal dollar profit from payouts', () => {
    const msg = parser.parseFrame(
      '42["instruments",[{"symbol":"EURUSD","name":"EUR/USD","payout":87,"is_otc":false},{"symbol":"GBPUSD_otc","name":"GBP/USD (OTC)","payout":92,"is_otc":true}]]'
    );
    const payouts = parser.extractPayouts(msg!.eventName, msg!.data);
    assert.equal(payouts.length, 2);
    assert.equal(payouts[0].payoutPercent, 87);
    assert.equal(payouts[1].isOtc, true);

    assert.equal(
      parser.extractPayouts('deals/close', [{ id: 'd1', asset: 'EURJPY', amount: 1500, profit: 1380, open_price: 178.45 }])
        .length,
      0
    );
  });

  it('parses deals with real Quotex string openTime + numeric openTimestamp + percentProfit', () => {
    const futureCloseSec = Math.floor(Date.now() / 1000) + 60;
    const openDeal = parser.extractDeal('deals/open', {
      id: 'qx-open-1',
      asset: 'USDJPY',
      command: 0,
      amount: 10,
      openTime: '2026-11-23 18:19:50',
      closeTime: '2026-11-23 18:29:50',
      openTimestamp: Math.floor(Date.now() / 1000),
      closeTimestamp: futureCloseSec,
      openPrice: 159.185,
      closePrice: 0,
      profit: 9,
      percentProfit: 90,
      isDemo: 1,
      isClosed: false,
    });
    assert.equal(openDeal?.status, 'open');
    assert.equal(openDeal?.direction, 'call');
    assert.equal(openDeal?.payoutPercent, 90);
    assert.equal(openDeal?.closeTime, futureCloseSec);

    const closedDeal = parser.extractDeal('deals/close', {
      id: 'qx-open-1',
      asset: 'USDJPY',
      command: 1,
      amount: 10,
      openTime: '2026-11-23 18:19:50',
      closeTime: '2026-11-23 18:29:50',
      openTimestamp: 1795457990,
      closeTimestamp: 1795458590,
      openPrice: 159.185,
      closePrice: 159.18,
      profit: 9,
      percentProfit: 90,
      isClosed: true,
    });
    assert.equal(closedDeal?.status, 'won');
    assert.equal(closedDeal?.direction, 'put');
    assert.equal(closedDeal?.openTime, 1795457990);
    assert.equal(closedDeal?.closeTime, 1795458590);
  });

  it('filters heartbeat frames', () => {
    assert.equal(parser.parseFrame('2'), null);
    assert.equal(parser.parseFrame('3'), null);
  });
});
