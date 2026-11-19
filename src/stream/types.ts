export interface Tick {
  asset: string;
  time: number; // Unix timestamp in seconds or ms
  price: number;
}

export interface Candle {
  asset: string;
  timeframe: number; // in seconds (e.g. 60 for M1, 300 for M5)
  openTime: number;  // Timestamp of candle open (ms)
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed: boolean;
}

export interface AssetPayout {
  asset: string;
  name: string;
  payoutPercent: number; // e.g. 85 for 85%
  isOtc: boolean;
  isActive: boolean;
}

export interface AccountBalance {
  balance: number;
  currency: string;
  isDemo: boolean;
}

export interface TradeDeal {
  id: string;
  asset: string;
  direction: 'call' | 'put';
  amount: number;
  openTime: number;
  closeTime: number;
  openPrice: number;
  closePrice?: number;
  profit?: number;
  status: 'open' | 'won' | 'lost' | 'draw';
  /** Only set when Quotex itself tells us which account the deal belongs to. */
  isDemo?: boolean;
}

export type AccountMode = 'DEMO' | 'LIVE' | 'UNKNOWN';
