import { Tick, AssetPayout, AccountBalance, TradeDeal } from './types.js';

export interface ParsedWsMessage {
  eventName: string;
  data: any;
}

export class QxWsParser {
  private pendingEvent: string | null = null;

  /**
   * Parses raw WebSocket frames from Quotex.
   * Handles:
   * 1. Socket.IO headers: 42["event", ...], 451-["event", {"_placeholder":true,"num":0}]
   * 2. Binary attachments (received as Base64 from CDP or Buffer/string)
   * 3. Plain JSON objects and arrays
   */
  public parseFrame(payload: string | Buffer): ParsedWsMessage | null {
    try {
      let text = typeof payload === 'string' ? payload : payload.toString('utf-8');

      // Heartbeat frames
      if (text === '2' || text === '3' || text === '40' || text === '41') {
        return null;
      }

      // Check if this is a binary payload in Base64 (from Chrome CDP)
      if (!text.startsWith('4') && !text.startsWith('{') && !text.startsWith('[')) {
        try {
          const decoded = Buffer.from(text, 'base64').toString('utf-8');
          if (decoded.includes('[') || decoded.includes('{')) {
            text = decoded;
          }
        } catch {}
      }

      // Clean leading control bytes (e.g. Socket.IO binary packet type byte 0x04)
      const clean = text.replace(/^[\x00-\x1F]+/, '').trim();

      // Case 1: Socket.IO event header (e.g. 451-["quotes/stream", ...], 42["history/list/v2", ...])
      const soMatch = clean.match(/^\d+(?:-\d+)?\["([^"]+)"(?:,(.*))?\]$/s);
      if (soMatch) {
        const eventName = soMatch[1];
        const rawArg = soMatch[2]?.trim();

        // If there's a placeholder for binary attachment, record pendingEvent
        if (rawArg && rawArg.includes('_placeholder')) {
          this.pendingEvent = eventName;
          return { eventName, data: null };
        }

        if (rawArg) {
          try {
            const data = JSON.parse(rawArg);
            return { eventName, data };
          } catch {
            return { eventName, data: rawArg };
          }
        }
        this.pendingEvent = eventName;
        return { eventName, data: null };
      }

      // Case 2: Binary attachment or data frame following a pending event
      if (this.pendingEvent) {
        const ev = this.pendingEvent;
        this.pendingEvent = null; // consume

        try {
          const parsed = JSON.parse(clean);
          return { eventName: ev, data: parsed };
        } catch {
          // Could be raw text or partial
          return { eventName: ev, data: clean };
        }
      }

      // Case 3: Raw JSON array (e.g. instruments list on startup: [[368, "ATOUSD_otc", ...]])
      if (clean.startsWith('[') && clean.endsWith(']')) {
        try {
          const arr = JSON.parse(clean);
          if (Array.isArray(arr)) {
            // Check if this looks like instrument list: array of arrays with [id, symbol, name, ...]
            if (arr.length > 0 && Array.isArray(arr[0]) && typeof arr[0][1] === 'string' && typeof arr[0][5] === 'number') {
              return { eventName: 'instruments', data: arr };
            }
            // Check if this is a quote tick: [["EURGBP", timestamp, price, flag]]
            if (arr.length > 0 && Array.isArray(arr[0]) && typeof arr[0][0] === 'string' && typeof arr[0][2] === 'number') {
              return { eventName: 'quotes/stream', data: arr };
            }
            return { eventName: 'array_data', data: arr };
          }
        } catch {}
      }

      // Case 4: Raw JSON object
      if (clean.startsWith('{') && clean.endsWith('}')) {
        try {
          const obj = JSON.parse(clean);
          if (obj.history && obj.asset) {
            return { eventName: 'history/list/v2', data: obj };
          }
          return {
            eventName: obj.event || obj.type || 'json_message',
            data: obj.data ?? obj,
          };
        } catch {}
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Normalizes incoming event data to a standard Tick object.
   * Handles Quotex format: [["EURGBP", 1795115471.017, 0.83776, 1]]
   */
  public extractTick(eventName: string, data: any): Tick | null {
    if (!data) return null;

    // Pattern 1: Quotex quotes/stream: [["EURGBP", 1795115471.017, 0.83776, 1]]
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      if (Array.isArray(first) && first.length >= 3) {
        const asset = String(first[0]).toUpperCase().replace(/\//g, '');
        let time = Number(first[1]);
        // Convert seconds to ms if needed
        if (time < 1e11) time = Math.round(time * 1000);
        const price = Number(first[2]);

        if (asset && !isNaN(price) && price > 0) {
          return { asset, time, price };
        }
      }
    }

    // Pattern 2: Object format { asset, price, time }
    if (data.asset && data.price !== undefined) {
      const asset = String(data.asset).toUpperCase().replace(/\//g, '');
      const price = Number(data.price);
      let time = Number(data.time ?? Date.now());
      if (time < 1e11) time = Math.round(time * 1000);
      if (asset && !isNaN(price)) return { asset, time, price };
    }

    // Pattern 3: { symbol, rate }
    if (data.symbol && (data.rate !== undefined || data.close !== undefined)) {
      const asset = String(data.symbol).toUpperCase().replace(/\//g, '');
      const price = Number(data.rate ?? data.close);
      let time = Number(data.time ?? Date.now());
      if (time < 1e11) time = Math.round(time * 1000);
      if (asset && !isNaN(price)) return { asset, time, price };
    }

    return null;
  }

  /**
   * Extracts historical ticks from Quotex "history/list/v2" packet.
   * Format: { asset: "EURGBP", period: 300, history: [[timestamp, price, flag], ...] }
   */
  public extractHistory(eventName: string, data: any): { asset: string; period: number; ticks: Tick[] } | null {
    if (!data || typeof data !== 'object') return null;
    if (data.history && Array.isArray(data.history) && data.asset) {
      const asset = String(data.asset).toUpperCase().replace(/\//g, '');
      const period = Number(data.period || 300);
      const ticks: Tick[] = [];

      for (const item of data.history) {
        if (Array.isArray(item) && item.length >= 2) {
          let time = Number(item[0]);
          if (time < 1e11) time = Math.round(time * 1000);
          const price = Number(item[1]);
          if (!isNaN(price) && price > 0) {
            ticks.push({ asset, time, price });
          }
        }
      }

      return { asset, period, ticks };
    }
    return null;
  }

  /**
   * Extracts payouts from Quotex instruments array:
   * Format: [[368, "ATOUSD_otc", "Cosmos (OTC)", "cryptocurrency", 4, 92, ...], ...]
   */
  public extractPayouts(eventName: string, data: any): AssetPayout[] {
    const payouts: AssetPayout[] = [];
    if (!data) return payouts;

    const list = Array.isArray(data) ? data : data.instruments || data.assets || [];

    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item) continue;

        // Quotex array format: [id, symbol, name, category, precision, payoutPercent, ...]
        if (Array.isArray(item) && item.length >= 6) {
          const rawSymbol = String(item[1] || '');
          const rawName = String(item[2] || rawSymbol);
          const payoutVal = Number(item[5]);

          if (rawSymbol && !isNaN(payoutVal) && payoutVal > 0) {
            const isOtc = rawSymbol.toLowerCase().includes('otc') || rawName.toLowerCase().includes('otc');
            const cleanAsset = rawSymbol.toUpperCase().replace(/\//g, '');

            payouts.push({
              asset: cleanAsset,
              name: rawName,
              payoutPercent: payoutVal > 1 ? payoutVal : payoutVal * 100,
              isOtc,
              isActive: item[14] !== false,
            });
          }
          continue;
        }

        // Generic object format: { symbol, name, payout }
        if (typeof item === 'object') {
          const asset = item.symbol || item.asset || item.name || item.id;
          const payout = Number(item.profit_percent ?? item.payout ?? item.payment ?? item.profit);
          if (asset && !isNaN(payout) && payout > 0) {
            const name = String(item.name || asset);
            const isOtc = name.toLowerCase().includes('otc') || Boolean(item.is_otc);
            payouts.push({
              asset: String(asset).toUpperCase().replace(/\//g, ''),
              name,
              payoutPercent: payout > 1 ? payout : payout * 100,
              isOtc,
              isActive: item.active !== false && item.enabled !== false,
            });
          }
        }
      }
    }

    return payouts;
  }

  /**
   * Extracts balance from authorization or balance packets.
   */
  public extractBalance(eventName: string, data: any): AccountBalance | null {
    if (!data || typeof data !== 'object') return null;

    if (data.live_balance !== undefined || data.demo_balance !== undefined || data.balance !== undefined) {
      const isDemo = Boolean(data.isDemo ?? data.is_demo ?? true);
      const balance = Number(isDemo ? (data.demo_balance ?? data.balance ?? 0) : (data.live_balance ?? data.balance ?? 0));
      return {
        balance,
        currency: String(data.currency || 'USD'),
        isDemo,
      };
    }
    return null;
  }

  /**
   * Extracts deals / trade executions.
   */
  public extractDeal(eventName: string, data: any): TradeDeal | null {
    if (!data || typeof data !== 'object') return null;

    const id = String(data.id ?? data.deal_id ?? data.ticket ?? '');
    const asset = String(data.asset ?? data.symbol ?? '');
    const direction = String(data.dir ?? data.direction ?? data.cmd ?? '').toLowerCase();

    if (!id || !asset) return null;

    return {
      id,
      asset: asset.toUpperCase().replace(/\//g, ''),
      direction: direction === 'call' || direction === 'up' || direction === '1' ? 'call' : 'put',
      amount: Number(data.amount ?? data.open_cost ?? 0),
      openTime: Number(data.open_time ?? data.openTime ?? Date.now()),
      closeTime: Number(data.close_time ?? data.closeTime ?? 0),
      openPrice: Number(data.open_price ?? data.openPrice ?? 0),
      closePrice: data.close_price !== undefined ? Number(data.close_price) : undefined,
      profit: data.profit !== undefined ? Number(data.profit) : undefined,
      status: data.close_time ? (Number(data.profit) > 0 ? 'won' : Number(data.profit) < 0 ? 'lost' : 'draw') : 'open',
    };
  }
}
