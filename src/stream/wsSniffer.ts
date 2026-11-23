import { EventEmitter } from 'events';
import { Page, CDPSession, WebSocket as PlaywrightWebSocket } from 'playwright';
import { QxWsParser, ParsedWsMessage } from './wsParser.js';
import { Tick, AssetPayout, AccountBalance, TradeDeal, AccountMode } from './types.js';
import { AssetRegistry, normalizeAsset } from './assets.js';
import { AccountModeTracker } from './accountTracker.js';
import { pollQuotexScreenTelemetry, ScreenTelemetrySnapshot } from './screenTelemetry.js';

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
    // not a valid URL
  }
  return 'UNKNOWN';
}

export class QxWsSniffer extends EventEmitter {
  private parser: QxWsParser;
  private activeSockets: Set<PlaywrightWebSocket> = new Set();
  private cdpSession: CDPSession | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling: boolean = false;

  private latestTicks: Map<string, Tick> = new Map();
  private lastTickAt: Map<string, number> = new Map();
  private assetPayouts: Map<string, AssetPayout> = new Map();
  private onScreenPayouts: Map<string, { payout: number; at: number }> = new Map();
  private registry = new AssetRegistry();
  private currentBalance: AccountBalance | null = null;

  private domAsset: { asset: string; at: number } | null = null;
  private lastTickAsset: string | null = null;
  private activeAsset: string | null = null;

  private activeTimeframe: number = 300;
  private activeExpiry: number = 60;
  private activeInvestment: number = 100;

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

  private lastHistoryFingerprint: string = '';
  private lastHistorySeedAt: number = 0;

