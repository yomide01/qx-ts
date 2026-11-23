import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QxWsSniffer, accountModeFromUrl } from './wsSniffer.js';
import { QxWsParser } from './wsParser.js';
import { AccountModeTracker } from './accountTracker.js';

describe('Account mode detection & payout override', () => {
  it('detects DEMO vs LIVE from URL', () => {
    assert.equal(accountModeFromUrl('https://qxbroker.com/en/demo-trade'), 'DEMO');
    assert.equal(accountModeFromUrl('https://qxbroker.com/en/trade'), 'LIVE');
    assert.equal(accountModeFromUrl('https://quotex.com/pt/trade?x=1'), 'LIVE');
    assert.equal(accountModeFromUrl('https://qxbroker.com/en/sign-in'), 'UNKNOWN');
    assert.equal(accountModeFromUrl('about:blank'), 'UNKNOWN');
  });

  it('does not assume missing demo flags are demo and tracks live/demo switches', () => {
    const parser = new QxWsParser();
    assert.equal(parser.extractBalance('balance', { balance: 500 }), null);
    assert.equal(parser.extractBalance('balance', { balance: 500, is_demo: 0 })?.isDemo, false);
    assert.equal(parser.extractBalance('balance', { balance: 500, is_demo: 1 })?.isDemo, true);

    const sniffer = new QxWsSniffer();
    const seen: string[] = [];
    sniffer.on('accountChanged', ({ mode }: { mode: string }) => seen.push(mode));
    sniffer.handleIncomingFrame('42["balance",{"balance":10000,"is_demo":true}]');
    sniffer.handleIncomingFrame('42["balance",{"balance":85.5,"is_demo":false}]');
    sniffer.handleIncomingFrame('42["balance",{"balance":10000,"is_demo":true}]');
    assert.deepEqual(seen, ['DEMO', 'LIVE', 'DEMO']);
  });

  it('handles dual liveBalance/demoBalance frames and outgoing account switches', () => {
    const s2 = new QxWsSniffer();
    s2.handleIncomingFrame('{"liveBalance":85.5,"demoBalance":10000}');
    assert.equal(s2.getBalance(), null);
    s2.handleOutgoingFrame('42["account/change",{"demo":1,"tournamentId":0}]');
    assert.equal(s2.getAccountMode(), 'DEMO');
    assert.equal(s2.getBalance()?.balance, 10000);
    s2.handleOutgoingFrame('42["account/change",{"demo":0,"tournamentId":0}]');
    assert.equal(s2.getAccountMode(), 'LIVE');
    assert.equal(s2.getBalance()?.balance, 85.5);

    assert.equal(
      QxWsParser.parseOutgoingAccountFrame('42["authorization",{"session":"SECRET","isDemo":1,"tournamentId":0}]'),
      true
    );
    assert.equal(QxWsParser.parseOutgoingAccountFrame('42["account/change",{"demo":0}]'), false);
  });

  it('respects latest AccountModeTracker clue and on-screen payout overrides', () => {
    const t = new AccountModeTracker();
    t.update('page address', 'LIVE', 1000);
    t.update('Quotex request', 'DEMO', 2000);
    assert.equal(t.current(), 'DEMO');
    t.update('page address', 'LIVE', 3000);
    assert.equal(t.current(), 'LIVE');

    const row = (sym: string, name: string, general: number, p1: number, p5: number) => {
      const r: any[] = new Array(24).fill(0);
      r[0] = 1;
      r[1] = sym;
      r[2] = name;
      r[5] = general;
      r[14] = true;
      r[r.length - 10] = 80;
      r[r.length - 9] = p1;
      r[r.length - 8] = p5;
      return r;
    };

    const s3 = new QxWsSniffer();
    s3.setOnScreenPayout('EURUSD_OTC', 89);
    s3.handleIncomingFrame(`42["instruments",${JSON.stringify([row('EURUSD_otc', 'EUR/USD (OTC)', 91, 91, 91)])}]`);
    assert.equal(s3.getPayout('EURUSD_OTC')?.payoutPercent, 89);
  });
});
