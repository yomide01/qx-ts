import { EventEmitter } from 'events';
import { Tick, Candle } from './types.js';
import { QxWsSniffer } from './wsSniffer.js';
import { normalizeAsset } from './assets.js';
import { TradingJournalDB } from '../journal/database.js';

export interface CandleEvents {
  candleUpdate: (candle: Candle) => void;
  candleClosed: (candle: Candle) => void;
}

export class CandleAggregator extends EventEmitter {
  // Key format: `${asset}_${timeframeSeconds}`
  private activeCandles: Map<string, Candle> = new Map();
  private candleHistory: Map<string, Candle[]> = new Map();
  private loadedFromDb: Set<string> = new Set();
  private supportedTimeframes: number[] = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  private maxHistorySize: number = 5000;
  private db: TradingJournalDB | null = null;

  constructor(
    private sniffer: QxWsSniffer,
    db?: TradingJournalDB
  ) {
    super();
    this.db = db ?? null;

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

  private ensureLoadedFromDb(cleanAsset: string, timeframeSeconds: number): void {
    if (!this.db) return;
    const key = `${cleanAsset}_${timeframeSeconds}`;
    if (this.loadedFromDb.has(key)) return;
    this.loadedFromDb.add(key);

    try {
      const persisted = this.db.getCandles(cleanAsset, timeframeSeconds, this.maxHistorySize);
      if (persisted.length > 0) {
        this.mergeClosedCandles(key, persisted, false);
      }
    } catch {
      // Safe fallback if DB is closed or read-only
    }
  }

  /**
   * Merges incoming closed candles into the existing series by `openTime` so live chart
   * refreshes (~200 bars) NEVER wipe out earlier accumulated or SQLite-persisted history.
   */
  private mergeClosedCandles(key: string, incoming: Candle[], persist: boolean = true): Candle[] {
    const existing = this.candleHistory.get(key) || [];
    const byOpenTime = new Map<number, Candle>();

    for (const c of existing) {
      byOpenTime.set(c.openTime, c);
    }

    const newlyAddedOrUpdated: Candle[] = [];
    for (const c of incoming) {
      if (c.isClosed === false) continue;
      const prev = byOpenTime.get(c.openTime);
      if (
        !prev ||
        prev.open !== c.open ||
        prev.high !== c.high ||
        prev.low !== c.low ||
        prev.close !== c.close
      ) {
        const merged: Candle = prev
          ? {
              ...c,
              high: Math.max(prev.high, c.high),
              low: Math.min(prev.low, c.low),
              isClosed: true,
            }
          : { ...c, isClosed: true };
        byOpenTime.set(c.openTime, merged);
        newlyAddedOrUpdated.push(merged);
      }
    }

    const sorted = Array.from(byOpenTime.values())
      .sort((a, b) => a.openTime - b.openTime)
      .slice(-this.maxHistorySize);

    this.candleHistory.set(key, sorted);

    if (persist && this.db && newlyAddedOrUpdated.length > 0) {
      try {
        this.db.saveCandles(newlyAddedOrUpdated);
      } catch {
        // Ignore persistence errors during shutdown
      }
    }

    return sorted;
  }

  private onTick(tick: Tick): void {
    const tickTimeMs = tick.time > 1e11 ? tick.time : tick.time * 1000;
    const cleanAsset = normalizeAsset(tick.asset);

    for (const tf of this.supportedTimeframes) {
      const tfMs = tf * 1000;
      const candleOpenTime = Math.floor(tickTimeMs / tfMs) * tfMs;
      const key = `${cleanAsset}_${tf}`;

      let current = this.activeCandles.get(key);
      if (current && candleOpenTime < current.openTime) {
        continue;
      }

      if (!current || current.openTime !== candleOpenTime) {
        if (current) {
          current.isClosed = true;
          this.ensureLoadedFromDb(cleanAsset, tf);
          this.mergeClosedCandles(key, [current], tf >= 60);
          this.emit('candleClosed', current);
        }

        current = {
          asset: cleanAsset,
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
        current.high = Math.max(current.high, tick.price);
        current.low = Math.min(current.low, tick.price);
        current.close = tick.price;
      }

      this.emit('candleUpdate', current);
    }
  }

  /**
   * Seeds historical candles from an array of past ticks and merges with existing history.
   */
  public seedHistory(asset: string, ticks: Tick[]): void {
    if (!ticks || ticks.length === 0) return;
    const cleanAsset = normalizeAsset(asset);
    const sorted = [...ticks].sort((a, b) => a.time - b.time);

    for (const tf of this.supportedTimeframes) {
      const tfMs = tf * 1000;
      const key = `${cleanAsset}_${tf}`;
      this.ensureLoadedFromDb(cleanAsset, tf);

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

      const candles = Array.from(candlesMap.values()).sort((a, b) => a.openTime - b.openTime);
      if (candles.length > 0) {
        const active = candles.pop()!;
        active.isClosed = false;
        const prevActive = this.activeCandles.get(key);
        if (!prevActive || active.openTime >= prevActive.openTime) {
          this.activeCandles.set(key, active);
        }
        if (candles.length > 0) {
          this.mergeClosedCandles(key, candles, tf >= 60);
        }
      }
    }
  }

  /**
   * Seeds historical candles from Quotex's on-screen chart historyPoints (4-point compressed OHLC + live ticks),
   * merging cleanly with previously collected & SQLite-persisted candles.
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
    this.ensureLoadedFromDb(cleanAsset, timeframeSeconds);

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
      const prevActive = this.activeCandles.get(key);
      if (!prevActive || active.openTime >= prevActive.openTime) {
        this.activeCandles.set(key, active);
      }
      if (candles.length > 0) {
        this.mergeClosedCandles(key, candles, true);
      }
    }
  }

  /**
   * Seeds explicit pre-aggregated candles from Quotex history/list/v2 packets.
   */
  public seedDirectCandles(asset: string, period: number, rawCandles: Candle[], recentTicks?: Tick[]): void {
    const cleanAsset = normalizeAsset(asset);
    const tf = period || 60;
    const key = `${cleanAsset}_${tf}`;
    this.ensureLoadedFromDb(cleanAsset, tf);

    const sorted = [...rawCandles].sort((a, b) => a.openTime - b.openTime);
    if (sorted.length > 0) {
      this.mergeClosedCandles(key, sorted, true);
    }
    if (recentTicks && recentTicks.length > 0) {
      this.seedHistory(cleanAsset, recentTicks);
    }
  }

  /**
   * Returns closed candles for an asset and timeframe in chronological order.
   */
  public getHistory(asset: string, timeframeSeconds: number): Candle[] {
    const cleanAsset = normalizeAsset(asset);
    const key = `${cleanAsset}_${timeframeSeconds}`;
    this.ensureLoadedFromDb(cleanAsset, timeframeSeconds);

    const direct = this.candleHistory.get(key);
    if (direct && direct.length >= 8) return direct;

    // Synthesize higher timeframe candles from M1 (60s) aligned by floor timestamp
    if (timeframeSeconds > 60 && timeframeSeconds % 60 === 0) {
      this.ensureLoadedFromDb(cleanAsset, 60);
      const m1Key = `${cleanAsset}_60`;
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

  public getCurrentCandle(asset: string, timeframeSeconds: number): Candle | undefined {
    const key = `${normalizeAsset(asset)}_${timeframeSeconds}`;
    return this.activeCandles.get(key);
  }
}
