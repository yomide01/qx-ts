export interface IndicatorSnapshot {
  emaFast?: number;
  emaSlow?: number;
  rsi?: number;
  atr?: number;
  bbUpper?: number;
  bbLower?: number;
  bbMiddle?: number;
  candleWickRatio?: number;
  extra?: Record<string, any>;
}

export interface TradeRecord {
  id: string; // Quotex deal ID or UUID
  asset: string;
  isOtc: boolean;
  direction: 'CALL' | 'PUT';
  timeframeSeconds: number; // e.g. 300 for 5M
  payoutPercent: number; // e.g. 85 for 85%
  stakeAmount: number;
  openTime: number; // ms
  closeTime: number; // ms
  openPrice: number;
  closePrice?: number;
  status: 'OPEN' | 'WON' | 'LOST' | 'DRAW';
  profitLoss?: number;
  isDemo: boolean;
  signalConfidence?: number; // 0-100%
  signalReason?: string; // e.g. "EMA 50 Bounce + RSI Divergence"
  marketRegime?: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY';
  indicatorsAtEntry?: IndicatorSnapshot;
}

export interface AnalyticsSummary {
  totalTrades: number;
  wonTrades: number;
  lostTrades: number;
  drawTrades: number;
  overallWinRate: number; // percentage
  liveWinRate: number;
  liveTotal: number;
  otcWinRate: number;
  otcTotal: number;
  totalPnL: number;
  averagePayout: number;
  expectedValue: number; // EV per trade in decimal (e.g. +0.05 is +5% per trade)
  isMathematicallyProfitable: boolean;
  byAsset: Record<string, { total: number; wins: number; winRate: number; pnl: number }>;
  byRegime: Record<string, { total: number; wins: number; winRate: number }>;
}
