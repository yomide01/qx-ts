import { Page } from 'playwright';
import { REDUX_STORE_HELPER_JS, PERIOD_CODE_MAP_JS } from '../browser/reduxBridge.js';

export interface ScreenTelemetrySnapshot {
  url: string;
  symbol: string | null;
  label: string | null;
  price: string | null;
  serverTimeMs: number;
  payout: number | null;
  chartTfSec: number;
  expirySec: number;
  dealAmount: number;
  isDemoFlag: boolean | null;
  demoBalanceNum: number | null;
  liveBalanceNum: number | null;
  indicatorsList: Array<{ id: string; type: string; period?: number; visible: boolean; settings?: any }>;
  drawingsList: Array<{ id: string; type?: string }>;
  sentiment: { callPercent: number; putPercent: number } | null;
  platformSignals: Array<[number, string]>;
  openTabs: Array<{ symbol: string; label: string; payout: number }>;
  allStorePayouts: Array<{
    symbol: string;
    label: string;
    type: string;
    payout: number;
    payout1?: number;
    payout5?: number;
    isOtc: boolean;
    m5Change: number;
    h1Change: number;
    dayChange: number;
  }>;
  openedDealsList: any[];
  recentClosedList: any[];
  historyPoints: Array<{ value: number; time: number }>;
}

