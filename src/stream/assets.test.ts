import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAsset, AssetRegistry } from './assets.js';
import { QxWsSniffer } from './wsSniffer.js';
import { CandleAggregator } from './candleAggregator.js';
import { TradingJournalDB } from '../journal/database.js';

describe('Asset normalization & CandleAggregator merge/persistence', () => {
  it('normalizes every Quotex asset format into one canonical key', () => {
    const cases: Record<string, string> = {
      EURGBP: 'EURGBP',
      eurgbp: 'EURGBP',
      'EUR/GBP': 'EURGBP',
      EURGBP_otc: 'EURGBP_OTC',
      'EUR/GBP (OTC)': 'EURGBP_OTC',
      'EUR/GBP OTC': 'EURGBP_OTC',
      'Notcoin (OTC)': 'NOTCOIN_OTC',
      ATOUSD_otc: 'ATOUSD_OTC',
      '': '',
    };
    for (const [input, expected] of Object.entries(cases)) {
      assert.equal(normalizeAsset(input), expected);
    }

    const reg = new AssetRegistry();
    reg.learn('XAUUSD_otc', 'Gold (OTC)');
    assert.equal(reg.resolve('Gold (OTC)'), 'XAUUSD_OTC');
  });

  it('merges seeded chartHistoryPoints without wiping earlier accumulated candles', () => {
    const db = new TradingJournalDB(':memory:');
    try {
      const sniffer = new QxWsSniffer();
      const aggregator = new CandleAggregator(sniffer, db);

      // Seed batch 1: bars 0..9 (10 bars -> 9 closed + 1 active)
      const baseSec = 1_800_000_000 - (1_800_000_000 % 300);
      const batch1 = [];
      for (let i = 0; i < 10; i++) {
        batch1.push({ time: baseSec + i * 300, value: 1.1 + i * 0.0001 });
        batch1.push({ time: baseSec + i * 300 + 299, value: 1.10005 + i * 0.0001 });
      }
      aggregator.seedFromChartHistory('EURUSD_otc', 300, batch1);
      assert.equal(aggregator.getHistory('EURUSD_OTC', 300).length, 9);

      // Seed batch 2: bars 5..14 (overlaps 5..9, adds 10..13 closed + 14 active)
      const batch2 = [];
      for (let i = 5; i < 15; i++) {
        batch2.push({ time: baseSec + i * 300, value: 1.1 + i * 0.0001 });
        batch2.push({ time: baseSec + i * 300 + 299, value: 1.10005 + i * 0.0001 });
      }
      aggregator.seedFromChartHistory('EURUSD_otc', 300, batch2);

      // Must keep bars 0..13 (14 closed candles!), NOT wipe bars 0..4!
      assert.equal(aggregator.getHistory('EURUSD_OTC', 300).length, 14);
      assert.equal(db.getCandles('EURUSD_OTC', 300).length, 14);
    } finally {
      db.close();
    }
  });
});
