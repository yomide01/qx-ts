import { EventEmitter } from 'events';
import { Page, CDPSession, WebSocket as PlaywrightWebSocket } from 'playwright';
import { QxWsParser, ParsedWsMessage } from './wsParser.js';
import { Tick, AssetPayout, AccountBalance, TradeDeal, AccountMode } from './types.js';
import { AssetRegistry, normalizeAsset } from './assets.js';
import { AccountModeTracker } from './accountTracker.js';

export interface QxWsSnifferEvents {
  tick: (tick: Tick) => void;
  payouts: (payouts: AssetPayout[]) => void;
  balance: (balance: AccountBalance) => void;
  deal: (deal: TradeDeal) => void;
  raw: (msg: ParsedWsMessage) => void;
  activeAssetChanged: (info: { asset: string; previous: string | null }) => void;
  accountChanged: (info: { mode: AccountMode; previous: AccountMode; source: string }) => void;
  timeframeChanged: (info: { timeframe: number; previous: number }) => void;
}

/** Works out DEMO / LIVE from a Quotex page address (/demo-trade = demo, /trade = live). */
export function accountModeFromUrl(url: string): AccountMode {
  try {
    const segments = new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
    if (segments.includes('demo-trade')) return 'DEMO';
    if (segments.includes('trade')) return 'LIVE';
  } catch {
    // not a valid URL (e.g. about:blank)
  }
  return 'UNKNOWN';
}

export class QxWsSniffer extends EventEmitter {
  private parser: QxWsParser;
  private activeSockets: Set<PlaywrightWebSocket> = new Set();
  private cdpSession: CDPSession | null = null;
  private latestTicks: Map<string, Tick> = new Map();
  private lastTickAt: Map<string, number> = new Map();
  private assetPayouts: Map<string, AssetPayout> = new Map();
  private onScreenPayouts: Map<string, { payout: number; at: number }> = new Map();
  private registry = new AssetRegistry();
  private currentBalance: AccountBalance | null = null;

  // ── Which market is on the chart right now ──
  private domAsset: { asset: string; at: number } | null = null;
  private lastTickAsset: string | null = null;
  private activeAsset: string | null = null;

  // ── Timeframe & Expiry on chart ──
  private activeTimeframe: number = 300; // default 5m
  private activeExpiry: number = 60; // default 1m
  private activeInvestment: number = 100;

  // ── On-screen built-in indicators, drawings, sentiment & platform forecast ──
  private activeIndicators: Array<{ id: string; type: string; period?: number; visible: boolean; settings?: any }> = [];
  private activeDrawings: Array<{ id: string; type?: string }> = [];
  private activeSentiment: { callPercent: number; putPercent: number } | null = null;
  private platformSignals: Array<[number, string]> = [];
  private openAssetTabs: Array<{ symbol: string; label: string; payout: number }> = [];
  private storePairStats: Map<
    string,
    {
      asset: string;
      label: string;
      type: string;
      payout: number;
      isOtc: boolean;
      m5Change: number;
      h1Change: number;
      dayChange: number;
    }
  > = new Map();
  private lastHistorySeedKey: string = '';
  private lastHistorySeedAt: number = 0;

  // ── Frame deduplication between Playwright WS and CDP ──
  private lastFrameSig: string = '';
  private lastFrameAt: number = 0;

  // ── Which account (demo / live) is open right now ──
  // Clues: the page address, the account/change + authorization messages the page sends,
  // and (last resort) the on-screen label. The most recent change wins (see accountTracker).
  private tracker = new AccountModeTracker();
  private accountMode: AccountMode = 'UNKNOWN';
  private liveBalanceValue: number | null = null;
  private demoBalanceValue: number | null = null;
  private lastPolledUrl: string = '';
  private lastPolledIsDemo: boolean | null = null;
  private knownOpenDealIds: Set<string> = new Set();
  private knownClosedDealIds: Set<string> = new Set();
  private dealsSeeded: boolean = false;

  public totalFramesReceived: number = 0;
  public totalTicksReceived: number = 0;
  public debugMode: boolean = false;

  constructor() {
    super();
    this.parser = new QxWsParser();
  }

