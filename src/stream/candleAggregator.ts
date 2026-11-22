import { EventEmitter } from 'events';
import { Tick, Candle } from './types.js';
import { QxWsSniffer } from './wsSniffer.js';
import { normalizeAsset } from './assets.js';

export interface CandleEvents {
  candleUpdate: (candle: Candle) => void;
  candleClosed: (candle: Candle) => void;
}

export class CandleAggregator extends EventEmitter {
  // Key format: `${asset}_${timeframeSeconds}`
  private activeCandles: Map<string, Candle> = new Map();
  private candleHistory: Map<string, Candle[]> = new Map();
  private supportedTimeframes: number[] = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  private maxHistorySize: number = 100;
  private lastSeededLog: Map<string, number> = new Map();

  constructor(private sniffer: QxWsSniffer) {
    super();
    this.sniffer.on('tick', (tick: Tick) => this.onTick(tick));
    this.sniffer.on('history', (h: { asset: string; period: number; ticks: Tick[] }) => {
      this.seedHistory(h.asset, h.ticks);
    });
  }

  private onTick(tick: Tick): void {
    const tickTimeMs = tick.time > 1e11 ? tick.time : tick.time * 1000;

    for (const tf of this.supportedTimeframes) {
      const tfMs = tf * 1000;
      const candleOpenTime = Math.floor(tickTimeMs / tfMs) * tfMs;
      const key = `${tick.asset}_${tf}`;

      let current = this.activeCandles.get(key);

      if (!current || current.openTime !== candleOpenTime) {
        // If there was an existing open candle, close it
        if (current) {
          current.isClosed = true;
          this.storeClosedCandle(key, current);
          this.emit('candleClosed', current);
        }

        // Start new candle
        current = {
          asset: tick.asset,
          timeframe: tf,
          openTime: candleOpenTime,
          open: tick.price,
          high: tick.price,
          low: tick.price,
          close: tick.price,
          isClosed: false,
        };
        this.activeCandles.set(key, current);
      } else {
        // Update current candle
        current.high = Math.max(current.high, tick.price);
        current.low = Math.min(current.low, tick.price);
        current.close = tick.price;
      }

      this.emit('candleUpdate', current);
    }
  }

  private storeClosedCandle(key: string, candle: Candle): void {
    let history = this.candleHistory.get(key);
    if (!history) {
      history = [];
      this.candleHistory.set(key, history);
    }

    history.push({ ...candle });
    if (history.length > this.maxHistorySize) {
      history.shift();
    }
  }

  /**
   * Seeds historical candles from an array of past ticks (e.g. from Quotex history/list/v2).
   * Aggregates them into proper M1 and M5 candles so indicators (EMA, RSI, BB) are immediately ready!
   */
  public seedHistory(asset: string, ticks: Tick[]): void {
    if (!ticks || ticks.length === 0) return;
    const cleanAsset = normalizeAsset(asset);

    // Sort ticks chronologically
    const sorted = [...ticks].sort((a, b) => a.time - b.time);

    for (const tf of this.supportedTimeframes) {
      const tfMs = tf * 1000;
      const key = `${cleanAsset}_${tf}`;
      const candlesMap: Map<number, Candle> = new Map();

      for (const t of sorted) {
        const tickTimeMs = t.time > 1e11 ? t.time : t.time * 1000;
        const candleOpenTime = Math.floor(tickTimeMs / tfMs) * tfMs;

        let candle = candlesMap.get(candleOpenTime);
        if (!candle) {
          candle = {
            asset: cleanAsset,
            timeframe: tf,
            openTime: candleOpenTime,
            open: t.price,
            high: t.price,
            low: t.price,
            close: t.price,
            isClosed: true,
          };
          candlesMap.set(candleOpenTime, candle);
        } else {
          candle.high = Math.max(candle.high, t.price);
          candle.low = Math.min(candle.low, t.price);
          candle.close = t.price;
        }
      }

      // Convert map to chronological array
      const candles = Array.from(candlesMap.values()).sort((a, b) => a.openTime - b.openTime);
      if (candles.length > 0) {
        // The very last candle in the history is the currently forming candle
        const active = candles.pop()!;
        active.isClosed = false;
        this.activeCandles.set(key, active);
        this.candleHistory.set(key, candles.slice(-this.maxHistorySize));

        // Debounce log to once every 30 seconds per key to prevent terminal log flooding
        const lastLog = this.lastSeededLog.get(key) || 0;
        if (Date.now() - lastLog > 30000) {
          this.lastSeededLog.set(key, Date.now());
          const tfName = tf === 60 ? 'M1' : tf === 300 ? 'M5' : `${tf}s`;
          console.log(`[CandleAggregator] Seeded ${candles.length} closed ${tfName} candles for ${cleanAsset}. Ready!`);
        }
      }
    }
  }

  /**
   * Returns closed candles for an asset and timeframe (chronological order).
   * If target timeframe has fewer than 8 candles, attempts to synthesize from sub-period (e.g. M1 -> M5).
   */
  public getHistory(asset: string, timeframeSeconds: number): Candle[] {
    const key = `${normalizeAsset(asset)}_${timeframeSeconds}`;
    const direct = this.candleHistory.get(key);
    if (direct && direct.length >= 8) return direct;

    // Synthesize higher timeframe candles from M1 (60s) if available
    if (timeframeSeconds > 60 && timeframeSeconds % 60 === 0) {
      const m1Key = `${normalizeAsset(asset)}_60`;
      const m1Candles = this.candleHistory.get(m1Key) || [];
      const ratio = timeframeSeconds / 60;
      if (m1Candles.length >= ratio) {
        const synthesized: Candle[] = [];
        const groupCount = Math.floor(m1Candles.length / ratio);
        for (let g = 0; g < groupCount; g++) {
          const slice = m1Candles.slice(g * ratio, (g + 1) * ratio);
          if (slice.length === ratio) {
            synthesized.push({
              asset: slice[0].asset,
              timeframe: timeframeSeconds,
              openTime: slice[0].openTime,
              open: slice[0].open,
              high: Math.max(...slice.map((c) => c.high)),
              low: Math.min(...slice.map((c) => c.low)),
              close: slice[slice.length - 1].close,
              isClosed: true,
            });
          }
        }
        if (synthesized.length > (direct?.length || 0)) {
          return synthesized;
        }
      }
    }

    return direct || [];
  }

  /**
   * Returns the currently active (forming) candle
   */
  public getCurrentCandle(asset: string, timeframeSeconds: number): Candle | undefined {
    const key = `${normalizeAsset(asset)}_${timeframeSeconds}`;
    return this.activeCandles.get(key);
  }
}
