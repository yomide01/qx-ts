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
  private maxHistorySize: number = 250;
  private lastSeededLog: Map<string, number> = new Map();

  constructor(private sniffer: QxWsSniffer) {
    super();
    this.sniffer.on('tick', (tick: Tick) => this.onTick(tick));
    this.sniffer.on('history', (h: { asset: string; period: number; ticks: Tick[]; candles?: Candle[] }) => {
      if (h.candles && h.candles.length > 0) {
        this.seedDirectCandles(h.asset, h.period, h.candles, h.ticks);
      } else {
        this.seedHistory(h.asset, h.ticks);
      }
    });
    this.sniffer.on(
      'chartHistoryPoints',
      (payload: { asset: string; timeframe: number; points: Array<{ value: number; time: number }> }) => {
        this.seedFromChartHistory(payload.asset, payload.timeframe, payload.points);
      }
    );
  }

  private onTick(tick: Tick): void {
    const tickTimeMs = tick.time > 1e11 ? tick.time : tick.time * 1000;

    for (const tf of this.supportedTimeframes) {
      const tfMs = tf * 1000;
      const candleOpenTime = Math.floor(tickTimeMs / tfMs) * tfMs;
      const key = `${tick.asset}_${tf}`;

      let current = this.activeCandles.get(key);
      if (current && candleOpenTime < current.openTime) {
        continue; // Ignore out-of-order / slightly older fallback timestamps
      }

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
      }
    }
  }

  /**
   * Seeds historical candles directly from Quotex's on-screen chart historyPoints
   * (chartSettings.chartById.graph.historyPoints), which contains both 4-point compressed
   * historical candles and live ticks for the currently displayed asset and timeframe.
   */
  public seedFromChartHistory(
    asset: string,
    timeframeSeconds: number,
    points: Array<{ value: number; time: number }>
  ): void {
    if (!points || points.length === 0 || !timeframeSeconds) return;
    const cleanAsset = normalizeAsset(asset);
    const tfMs = timeframeSeconds * 1000;
    const key = `${cleanAsset}_${timeframeSeconds}`;

    const sorted = [...points]
      .filter((p) => typeof p.value === 'number' && !isNaN(p.value) && typeof p.time === 'number' && !isNaN(p.time))
      .sort((a, b) => a.time - b.time);
    if (sorted.length === 0) return;

    const candlesMap: Map<number, Candle> = new Map();
    for (const pt of sorted) {
      const timeMs = pt.time > 1e11 ? pt.time : pt.time * 1000;
      const candleOpenTime = Math.floor(timeMs / tfMs) * tfMs;
      let candle = candlesMap.get(candleOpenTime);
      if (!candle) {
        candle = {
          asset: cleanAsset,
          timeframe: timeframeSeconds,
          openTime: candleOpenTime,
          open: pt.value,
          high: pt.value,
          low: pt.value,
          close: pt.value,
          isClosed: true,
        };
        candlesMap.set(candleOpenTime, candle);
      } else {
        candle.high = Math.max(candle.high, pt.value);
        candle.low = Math.min(candle.low, pt.value);
        candle.close = pt.value;
      }
    }

    const candles = Array.from(candlesMap.values()).sort((a, b) => a.openTime - b.openTime);
    if (candles.length > 0) {
      const active = candles.pop()!;
      active.isClosed = false;
      this.activeCandles.set(key, active);

      const closedSlice = candles.slice(-this.maxHistorySize);
      this.candleHistory.set(key, closedSlice);
    }
  }

  /**
   * Seeds explicit pre-aggregated candles from Quotex history/list/v2 packets.
   */
  public seedDirectCandles(asset: string, period: number, rawCandles: Candle[], recentTicks?: Tick[]): void {
    const cleanAsset = normalizeAsset(asset);
    const tf = period || 60;
    const key = `${cleanAsset}_${tf}`;
    const sorted = [...rawCandles].sort((a, b) => a.openTime - b.openTime);
    if (sorted.length > 0) {
      this.candleHistory.set(key, sorted.slice(-this.maxHistorySize));
    }
    if (recentTicks && recentTicks.length > 0) {
      this.seedHistory(cleanAsset, recentTicks);
    }
  }

  /**
   * Returns closed candles for an asset and timeframe (chronological order).
   * If target timeframe has fewer than 8 candles, attempts to synthesize from sub-period (e.g. M1 -> M5)
   * using aligned timestamp boundaries.
   */
  public getHistory(asset: string, timeframeSeconds: number): Candle[] {
    const key = `${normalizeAsset(asset)}_${timeframeSeconds}`;
    const direct = this.candleHistory.get(key);
    if (direct && direct.length >= 8) return direct;

    // Synthesize higher timeframe candles from M1 (60s) aligned by floor timestamp
    if (timeframeSeconds > 60 && timeframeSeconds % 60 === 0) {
      const m1Key = `${normalizeAsset(asset)}_60`;
      const m1Candles = this.candleHistory.get(m1Key) || [];
      const tfMs = timeframeSeconds * 1000;
      const ratio = timeframeSeconds / 60;
      if (m1Candles.length >= ratio) {
        const buckets = new Map<number, Candle[]>();
        for (const c of m1Candles) {
          const bucketOpen = Math.floor(c.openTime / tfMs) * tfMs;
          const group = buckets.get(bucketOpen) || [];
          group.push(c);
          buckets.set(bucketOpen, group);
        }
        const synthesized: Candle[] = [];
        const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
        for (const bucketOpen of sortedKeys) {
          const slice = buckets.get(bucketOpen)!.sort((a, b) => a.openTime - b.openTime);
          if (slice.length >= Math.min(ratio, 3)) {
            synthesized.push({
              asset: slice[0].asset,
              timeframe: timeframeSeconds,
              openTime: bucketOpen,
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