const TELEMETRY_SCRIPT = `(() => {
  ${REDUX_STORE_HELPER_JS}
  ${PERIOD_CODE_MAP_JS}

  const text = (el) => el?.textContent?.trim() || null;
  const first = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && text(el)) return el;
    }
    return null;
  };

  const storeState = getReduxState();
  const cs = storeState?.chartSettings || null;
  const globalSt = storeState?.global || null;
  const graph = getActiveGraph(storeState);
  const winSettings = typeof window !== 'undefined' && window.settings ? window.settings : null;
  const assetBySymbol = storeState?.assets?.assetBySymbol || {};

  // Active Asset Symbol, Label, Live Price & Authoritative On-Screen Payout
  const dealPanelSymbolEl = first([
    '.OmOPV .paPcy',
    '.VyFjj',
    '.current-symbol__name',
    '[class*="current-symbol"]',
    '[class*="symbol-name"]',
    '[class*="asset-name"]',
    '.tab-item--active .tab-item__name',
  ]);
  const priceEl = first([
    '.current-price',
    '[class*="current-price"]',
    '[class*="chart-quote"]',
    '[class*="quote__value"]',
    '.price-value',
  ]);

  const domPairText = text(dealPanelSymbolEl);
  const visibleSym = Array.isArray(cs?.visibleSymbols) && cs.visibleSymbols[0] ? cs.visibleSymbols[0] : null;
  let storeSymbol = visibleSym || graph?.currentAsset?.symbol || null;

  if (domPairText) {
    const normText = domPairText.replace(/\\s+/g, ' ').trim().toLowerCase();
    for (const symKey of Object.keys(assetBySymbol)) {
      const a = assetBySymbol[symKey];
      if (
        a &&
        (String(a.label || '').trim().toLowerCase() === normText ||
          String(a.symbol || '').trim().toLowerCase() === normText)
      ) {
        storeSymbol = a.symbol || symKey;
        break;
      }
    }
    if (!storeSymbol) storeSymbol = domPairText;
  }

  const liveAssetObj = (storeSymbol && assetBySymbol[storeSymbol]) || graph?.currentAsset?.obj || null;
  const storeLabel = domPairText || liveAssetObj?.label || storeSymbol;

  const quoteObj = storeSymbol && storeState?.quotes?.quoteBySymbol ? storeState.quotes.quoteBySymbol[storeSymbol] : null;
  const storePrice =
    typeof quoteObj?.price === 'number'
      ? quoteObj.price
      : typeof graph?.currentAsset?.price === 'number' && graph?.currentAsset?.symbol === storeSymbol
      ? graph.currentAsset.price
      : null;

  // Authoritative Payout: Deal Panel DOM -> Dollar return ratio -> Redux assetBySymbol
  let payoutNum = null;
  const pEl = first([
    '.OmOPV .eB25d',
    '.UI2Kh',
    '[class*="payout-percent"]',
    '[class*="profit-percent"]',
    '[class*="deal-form__payout"]',
    '.payout-value',
  ]);
  if (pEl && pEl.textContent) {
    const m = pEl.textContent.match(/(\\d{1,3})\\s*%/);
    if (m) {
      const parsed = parseInt(m[1], 10);
      if (parsed >= 10 && parsed <= 99) payoutNum = parsed;
    }
  }
  if (!payoutNum) {
    const payoutDollarText = text(document.querySelector('.omlQ2 b, .w7PIC b'));
    const invAmt = typeof graph?.dealValue === 'number' && graph.dealValue > 0 ? graph.dealValue : null;
    if (payoutDollarText && invAmt) {
      const pDol = parseFloat(payoutDollarText.replace(/[^0-9.]/g, ''));
      if (!isNaN(pDol) && pDol > invAmt) {
        const calcPct = Math.round(((pDol - invAmt) / invAmt) * 100);
        if (calcPct >= 10 && calcPct <= 99) payoutNum = calcPct;
      }
    }
  }
  if (!payoutNum && typeof liveAssetObj?.payout === 'number' && liveAssetObj.payout > 0) {
    payoutNum = liveAssetObj.payout;
  }

  // Strictly resolve TRUE candle timeframe (NEVER confuses with expiry graph.timePeriod)
  const chartTfSec = resolveCandleTimeframeSeconds(graph);

  // Deal Expiry Duration (graph.timePeriod or Time input)
  let expirySec = typeof graph?.timePeriod === 'number' && graph.timePeriod > 0 ? graph.timePeriod : null;
  const timeInputs = Array.from(document.querySelectorAll('input.input-control__input, [class*="deal-form"] input'));
  for (const el of timeInputs) {
    const val = (el.value || el.textContent || '').trim();
    const m3 = val.match(/^(\\d{2}):(\\d{2}):(\\d{2})$/);
    if (m3) {
      const total = parseInt(m3[1], 10) * 3600 + parseInt(m3[2], 10) * 60 + parseInt(m3[3], 10);
      if (total > 0) {
        expirySec = total;
        break;
      }
    }
  }
  if (!expirySec) expirySec = 60;

  const dealAmount = typeof graph?.dealValue === 'number' ? graph.dealValue : 100;

  // Account Mode & Balances
  const isDemoFlag = resolveAccountIsDemo(storeState);
  const demoBalanceNum =
    typeof globalSt?.demoBalance === 'number'
      ? globalSt.demoBalance
      : winSettings?.demoBalance !== undefined
      ? parseFloat(String(winSettings.demoBalance))
      : null;
  const liveBalanceNum =
    typeof globalSt?.liveBalance === 'number'
      ? globalSt.liveBalance
      : winSettings?.liveBalance !== undefined
      ? parseFloat(String(winSettings.liveBalance))
      : null;

  // Built-in Indicators & Drawings
  const indicatorsList = [];
  const indById = storeState?.indicators?.byId || {};
  for (const id of Object.keys(indById)) {
    const ind = indById[id];
    if (ind) {
      indicatorsList.push({
        id: ind.id || id,
        type: ind.type || 'unknown',
        period: ind.settings?.period,
        visible: ind.visible !== false && ind.settings?.isVisibility !== false,
        settings: ind.settings,
      });
    }
  }

  const drawingsList = [];
  const drawById = storeState?.drawings?.byId || {};
  for (const id of Object.keys(drawById)) {
    const d = drawById[id];
    if (d) drawingsList.push({ id: d.id || id, type: d.type || d.name || 'drawing' });
  }

  let sentiment = null;
  const s1 = text(document.querySelector('._ImZx'));
  const s2 = text(document.querySelector('.qXmSx'));
  if (s1 && s2) {
    const p1 = parseInt(s1, 10);
    const p2 = parseInt(s2, 10);
    if (!isNaN(p1) && !isNaN(p2)) {
      sentiment = { putPercent: p1, callPercent: p2 };
    }
  }

  const openTabs = Array.from(document.querySelectorAll('.H4wMV')).map((el) => {
    const nameText = text(el.querySelector('.WRocw')) || '';
    const payText = text(el.querySelector('.ElyTP')) || '';
    const pm = payText.match(/(\\d{1,3})/);
    return { symbol: nameText, label: nameText, payout: pm ? parseInt(pm[1], 10) : 0 };
  });

  const allStorePayouts = [];
  for (const sym of Object.keys(assetBySymbol)) {
    const a = assetBySymbol[sym];
    if (a && a.active && typeof a.payout === 'number' && a.payout > 0) {
      allStorePayouts.push({
        symbol: a.symbol || sym,
        label: a.label || sym,
        type: a.type || 'currency',
        payout: a.payout,
        payout1: a.payout_1,
        payout5: a.payout_5,
        isOtc: Boolean(a.is_otc),
        m5Change: typeof a.m5_change === 'number' ? a.m5_change : 0,
        h1Change: typeof a.h1_change === 'number' ? a.h1_change : 0,
        dayChange: typeof a.day_change === 'number' ? a.day_change : 0,
      });
    }
  }

  const openedById = storeState?.deals?.openedById || {};
  const closedById = storeState?.deals?.closedById || {};
  const closedIds = Array.isArray(storeState?.deals?.closedIds) ? storeState.deals.closedIds.slice(0, 10) : [];
  const openedDealsList = Object.values(openedById);
  const recentClosedList = closedIds.map((cid) => closedById[cid]).filter(Boolean);

  // History points verified against storePrice so tab switches never mix history
  const rawHistory = Array.isArray(graph?.historyPoints) ? graph.historyPoints : [];
  const lastPt = rawHistory.length > 0 ? rawHistory[rawHistory.length - 1] : null;
  const historyVerified =
    lastPt &&
    typeof lastPt.value === 'number' &&
    typeof storePrice === 'number' &&
    storePrice > 0 &&
    Math.abs(lastPt.value - storePrice) / storePrice < 0.02;
  const fullHistory = historyVerified ? rawHistory : [];
  const serverTimeMs =
    lastPt && typeof lastPt.time === 'number'
      ? lastPt.time > 1e11
        ? Math.round(lastPt.time)
        : Math.round(lastPt.time * 1000)
      : typeof globalSt?.currentTime === 'number'
      ? globalSt.currentTime * 1000
      : Date.now();

  return {
    url: window.location.href,
    symbol: storeSymbol || domPairText,
    label: storeLabel || domPairText,
    price: storePrice !== null ? String(storePrice) : text(priceEl),
    serverTimeMs,
    payout: payoutNum,
    chartTfSec,
    expirySec,
    dealAmount,
    isDemoFlag,
    demoBalanceNum,
    liveBalanceNum,
    indicatorsList,
    drawingsList,
    sentiment,
    platformSignals: Array.isArray(liveAssetObj?.signals) ? liveAssetObj.signals : [],
    openTabs,
    allStorePayouts,
    openedDealsList,
    recentClosedList,
    historyPoints: fullHistory,
  };
})()`;

/**
 * Safely reads live screen + Redux telemetry from the Quotex browser page with a hard timeout.
 */
export async function pollQuotexScreenTelemetry(
  page: Page,
  timeoutMs: number = 3000
): Promise<ScreenTelemetrySnapshot | null> {
  if (page.isClosed()) return null;
  try {
    return await Promise.race([
      page.evaluate(TELEMETRY_SCRIPT) as Promise<ScreenTelemetrySnapshot>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}