  /**
   * Attaches passive listeners to the page via both Playwright WebSockets
   * and Chrome DevTools Protocol (CDP) for low-level frame capture.
   */
  public async attachToPage(page: Page): Promise<void> {
    console.log('[WsSniffer] Attaching dual-layer WebSocket & CDP interceptor...');

    // Layer 1: Playwright native WebSocket listener
    page.on('websocket', (ws: PlaywrightWebSocket) => {
      const url = ws.url();
      console.log(`[WsSniffer] Observed WebSocket stream: ${url}`);
      this.activeSockets.add(ws);

      ws.on('framereceived', ({ payload }) => {
        this.handleIncomingFrame(payload);
      });

      // Frames the page SENDS: this is how we see "account/change" the instant you switch.
      ws.on('framesent', ({ payload }) => {
        this.handleOutgoingFrame(payload);
      });

      ws.on('close', () => {
        this.activeSockets.delete(ws);
      });
    });

    // Layer 2: Chrome DevTools Protocol (CDP) for full network engine capture
    try {
      this.cdpSession = await page.context().newCDPSession(page);
      await this.cdpSession.send('Network.enable');

      this.cdpSession.on('Network.webSocketFrameReceived', (event: any) => {
        const payloadData = event.response?.payloadData;
        if (payloadData) {
          this.handleIncomingFrame(payloadData);
        }
      });

      this.cdpSession.on('Network.webSocketFrameSent', (event: any) => {
        const payloadData = event.response?.payloadData;
        if (payloadData) {
          this.handleOutgoingFrame(payloadData);
        }
      });

      console.log('[WsSniffer] CDP network stream listener successfully active.');
    } catch (err) {
      console.warn('[WsSniffer Warning] CDP session notice:', (err as Error).message);
    }

    // The address changes the moment you switch between Demo and Live, so react instantly.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.setUrlMode(accountModeFromUrl(frame.url()));
    });
    this.setUrlMode(accountModeFromUrl(page.url()));

    // Layer 3: Live Platform & Screen Telemetry Poller.
    // Reads both the rendered Quotex screen (hashed CSS module selectors) AND Quotex's live React/Redux
    // chart store so account balance, active asset, payout, timeframe (5s..1d), expiry, built-in indicators,
    // drawings, trader sentiment, and historical candles are synchronized in real time.
    const pollScreenAndStore = async () => {
      try {
        if (page.isClosed()) return;
        const dom = (await page.evaluate(`(() => {
          const text = (el) => el?.textContent?.trim() || null;
          const first = (selectors) => {
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && text(el)) return el;
            }
            return null;
          };

          // 1. Access Quotex's live React Fiber & Redux store on .chart-container if available
          let storeState = null;
          let fiberProps = null;
          try {
            const chartContainer = document.querySelector('.chart-container') || document.querySelector('canvas');
            const key = chartContainer
              ? Object.keys(chartContainer).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))
              : null;
            let curr = chartContainer && key ? chartContainer[key] : null;
            let depth = 0;
            while (curr && depth < 20) {
              const p = curr.memoizedProps || {};
              if (p.symbol && p.chartPeriod !== undefined && !fiberProps) {
                fiberProps = p;
              }
              if (p.value?.store && typeof p.value.store.getState === 'function') {
                storeState = p.value.store.getState();
                break;
              }
              curr = curr.return;
              depth++;
            }
          } catch (e) {}

          const cs = storeState?.chartSettings || null;
          const globalSt = storeState?.global || null;
          const activeChartId =
            globalSt?.currentChartId ||
            (Array.isArray(cs?.visibleChartIds) && cs.visibleChartIds[0]) ||
            (Array.isArray(cs?.chartIds) && cs.chartIds[0]) ||
            'graph';
          const graph =
            cs?.chartById?.[activeChartId] ||
            cs?.chartById?.graph ||
            (cs?.chartById ? Object.values(cs.chartById)[0] : null);
          const winSettings = typeof window !== 'undefined' && window.settings ? window.settings : null;
          const assetBySymbol = storeState?.assets?.assetBySymbol || {};

          // 2. Active Asset Symbol, Label, Live Price & Authoritative On-Screen Payout
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
          let storeSymbol = visibleSym || graph?.currentAsset?.symbol || fiberProps?.symbol || null;

          // If the visible Deal Panel pair text (e.g. "EUR/GBP (OTC)" or "USD/JPY") is present,
          // match it against assetBySymbol so the visible pair on screen ALWAYS wins!
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
            if (!storeSymbol) {
              storeSymbol = domPairText;
            }
          }

          const liveAssetObj = (storeSymbol && assetBySymbol[storeSymbol]) || graph?.currentAsset?.obj || null;
          const storeLabel = domPairText || liveAssetObj?.label || storeSymbol;

          // Live quote price from store quotes dictionary or currentAsset
          const quoteObj = storeSymbol && storeState?.quotes?.quoteBySymbol ? storeState.quotes.quoteBySymbol[storeSymbol] : null;
          const storePrice =
            typeof quoteObj?.price === 'number'
              ? quoteObj.price
              : typeof graph?.currentAsset?.price === 'number' && graph?.currentAsset?.symbol === storeSymbol
              ? graph.currentAsset.price
              : null;

          // Authoritative Payout:
          // Priority 1: Visible Deal Panel payout element (.OmOPV .eB25d or .UI2Kh)
          // Priority 2: Deal Panel dollar return calculation ((Payout$ - Investment$) / Investment$)
          // Priority 3: Live assetBySymbol[storeSymbol].payout in Redux
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

          // 3. Candle Timeframe (e.g. 5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h, 4h, 1d)
          // Primary source: the visible timeframe control in .NDbAT .HgaSf at bottom-left of chart
          const periodCodeMap = {
            1: 5,
            2: 10,
            3: 15,
            4: 60,
            5: 120,
            6: 300,
            7: 600,
            8: 900,
            9: 1800,
            10: 3600,
            11: 14400,
            12: 86400,
            13: 30,
          };
          const parseTfLabel = (str) => {
            if (!str) return null;
            const m = str.trim().toLowerCase().match(/^(5s|10s|15s|30s|1m|2m|5m|10m|15m|30m|1h|4h|1d)$/);
            if (!m) return null;
            const val = parseInt(m[1].slice(0, -1), 10);
            const unit = m[1].slice(-1);
            return unit === 's' ? val : unit === 'm' ? val * 60 : unit === 'h' ? val * 3600 : val * 86400;
          };

          let chartTfSec = null;
          const tfCandidates = Array.from(document.querySelectorAll('.NDbAT .HgaSf, .NDbAT div, button, [class*="timeframe"]'));
          for (const el of tfCandidates) {
            const parsed = parseTfLabel(el.textContent || '');
            if (parsed) {
              chartTfSec = parsed;
              break;
            }
          }
          if (!chartTfSec && graph?.chartPeriod && periodCodeMap[graph.chartPeriod]) {
            chartTfSec = periodCodeMap[graph.chartPeriod];
          }
          if (!chartTfSec) chartTfSec = 300;

          // 4. Trade Expiry Duration (from store timePeriod or right-side Time input e.g. "00:01:00" or "05:00")
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

          // Investment stake
          let dealAmount = typeof graph?.dealValue === 'number' ? graph.dealValue : 100;

          // 5. Account Mode (DEMO vs LIVE) and Balances
          let isDemoFlag = null;
          // Check visible top-right account label first, then Redux global state
          const bodyUpper = (document.body?.innerText || '').slice(0, 1200);
          if (/LIVE\s+ACCOUNT|REAL\s+ACCOUNT/i.test(bodyUpper) && !/DEMO\s+ACCOUNT/i.test(bodyUpper)) {
            isDemoFlag = false;
          } else if (/DEMO\s+ACCOUNT/i.test(bodyUpper) && !/LIVE\s+ACCOUNT|REAL\s+ACCOUNT/i.test(bodyUpper)) {
            isDemoFlag = true;
          } else if (globalSt?.activeAccount) {
            isDemoFlag = String(globalSt.activeAccount).toLowerCase() === 'demo';
          } else if (typeof globalSt?.isDemo === 'boolean') {
            isDemoFlag = globalSt.isDemo;
          } else if (winSettings?.isDemo !== undefined) {
            isDemoFlag = Boolean(Number(winSettings.isDemo));
          }

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

          // 6. Active Built-in Indicators & Drawings on Chart
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

          // 7. Live Trader Sentiment bar (left side of chart: ._ImZx / .qXmSx)
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

          // 8. Open Asset Tabs & All Active Asset Payouts (with Forex trend stats)
          const openTabs = Array.from(document.querySelectorAll('.H4wMV')).map((el) => {
            const nameText = text(el.querySelector('.WRocw')) || '';
            const payText = text(el.querySelector('.ElyTP')) || '';
            const pm = payText.match(/(\\d{1,3})/);
            return {
              symbol: nameText,
              label: nameText,
              payout: pm ? parseInt(pm[1], 10) : 0,
            };
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

          // 9. Active Open Deals & Newly Closed Deals from Redux Store
          const openedById = storeState?.deals?.openedById || {};
          const closedById = storeState?.deals?.closedById || {};
          const closedIds = Array.isArray(storeState?.deals?.closedIds) ? storeState.deals.closedIds.slice(0, 10) : [];
          const openedDealsList = Object.values(openedById);
          const recentClosedList = closedIds.map((cid) => closedById[cid]).filter(Boolean);

          // 10. History points for the active chart (verified against storePrice so tab switches never mix history)
          const rawHistory = Array.isArray(graph?.historyPoints)
            ? graph.historyPoints
            : Array.isArray(fiberProps?.historyPoints)
            ? fiberProps.historyPoints
            : [];
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
        })()`)) as any;

        // ── Account & Balance (Only update URL mode when URL actually changes!) ──
        if (dom.url && dom.url !== this.lastPolledUrl) {
          this.lastPolledUrl = dom.url;
          this.setUrlMode(accountModeFromUrl(dom.url));
        }
        if (typeof dom.isDemoFlag === 'boolean') {
          const detectedMode: AccountMode = dom.isDemoFlag ? 'DEMO' : 'LIVE';
          if (this.lastPolledIsDemo !== dom.isDemoFlag || this.accountMode !== detectedMode) {
            this.lastPolledIsDemo = dom.isDemoFlag;
            this.tracker.update('Quotex request', detectedMode);
          }
        }
        this.refreshAccountMode();

        if (typeof dom.demoBalanceNum === 'number' && !isNaN(dom.demoBalanceNum)) {
          this.demoBalanceValue = dom.demoBalanceNum;
        }
        if (typeof dom.liveBalanceNum === 'number' && !isNaN(dom.liveBalanceNum)) {
          this.liveBalanceValue = dom.liveBalanceNum;
        }
        this.refreshBalanceForMode();

        // ── Process Store Deals (Guarantees open trades stay OPEN until truly settled in closedById) ──
        if (!this.dealsSeeded && Array.isArray(dom.recentClosedList) && dom.recentClosedList.length > 0) {
          this.dealsSeeded = true;
          for (const cd of dom.recentClosedList) {
            if (cd?.id) this.knownClosedDealIds.add(String(cd.id));
          }
        }
        if (Array.isArray(dom.openedDealsList)) {
          for (const od of dom.openedDealsList) {
            if (od?.id && !this.knownOpenDealIds.has(String(od.id))) {
              this.knownOpenDealIds.add(String(od.id));
              const openDeal = this.parser.extractDeal('deals/open', { ...od, isClosed: false });
              if (openDeal) {
                openDeal.status = 'open';
                this.emit('deal', openDeal);
              }
            }
          }
        }
        if (this.dealsSeeded && Array.isArray(dom.recentClosedList)) {
          for (const cd of dom.recentClosedList) {
            const cid = cd?.id ? String(cd.id) : '';
            // Only emit a settled deal if we saw it open during this session (never replay old history!)
            if (cid && !this.knownClosedDealIds.has(cid) && this.knownOpenDealIds.has(cid)) {
              this.knownClosedDealIds.add(cid);
              const closedDeal = this.parser.extractDeal('deals/close', { ...cd, isClosed: true });
              if (closedDeal && closedDeal.status !== 'open') {
                this.emit('deal', closedDeal);
              }
            } else if (cid && !this.knownClosedDealIds.has(cid)) {
              this.knownClosedDealIds.add(cid);
            }
          }
        }

        // ── Timeframe, Expiry & Investment ──
        if (dom.chartTfSec && dom.chartTfSec !== this.activeTimeframe) {
          const prevTf = this.activeTimeframe;
          this.activeTimeframe = dom.chartTfSec;
          this.emit('timeframeChanged', { timeframe: this.activeTimeframe, previous: prevTf });
        }
        if (dom.expirySec) {
          this.activeExpiry = dom.expirySec;
        }
        if (typeof dom.dealAmount === 'number' && dom.dealAmount > 0) {
          this.activeInvestment = dom.dealAmount;
        }

        // ── Indicators, Drawings, Sentiment & Platform Signals ──
        if (Array.isArray(dom.indicatorsList)) this.activeIndicators = dom.indicatorsList;
        if (Array.isArray(dom.drawingsList)) this.activeDrawings = dom.drawingsList;
        if (dom.sentiment) this.activeSentiment = dom.sentiment;
        if (Array.isArray(dom.platformSignals)) this.platformSignals = dom.platformSignals;
        if (Array.isArray(dom.openTabs)) this.openAssetTabs = dom.openTabs;

        // ── Sync All Store Asset Payouts & Forex Pair Stats ──
        if (Array.isArray(dom.allStorePayouts) && dom.allStorePayouts.length > 0) {
          const now = Date.now();
          for (const sp of dom.allStorePayouts) {
            const cleanSym = normalizeAsset(sp.symbol);
            this.registry.learn(cleanSym, sp.label);
            const onScreen = this.onScreenPayouts.get(cleanSym);
            const authoritativePayout = onScreen && now - onScreen.at < 60000 ? onScreen.payout : sp.payout;
            this.assetPayouts.set(cleanSym, {
              asset: cleanSym,
              name: sp.label,
              payoutPercent: authoritativePayout,
              payout1mPercent: sp.payout1,
              payout5mPercent: sp.payout5,
              isOtc: sp.isOtc,
              isActive: true,
            });
            this.storePairStats.set(cleanSym, {
              asset: cleanSym,
              label: sp.label,
              type: sp.type || 'currency',
              payout: this.activeTimeframe >= 300 && sp.payout5 ? sp.payout5 : authoritativePayout,
              isOtc: sp.isOtc,
              m5Change: sp.m5Change || 0,
              h1Change: sp.h1Change || 0,
              dayChange: sp.dayChange || 0,
            });
          }
        }

        // ── Market on chart ──
        if (dom.symbol && dom.label) {
          this.registry.learn(dom.symbol, dom.label);
        }
        const resolved = dom.symbol ? normalizeAsset(dom.symbol) : '';
        const priceNum = dom.price ? parseFloat(String(dom.price).replace(/[^0-9.]/g, '')) : NaN;

        let screenAsset = '';
        if (resolved) {
          screenAsset = resolved;
        } else if (!isNaN(priceNum) && priceNum > 0) {
          screenAsset = this.matchAssetByPrice(priceNum);
        }
        if (screenAsset) {
          this.domAsset = { asset: screenAsset, at: Date.now() };
        }
        this.refreshActiveAsset();

        // ── Authoritative On-Screen Payout ──
        if (screenAsset && dom.payout && dom.payout > 0) {
          const clean = normalizeAsset(screenAsset);
          this.onScreenPayouts.set(clean, { payout: dom.payout, at: Date.now() });
          const existing = this.assetPayouts.get(clean);
          if (!existing || existing.payoutPercent !== dom.payout) {
            this.assetPayouts.set(clean, {
              asset: clean,
              name: dom.label || dom.symbol || clean,
              payoutPercent: dom.payout,
              isOtc: clean.endsWith('_OTC'),
              isActive: true,
            });
            this.emit('payouts', Array.from(this.assetPayouts.values()));
          }
        }

        // ── Seed Chart Historical Candles Immediately From Screen (Verified & Isolated per Asset + Timeframe) ──
        if (screenAsset && Array.isArray(dom.historyPoints) && dom.historyPoints.length > 20) {
          const seedKey = `${screenAsset}_${this.activeTimeframe}`;
          if (seedKey !== this.lastHistorySeedKey || Date.now() - this.lastHistorySeedAt > 4000) {
            this.lastHistorySeedKey = seedKey;
            this.lastHistorySeedAt = Date.now();
            this.emit('chartHistoryPoints', {
              asset: screenAsset,
              timeframe: this.activeTimeframe,
              points: dom.historyPoints,
            });
          }
        }

        // ── Live Quote Tick Update (using Quotex server timestamp to stay aligned with chart candles) ──
        if (screenAsset && !isNaN(priceNum) && priceNum > 0) {
          const lastWs = this.lastTickAt.get(screenAsset) ?? 0;
          const prevPrice = this.latestTicks.get(screenAsset)?.price;
          if (Date.now() - lastWs > 1500 || prevPrice !== priceNum) {
            const tickTime = typeof dom.serverTimeMs === 'number' && dom.serverTimeMs > 0 ? dom.serverTimeMs : Date.now();
            const tick: Tick = { asset: screenAsset, time: tickTime, price: priceNum };
            this.recordTick(tick);
          }
        }
      } catch {
        // Page navigation or closed cleanly
      }
    };

    // Run once immediately and then every 1.2s
    await pollScreenAndStore();
    setInterval(pollScreenAndStore, 1200);
  }

  // ───────────────────────── account mode ─────────────────────────

  private setUrlMode(mode: AccountMode): void {
    this.tracker.update('page address', mode);
    this.refreshAccountMode();
  }

  /** Reads messages the browser sent to Quotex (account switches / connecting). */
  public handleOutgoingFrame(payload: string | Buffer): void {
    const isDemo = QxWsParser.parseOutgoingAccountFrame(payload);
    if (isDemo === null) return;
    this.tracker.update('Quotex request', isDemo ? 'DEMO' : 'LIVE');
    this.refreshAccountMode();
  }

  private refreshAccountMode(): void {
    const next = this.tracker.current();
    if (next === this.accountMode) return;
    const previous = this.accountMode;
    this.accountMode = next;
    this.refreshBalanceForMode();
    this.emit('accountChanged', { mode: next, previous, source: this.tracker.source() });
  }

  /** Picks the balance of the account that is open right now. */
  private refreshBalanceForMode(): void {
    const mode = this.accountMode;
    const value = mode === 'LIVE' ? this.liveBalanceValue : mode === 'DEMO' ? this.demoBalanceValue : null;
    if (value === null) return;
    const currency = this.currentBalance?.currency ?? 'USD';
    const changed =
      !this.currentBalance || this.currentBalance.balance !== value || this.currentBalance.isDemo !== (mode === 'DEMO');
    this.currentBalance = { balance: value, currency, isDemo: mode === 'DEMO' };
    if (changed) this.emit('balance', this.currentBalance);
  }

  private updateBalance(balance: number, currency: string): void {
    const isDemo = this.accountMode !== 'LIVE';
    const changed =
      !this.currentBalance || this.currentBalance.balance !== balance || this.currentBalance.isDemo !== isDemo;
    this.currentBalance = { balance, currency, isDemo };
    if (changed) this.emit('balance', this.currentBalance);
  }

  /** DEMO, LIVE, or UNKNOWN when the bot genuinely cannot tell. */
  public getAccountMode(): AccountMode {
    return this.accountMode;
  }

  // ───────────────────────── active market ─────────────────────────

  private matchAssetByPrice(price: number): string {
    const now = Date.now();
    let best = '';
    let bestDiff = Infinity;
    let matches = 0;
    for (const [asset, tick] of this.latestTicks) {
      if (now - (this.lastTickAt.get(asset) ?? 0) > 10000) continue;
      const diff = Math.abs(tick.price - price) / price;
      if (diff < 0.0005) {
        matches++;
        if (diff < bestDiff) {
          bestDiff = diff;
          best = asset;
        }
      }
    }
    return matches === 1 ? best : '';
  }

  private refreshActiveAsset(): void {
    const now = Date.now();
    const fromScreen = this.domAsset && now - this.domAsset.at < 8000 ? this.domAsset.asset : null;
    const next = fromScreen ?? this.lastTickAsset;
    if (next && next !== this.activeAsset) {
      const previous = this.activeAsset;
      this.activeAsset = next;
      this.emit('activeAssetChanged', { asset: next, previous });
    }
  }

  /** The market currently on your chart (null until the first data arrives). */
  public getActiveAsset(): string | null {
    this.refreshActiveAsset();
    return this.activeAsset;
  }

  /** Markets that have sent a price within the last `withinMs` milliseconds. */
  public getStreamingAssets(withinMs: number = 15000): string[] {
    const now = Date.now();
    return Array.from(this.lastTickAt.entries())
      .filter(([, at]) => now - at <= withinMs)
      .map(([asset]) => asset);
  }

  // ───────────────────────── frames ─────────────────────────

  private recordTick(tick: Tick): void {
    this.totalTicksReceived++;
    this.latestTicks.set(tick.asset, tick);
    this.lastTickAt.set(tick.asset, Date.now());
    this.lastTickAsset = tick.asset;
    this.registry.markSeen(tick.asset);
    this.emit('tick', tick);
  }

  public handleIncomingFrame(payload: string | Buffer): void {
    const rawStr = typeof payload === 'string' ? payload : payload.toString('utf-8');
    const sig = rawStr.length > 120 ? `${rawStr.length}:${rawStr.slice(0, 60)}:${rawStr.slice(-40)}` : rawStr;
    const now = Date.now();
    if (sig === this.lastFrameSig && now - this.lastFrameAt < 15) {
      return; // Deduplicate identical consecutive frame received from both Playwright WS and CDP
    }
    this.lastFrameSig = sig;
    this.lastFrameAt = now;

    this.totalFramesReceived++;
    const parsed = this.parser.parseFrame(payload);
    if (!parsed) return;

    if (this.debugMode) {
      this.emit('raw', parsed);
    }

    const { eventName, data } = parsed;

    // Check for Tick
    const tick = this.parser.extractTick(eventName, data);
    if (tick) {
      this.recordTick(tick);
    }

    // Check for Historical Ticks/Candles
    const historyData = this.parser.extractHistory(eventName, data);
    if (historyData) {
      this.registry.markSeen(historyData.asset);
      this.emit('history', historyData);
    }

    // Check for Payouts
    const payouts = this.parser.extractPayouts(eventName, data);
    if (payouts.length > 0) {
      const now = Date.now();
      for (const p of payouts) {
        this.registry.learn(p.asset, p.name);
        const onScreen = this.onScreenPayouts.get(p.asset);
        if (onScreen && now - onScreen.at < 60000) {
          // Authoritative on-screen payout overrides WebSocket stream data
          p.payoutPercent = onScreen.payout;
        }
        this.assetPayouts.set(p.asset, p);
      }
      this.emit('payouts', payouts);
    }

    // Check for Balances: Quotex sends { liveBalance, demoBalance } together
    const balances = this.parser.extractBalances(data);
    if (balances) {
      if (balances.live !== undefined) this.liveBalanceValue = balances.live;
      if (balances.demo !== undefined) this.demoBalanceValue = balances.demo;
      this.refreshBalanceForMode();
    } else {
      // Older/explicit format that states which account the balance belongs to
      const balance = this.parser.extractBalance(eventName, data);
      if (balance) {
        this.tracker.update('Quotex request', balance.isDemo ? 'DEMO' : 'LIVE');
        this.refreshAccountMode();
        if (balance.isDemo) this.demoBalanceValue = balance.balance;
        else this.liveBalanceValue = balance.balance;
        this.refreshBalanceForMode();
      }
    }

    // Check for Deal
    const deal = this.parser.extractDeal(eventName, data);
    if (deal) {
      this.emit('deal', deal);
    }
  }

  public getLatestTick(asset: string): Tick | undefined {
    return this.latestTicks.get(normalizeAsset(asset));
  }

  public getPayout(asset: string): AssetPayout | undefined {
    const clean = normalizeAsset(asset);
    const existing = this.assetPayouts.get(clean);
    const onScreen = this.onScreenPayouts.get(clean);
    if (onScreen && Date.now() - onScreen.at < 60000) {
      if (existing) {
        return { ...existing, payoutPercent: onScreen.payout };
      }
      return {
        asset: clean,
        name: clean,
        payoutPercent: onScreen.payout,
        isOtc: clean.endsWith('_OTC'),
        isActive: true,
      };
    }
    return existing;
  }

  public getAllPayouts(): AssetPayout[] {
    const now = Date.now();
    return Array.from(this.assetPayouts.values()).map((p) => {
      const onScreen = this.onScreenPayouts.get(p.asset);
      if (onScreen && now - onScreen.at < 60000) {
        return { ...p, payoutPercent: onScreen.payout };
      }
      return p;
    });
  }

  /**
   * Directly sets authoritative on-screen payout (e.g. from active tab or deal form).
   * Overrides any WebSocket stream data for this asset.
   */
  public setOnScreenPayout(asset: string, payoutPercent: number): void {
    const clean = normalizeAsset(asset);
    this.onScreenPayouts.set(clean, { payout: payoutPercent, at: Date.now() });
    const existing = this.assetPayouts.get(clean);
    this.assetPayouts.set(clean, {
      asset: clean,
      name: existing?.name || clean,
      payoutPercent,
      isOtc: clean.endsWith('_OTC'),
      isActive: true,
    });
    this.emit('payouts', Array.from(this.assetPayouts.values()));
  }

  public getBalance(): AccountBalance | null {
    return this.currentBalance;
  }

  public getActiveTimeframe(): number {
    return this.activeTimeframe;
  }

  public getActiveExpiry(): number {
    return this.activeExpiry;
  }

  public getActiveInvestment(): number {
    return this.activeInvestment;
  }

  public getOnScreenIndicators(): Array<{ id: string; type: string; period?: number; visible: boolean; settings?: any }> {
    return this.activeIndicators;
  }

  public getOnScreenDrawings(): Array<{ id: string; type?: string }> {
    return this.activeDrawings;
  }

  public getSentiment(): { callPercent: number; putPercent: number } | null {
    return this.activeSentiment;
  }

  /**
   * Returns Quotex's own internal platform directional signal for the nearest matching expiry (if available).
   */
  public getPlatformSignal(timeframeSeconds?: number): 'CALL' | 'PUT' | null {
    if (!this.platformSignals || this.platformSignals.length === 0) return null;
    const target = timeframeSeconds || this.activeTimeframe || 300;
    let bestDir: string | null = null;
    let bestDiff = Infinity;
    for (const entry of this.platformSignals) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const tf = Number(entry[0]);
        const dir = String(entry[1]).toLowerCase();
        const diff = Math.abs(tf - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestDir = dir;
        }
      }
    }
    if (bestDir === 'call' || bestDir === 'up') return 'CALL';
    if (bestDir === 'put' || bestDir === 'down') return 'PUT';
    return null;
  }

  public getOpenAssetTabs(): Array<{ symbol: string; label: string; payout: number }> {
    return this.openAssetTabs;
  }

  /**
   * Ranks and returns the top alternative Forex pairs when the current pair is choppy or low-payout.
   * Prioritizes currency pairs with high payout (>= 84%) and aligned M5 + H1 directional momentum.
   */
  public getRecommendedAlternativePairs(
    currentAsset: string,
    limit: number = 3
  ): Array<{
    asset: string;
    label: string;
    payout: number;
    m5Change: number;
    h1Change: number;
    trendBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  }> {
    const cleanCurrent = normalizeAsset(currentAsset);
    const candidates = Array.from(this.storePairStats.values()).filter(
      (p) => p.asset !== cleanCurrent && p.payout >= 82 && (p.type === 'currency' || !p.type)
    );

    const scored = candidates.map((p) => {
      const sameSign = (p.m5Change > 0 && p.h1Change > 0) || (p.m5Change < 0 && p.h1Change < 0);
      const momentumScore = Math.abs(p.m5Change) * 15 + Math.abs(p.h1Change) * 5 + (sameSign ? 10 : 0);
      const totalScore = p.payout + Math.min(25, momentumScore);
      const trendBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
        p.m5Change > 0.03 && p.h1Change >= 0
          ? 'BULLISH'
          : p.m5Change < -0.03 && p.h1Change <= 0
          ? 'BEARISH'
          : 'NEUTRAL';
      return {
        asset: p.asset,
        label: p.label,
        payout: p.payout,
        m5Change: p.m5Change,
        h1Change: p.h1Change,
        trendBias,
        totalScore,
      };
    });

    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored.slice(0, limit);
  }
}