  private lastFrameSig: string = '';
  private lastFrameAt: number = 0;

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
   * Attaches passive listeners to the page via Playwright WebSockets, CDP, and throttled Redux telemetry.
   */
  public async attachToPage(page: Page): Promise<void> {
    this.stop();
    console.log('[WsSniffer] Attaching dual-layer WebSocket & CDP interceptor...');

    page.on('websocket', (ws: PlaywrightWebSocket) => {
      const url = ws.url();
      console.log(`[WsSniffer] Observed WebSocket stream: ${url}`);
      this.activeSockets.add(ws);

      ws.on('framereceived', ({ payload }) => {
        this.handleIncomingFrame(payload);
      });

      ws.on('framesent', ({ payload }) => {
        this.handleOutgoingFrame(payload);
      });

      ws.on('close', () => {
        this.activeSockets.delete(ws);
      });
    });

    try {
      this.cdpSession = await page.context().newCDPSession(page);
      await this.cdpSession.send('Network.enable');

      this.cdpSession.on('Network.webSocketFrameReceived', (event: any) => {
        const payloadData = event.response?.payloadData;
        if (payloadData) this.handleIncomingFrame(payloadData);
      });

      this.cdpSession.on('Network.webSocketFrameSent', (event: any) => {
        const payloadData = event.response?.payloadData;
        if (payloadData) this.handleOutgoingFrame(payloadData);
      });

      console.log('[WsSniffer] CDP network stream listener successfully active.');
    } catch (err) {
      console.warn('[WsSniffer Warning] CDP session notice:', (err as Error).message);
    }

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.setUrlMode(accountModeFromUrl(frame.url()));
    });
    this.setUrlMode(accountModeFromUrl(page.url()));

    const runPoll = async () => {
      if (this.isPolling || page.isClosed()) return;
      this.isPolling = true;
      try {
        const dom = await pollQuotexScreenTelemetry(page, 3000);
        if (dom) {
          this.applyTelemetrySnapshot(dom);
        }
      } catch {
        // Ignore transient navigation errors
      } finally {
        this.isPolling = false;
      }
    };

    await runPoll();
    this.pollTimer = setInterval(runPoll, 1200);
  }

  /** Stops the polling timer and detaches the CDP session cleanly. */
  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cdpSession) {
      this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
  }

  private applyTelemetrySnapshot(dom: ScreenTelemetrySnapshot): void {
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

    // Deals tracking (seed closedIds on startup so historical closed deals are never replayed)
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

    if (dom.chartTfSec && dom.chartTfSec !== this.activeTimeframe) {
      const prevTf = this.activeTimeframe;
      this.activeTimeframe = dom.chartTfSec;
      this.emit('timeframeChanged', { timeframe: this.activeTimeframe, previous: prevTf });
    }
    if (dom.expirySec) this.activeExpiry = dom.expirySec;
    if (typeof dom.dealAmount === 'number' && dom.dealAmount > 0) this.activeInvestment = dom.dealAmount;

    if (Array.isArray(dom.indicatorsList)) this.activeIndicators = dom.indicatorsList;
    if (Array.isArray(dom.drawingsList)) this.activeDrawings = dom.drawingsList;
    if (dom.sentiment) this.activeSentiment = dom.sentiment;
    if (Array.isArray(dom.platformSignals)) this.platformSignals = dom.platformSignals;
    if (Array.isArray(dom.openTabs)) this.openAssetTabs = dom.openTabs;

    if (Array.isArray(dom.allStorePayouts) && dom.allStorePayouts.length > 0) {
      const now = Date.now();
      for (const sp of dom.allStorePayouts) {
        const cleanSym = normalizeAsset(sp.symbol);
        this.registry.learn(cleanSym, sp.label);
        const onScreen = this.onScreenPayouts.get(cleanSym);
        const tfPayout = this.activeTimeframe >= 300 && sp.payout5 ? sp.payout5 : sp.payout1 || sp.payout;
        const authoritativePayout = onScreen && now - onScreen.at < 60000 ? onScreen.payout : tfPayout;
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
          payout: authoritativePayout,
          isOtc: sp.isOtc,
          m5Change: sp.m5Change || 0,
          h1Change: sp.h1Change || 0,
          dayChange: sp.dayChange || 0,
        });
      }
    }

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

    if (screenAsset && dom.payout && dom.payout > 0) {
      const clean = normalizeAsset(screenAsset);
      this.onScreenPayouts.set(clean, { payout: dom.payout, at: Date.now() });
      const existing = this.assetPayouts.get(clean);
      if (!existing || existing.payoutPercent !== dom.payout) {
        this.assetPayouts.set(clean, {
          asset: clean,
          name: dom.label || dom.symbol || clean,
          payoutPercent: dom.payout,
          payout1mPercent: existing?.payout1mPercent,
          payout5mPercent: existing?.payout5mPercent,
          isOtc: clean.endsWith('_OTC'),
          isActive: true,
        });
        this.emit('payouts', Array.from(this.assetPayouts.values()));
      }
    }

    // Deduplicate chartHistoryPoints seeding by fingerprint
    if (screenAsset && Array.isArray(dom.historyPoints) && dom.historyPoints.length > 20) {
      const firstPt = dom.historyPoints[0];
      const lastPt = dom.historyPoints[dom.historyPoints.length - 1];
      const fp = `${screenAsset}_${this.activeTimeframe}_${dom.historyPoints.length}_${firstPt?.time}_${Math.floor(
        (lastPt?.time ?? 0) / this.activeTimeframe
      )}`;
      if (fp !== this.lastHistoryFingerprint || Date.now() - this.lastHistorySeedAt > 15000) {
        this.lastHistoryFingerprint = fp;
        this.lastHistorySeedAt = Date.now();
        this.emit('chartHistoryPoints', {
          asset: screenAsset,
          timeframe: this.activeTimeframe,
          points: dom.historyPoints,
        });
      }
    }

    if (screenAsset && !isNaN(priceNum) && priceNum > 0) {
      const lastWs = this.lastTickAt.get(screenAsset) ?? 0;
      const prevPrice = this.latestTicks.get(screenAsset)?.price;
      if (Date.now() - lastWs > 1500 || prevPrice !== priceNum) {
        const tickTime = typeof dom.serverTimeMs === 'number' && dom.serverTimeMs > 0 ? dom.serverTimeMs : Date.now();
        this.recordTick({ asset: screenAsset, time: tickTime, price: priceNum });
      }
    }
  }

  // ───────────────────────── account mode ─────────────────────────

  private setUrlMode(mode: AccountMode): void {
    this.tracker.update('page address', mode);
    this.refreshAccountMode();
  }

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

  public getActiveAsset(): string | null {
    this.refreshActiveAsset();
    return this.activeAsset;
  }

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
      return;
    }
    this.lastFrameSig = sig;
    this.lastFrameAt = now;

    this.totalFramesReceived++;
    const parsed = this.parser.parseFrame(payload);
    if (!parsed) return;

    if (this.debugMode) this.emit('raw', parsed);

    const { eventName, data } = parsed;

    const tick = this.parser.extractTick(eventName, data);
    if (tick) this.recordTick(tick);

    const historyData = this.parser.extractHistory(eventName, data);
    if (historyData) {
      this.registry.markSeen(historyData.asset);
      this.emit('history', historyData);
    }

    const payouts = this.parser.extractPayouts(eventName, data);
    if (payouts.length > 0) {
      const tNow = Date.now();
      for (const p of payouts) {
        this.registry.learn(p.asset, p.name);
        const onScreen = this.onScreenPayouts.get(p.asset);
        if (onScreen && tNow - onScreen.at < 60000) {
          p.payoutPercent = onScreen.payout;
        }
        this.assetPayouts.set(p.asset, p);
      }
      this.emit('payouts', payouts);
    }

    const balances = this.parser.extractBalances(data);
    if (balances) {
      if (balances.live !== undefined) this.liveBalanceValue = balances.live;
      if (balances.demo !== undefined) this.demoBalanceValue = balances.demo;
      this.refreshBalanceForMode();
    } else {
      const balance = this.parser.extractBalance(eventName, data);
      if (balance) {
        this.tracker.update('Quotex request', balance.isDemo ? 'DEMO' : 'LIVE');
        this.refreshAccountMode();
        if (balance.isDemo) this.demoBalanceValue = balance.balance;
        else this.liveBalanceValue = balance.balance;
        this.refreshBalanceForMode();
      }
    }

    const deal = this.parser.extractDeal(eventName, data);
    if (deal) this.emit('deal', deal);
  }

  public getLatestTick(asset: string): Tick | undefined {
    return this.latestTicks.get(normalizeAsset(asset));
  }

  public getPayout(asset: string): AssetPayout | undefined {
    const clean = normalizeAsset(asset);
    const existing = this.assetPayouts.get(clean);
    const onScreen = this.onScreenPayouts.get(clean);
    if (onScreen && Date.now() - onScreen.at < 60000) {
      if (existing) return { ...existing, payoutPercent: onScreen.payout };
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

  public setOnScreenPayout(asset: string, payoutPercent: number): void {
    const clean = normalizeAsset(asset);
    this.onScreenPayouts.set(clean, { payout: payoutPercent, at: Date.now() });
    const existing = this.assetPayouts.get(clean);
    this.assetPayouts.set(clean, {
      asset: clean,
      name: existing?.name || clean,
      payoutPercent,
      payout1mPercent: existing?.payout1mPercent,
      payout5mPercent: existing?.payout5mPercent,
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

  public getMarketAvailabilityCounts(): { liveCount: number; otcCount: number } {
    let liveCount = 0;
    let otcCount = 0;
    for (const p of this.storePairStats.values()) {
      if (p.payout >= 80) {
        if (p.isOtc) otcCount++;
        else liveCount++;
      }
    }
    return { liveCount, otcCount };
  }

  public getRecommendedAlternativePairs(
    currentAsset: string,
    limit: number = 3,
    allowOtc: boolean = true
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
      (p) =>
        p.asset !== cleanCurrent &&
        p.payout >= 82 &&
        (allowOtc || !p.isOtc) &&
        (p.type === 'currency' || !p.type)
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
    return scored.slice(0, limit).map(({ totalScore: _s, ...rest }) => rest);
  }
}
