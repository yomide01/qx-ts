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
    // chart, its real price/payout, timeframe, account label and balance. Runs every 1.5s so
    // any switch is picked up immediately.
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

          // Exact on-screen Payout (from active tab, deal form, or payout elements)
          let payoutNum: number | null = null;
          const activeTabEl = document.querySelector('.tab-item--active, [class*="tab--active"]');
          if (activeTabEl && activeTabEl.textContent) {
            const m = activeTabEl.textContent.match(/(\d{1,3})%/);
            if (m) payoutNum = parseInt(m[1], 10);
          }
          if (!payoutNum) {
            const dealFormEl = document.querySelector('[class*="deal-form"], [class*="sidebar"]');
            if (dealFormEl && dealFormEl.textContent) {
              const m = dealFormEl.textContent.match(/(\d{1,3})%/);
              if (m) payoutNum = parseInt(m[1], 10);
            }
          }
          if (!payoutNum) {
            const pEl = first([
              '[class*="payout-percent"]',
              '[class*="profit-percent"]',
              '[class*="deal-form__payout"]',
              '.payout-value',
            ]);
            if (pEl && pEl.textContent) {
              const m = pEl.textContent.match(/(\d{1,3})/);
              if (m) payoutNum = parseInt(m[1], 10);
            }
          }

          // Candle timeframe from left toolbar / chart header (e.g. 5m, 1m, 30s, 10s, 1h)
          let chartTfSec = 300;
          const tfButtons = Array.from(document.querySelectorAll('button, [class*="timeframe"], .chart-sidebar button, .chart-top-panel button'));
          for (const btn of tfButtons) {
            const t = (btn.textContent || '').trim().toLowerCase();
            const match = t.match(/^(5s|10s|15s|30s|1m|2m|5m|10m|15m|30m|1h|4h|1d)$/);
            if (match) {
              const isSelected = btn.classList.contains('active') || btn.classList.contains('selected') || btn.getAttribute('aria-selected') === 'true';
              if (isSelected) {
                const val = parseInt(match[1].slice(0, -1), 10);
                const unit = match[1].slice(-1);
                chartTfSec = unit === 's' ? val : unit === 'm' ? val * 60 : unit === 'h' ? val * 3600 : val * 86400;
                break;
              }
            }
          }

          // Trade expiry duration from deal form (e.g. "00:01:00" -> 60s)
          let expirySec = 60;
          const timeInputs = Array.from(document.querySelectorAll('[class*="deal-form"] input, [class*="deal-form"] [class*="time"]'));
          for (const el of timeInputs) {
            const val = (el as HTMLInputElement).value || el.textContent || '';
            const match = val.match(/(\d{2}):(\d{2}):(\d{2})/);
            if (match) {
              const hrs = parseInt(match[1], 10);
              const mins = parseInt(match[2], 10);
              const secs = parseInt(match[3], 10);
              const total = hrs * 3600 + mins * 60 + secs;
              if (total > 0) {
                expirySec = total;
                break;
              }
            }
          }

          // Account label & exact balance from header
          const labelTexts = Array.from(document.querySelectorAll('[class*="account"], [class*="balance"], header'))
            .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t.length > 0 && t.length < 100);
          const joined = labelTexts.join(' | ');
          const sawDemo = /demo|practice/i.test(joined);
          const sawLive = /live account|real account|\blive\b/i.test(joined);

          let balanceMatch: string | null = null;
          const headerEl = document.querySelector('header, [class*="header"], [class*="usermenu"]');
          if (headerEl) {
            const hText = headerEl.textContent || '';
            const m = hText.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
            if (m) balanceMatch = m[1];
          }
          if (!balanceMatch) {
            const balanceEl = first(['[class*="balance"] [class*="value"]', '[class*="balance__value"]', '[class*="balance"]']);
            const m = (text(balanceEl) || '').match(/([\d.,]+)/);
            if (m) balanceMatch = m[1];
          }

          return {
            url: window.location.href,
            symbol: text(symbolEl),
            price: text(priceEl),
            payout: payoutNum,
            chartTfSec,
            expirySec,
            balance: balanceMatch,
            labelMode: sawDemo && !sawLive ? 'DEMO' : sawLive && !sawDemo ? 'LIVE' : 'UNKNOWN',
          };
        });

        // ── Account & Balance ──
        this.setUrlMode(accountModeFromUrl(dom.url));
        this.tracker.update('screen label', dom.labelMode as AccountMode);
        this.refreshAccountMode();

        if (dom.balance) {
          const balNum = parseFloat(dom.balance.replace(/,/g, ''));
          if (!isNaN(balNum)) {
            if (this.accountMode === 'LIVE') this.liveBalanceValue = balNum;
            else if (this.accountMode === 'DEMO') this.demoBalanceValue = balNum;
            this.updateBalance(balNum, 'USD');
          }
        }

        // ── Timeframe & Expiry ──
        if (dom.chartTfSec && dom.chartTfSec !== this.activeTimeframe) {
          const prevTf = this.activeTimeframe;
          this.activeTimeframe = dom.chartTfSec;
          this.emit('timeframeChanged', { timeframe: this.activeTimeframe, previous: prevTf });
        }
        if (dom.expirySec) {
          this.activeExpiry = dom.expirySec;
        }

        // ── Market on chart ──
        const resolved = dom.symbol ? this.registry.resolve(dom.symbol) : '';
        const priceNum = dom.price ? parseFloat(dom.price.replace(/[^0-9.]/g, '')) : NaN;

        let screenAsset = '';
        if (resolved && (this.registry.isKnown(resolved) || this.latestTicks.has(resolved))) {
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
              name: dom.symbol || clean,
              payoutPercent: dom.payout,
              isOtc: clean.endsWith('_OTC'),
              isActive: true,
            });
            this.emit('payouts', Array.from(this.assetPayouts.values()));
          }
        }

        // Fall back to screen-scraped prices if stream goes quiet
        if (screenAsset && !isNaN(priceNum) && priceNum > 0) {
          const lastWs = this.lastTickAt.get(screenAsset) ?? 0;
          if (Date.now() - lastWs > 4000) {
            const tick: Tick = { asset: screenAsset, time: Date.now(), price: priceNum };
            this.recordTick(tick);
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
}
