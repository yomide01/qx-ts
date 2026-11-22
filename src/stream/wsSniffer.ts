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
  private registry = new AssetRegistry();
  private currentBalance: AccountBalance | null = null;

  // ── Which market is on the chart right now ──
  private domAsset: { asset: string; at: number } | null = null;
  private lastTickAsset: string | null = null;
  private activeAsset: string | null = null;

  // ── Which account (demo / live) is open right now ──
  // Clues: the page address, the account/change + authorization messages the page sends,
  // and (last resort) the on-screen label. The most recent change wins (see accountTracker).
  private tracker = new AccountModeTracker();
  private accountMode: AccountMode = 'UNKNOWN';
  private liveBalanceValue: number | null = null;
  private demoBalanceValue: number | null = null;

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

    // Layer 3: Passive DOM poller. Reads what you can SEE on screen: which market is on the
    // chart, its price/payout, the account label and the balance. Runs every 1.5s so a switch
    // of market or account is picked up quickly.
    setInterval(async () => {
      try {
        if (page.isClosed()) return;
        const dom = await page.evaluate(() => {
          const text = (el: Element | null) => el?.textContent?.trim() || null;
          const first = (selectors: string[]) => {
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && text(el)) return el;
            }
            return null;
          };

          const symbolEl = first([
            '.current-symbol__name',
            '[class*="current-symbol"]',
            '[class*="symbol-name"]',
            '[class*="asset-name"]',
            '.tab-item--active .tab-item__name',
            '[class*="pair-name"]',
            '.chart-top-panel__asset-name',
            '[data-id="asset-name"]',
          ]);
          const priceEl = first([
            '.current-price',
            '[class*="current-price"]',
            '[class*="chart-quote"]',
            '[class*="quote__value"]',
            '.price-value',
          ]);
          const payoutEl = first([
            '[class*="payout-percent"]',
            '[class*="profit-percent"]',
            '[class*="deal-form__payout"]',
            '.payout-value',
          ]);

          // Account label: look only at SHORT texts inside account/balance widgets, so the
          // word "Demo" appearing somewhere else on the page cannot fool us.
          const labelTexts = Array.from(document.querySelectorAll('[class*="account"], [class*="balance"], header'))
            .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t.length > 0 && t.length < 80);
          const joined = labelTexts.join(' | ');
          const sawDemo = /demo|practice/i.test(joined);
          const sawLive = /live account|real account|\blive\b/i.test(joined);

          const balanceEl = first(['[class*="balance"] [class*="value"]', '[class*="balance__value"]', '[class*="balance"]']);
          const balanceMatch = (text(balanceEl) || '').match(/([\d.,]+)/);

          return {
            url: window.location.href,
            symbol: text(symbolEl),
            price: text(priceEl),
            payout: text(payoutEl),
            balance: balanceMatch ? balanceMatch[1] : null,
            labelMode: sawDemo && !sawLive ? 'DEMO' : sawLive && !sawDemo ? 'LIVE' : 'UNKNOWN',
          };
        });

        // ── Account ──
        this.setUrlMode(accountModeFromUrl(dom.url));
        this.tracker.update('screen label', dom.labelMode as AccountMode);
        this.refreshAccountMode();

        // The on-screen balance is only a fallback for when Quotex's own balance message has
        // not been seen (that one is exact and carries both accounts).
        if (dom.balance && this.liveBalanceValue === null && this.demoBalanceValue === null) {
          const balNum = parseFloat(dom.balance.replace(/,/g, ''));
          if (!isNaN(balNum)) this.updateBalance(balNum, 'USD');
        }

        // ── Market on chart ──
        const resolved = dom.symbol ? this.registry.resolve(dom.symbol) : '';
        const priceNum = dom.price ? parseFloat(dom.price.replace(/[^0-9.]/g, '')) : NaN;

        let screenAsset = '';
        if (resolved && (this.registry.isKnown(resolved) || this.latestTicks.has(resolved))) {
          screenAsset = resolved;
        } else if (!isNaN(priceNum) && priceNum > 0) {
          // Name not recognised: find the market whose live price matches the chart price.
          screenAsset = this.matchAssetByPrice(priceNum);
        }
        if (screenAsset) {
          this.domAsset = { asset: screenAsset, at: Date.now() };
        }
        this.refreshActiveAsset();

        // Only fall back to screen-scraped prices if the data stream has gone quiet for this
        // market. Mixing both sources is what used to corrupt the candles.
        if (screenAsset && !isNaN(priceNum) && priceNum > 0) {
          const lastWs = this.lastTickAt.get(screenAsset) ?? 0;
          if (Date.now() - lastWs > 4000) {
            const tick: Tick = { asset: screenAsset, time: Date.now(), price: priceNum };
            this.recordTick(tick);
          }
          if (dom.payout) {
            const pNum = parseFloat(dom.payout.replace(/[^0-9.]/g, ''));
            if (!isNaN(pNum) && pNum > 0 && !this.assetPayouts.has(screenAsset)) {
              this.assetPayouts.set(screenAsset, {
                asset: screenAsset,
                name: dom.symbol || screenAsset,
                payoutPercent: pNum,
                isOtc: screenAsset.endsWith('_OTC'),
                isActive: true,
              });
            }
          }
        }
      } catch {
        // Page navigation or closed cleanly
      }
    }, 1500);
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
      for (const p of payouts) {
        this.registry.learn(p.asset, p.name);
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
    return this.assetPayouts.get(normalizeAsset(asset));
  }

  public getAllPayouts(): AssetPayout[] {
    return Array.from(this.assetPayouts.values());
  }

  public getBalance(): AccountBalance | null {
    return this.currentBalance;
  }
}
