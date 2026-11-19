import { EventEmitter } from 'events';
import { Page, CDPSession, WebSocket as PlaywrightWebSocket } from 'playwright';
import { QxWsParser, ParsedWsMessage } from './wsParser.js';
import { Tick, AssetPayout, AccountBalance, TradeDeal } from './types.js';

export interface QxWsSnifferEvents {
  tick: (tick: Tick) => void;
  payouts: (payouts: AssetPayout[]) => void;
  balance: (balance: AccountBalance) => void;
  deal: (deal: TradeDeal) => void;
  raw: (msg: ParsedWsMessage) => void;
}

export class QxWsSniffer extends EventEmitter {
  private parser: QxWsParser;
  private activeSockets: Set<PlaywrightWebSocket> = new Set();
  private cdpSession: CDPSession | null = null;
  private latestTicks: Map<string, Tick> = new Map();
  private assetPayouts: Map<string, AssetPayout> = new Map();
  private currentBalance: AccountBalance | null = null;
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

      this.cdpSession.on('Network.webSocketCreated', (event: any) => {
        console.log(`[CDP] WebSocket connection established: ${event.url}`);
      });

      console.log('[WsSniffer] CDP network stream listener successfully active.');
    } catch (err) {
      console.warn('[WsSniffer Warning] CDP session notice:', (err as Error).message);
    }

    // Layer 3: Passive DOM Poller Fallback
    // Polls price, payout, and symbol directly from the Quotex UI DOM every 1.5s.
    // Uses selectors observed on quotex.com/en/trade UI (updated Nov 2026).
    setInterval(async () => {
      try {
        if (page.isClosed()) return;
        const domData = await page.evaluate(() => {
          // ── Symbol / Asset name ──────────────────────────────────────────
          const symbolEl =
            document.querySelector('.current-symbol__name') ||               // primary
            document.querySelector('[class*="current-symbol"]') ||
            document.querySelector('[class*="symbol-name"]') ||
            document.querySelector('[class*="asset-name"]') ||
            document.querySelector('.tab-item--active .tab-item__name') ||
            document.querySelector('[class*="pair-name"]') ||
            document.querySelector('.chart-top-panel__asset-name') ||
            document.querySelector('[data-id="asset-name"]');

          // ── Current price ─────────────────────────────────────────────────
          const priceEl =
            document.querySelector('.current-price') ||
            document.querySelector('[class*="current-price"]') ||
            document.querySelector('[class*="chart-quote"]') ||
            document.querySelector('[class*="quote__value"]') ||
            document.querySelector('[class*="rate"]') ||
            document.querySelector('.price-value');

          // ── Payout % ──────────────────────────────────────────────────────
          const payoutEl =
            document.querySelector('[class*="payout-percent"]') ||
            document.querySelector('[class*="profit-percent"]') ||
            document.querySelector('[class*="deal-form__payout"]') ||
            document.querySelector('[class*="income"]') ||
            document.querySelector('.payout-value');

          // ── Account balance & mode ─────────────────────────────────────────
          const bodyText = document.body.innerText;
          const isDemo = bodyText.includes('DEMO ACCOUNT') || bodyText.includes('Demo') || window.location.href.includes('demo');
          const balanceMatch = bodyText.match(/\$([\d,]+(?:\.\d{2})?)/);
          const balanceStr = balanceMatch ? balanceMatch[1].replace(/,/g, '') : null;

          return {
            symbol: symbolEl?.textContent?.trim().replace(/\s+/g, '').replace(/\//g, '') || null,
            price: priceEl?.textContent?.trim().replace(/[^0-9.]/g, '') || null,
            payout: payoutEl?.textContent?.trim().replace(/[^0-9]/g, '') || null,
            balance: balanceStr ? parseFloat(balanceStr) : null,
            isDemo,
          };
        });

        // Update balance if detected from DOM
        if (domData.balance !== null && !isNaN(domData.balance) && !this.currentBalance) {
          const bal: AccountBalance = {
            balance: domData.balance,
            currency: 'USD',
            isDemo: domData.isDemo,
          };
          this.currentBalance = bal;
          this.emit('balance', bal);
        }

        if (domData.symbol && domData.price) {
          const priceNum = parseFloat(domData.price);
          if (!isNaN(priceNum) && priceNum > 0) {
            const cleanAsset = domData.symbol.toUpperCase();
            const now = Date.now();
            const tick: Tick = { asset: cleanAsset, time: now, price: priceNum };
            this.latestTicks.set(cleanAsset, tick);
            this.totalTicksReceived++;
            this.emit('tick', tick);

            if (domData.payout) {
              const pNum = parseFloat(domData.payout);
              if (!isNaN(pNum)) {
                const isOtc = cleanAsset.includes('OTC');
                const assetPayout: AssetPayout = {
                  asset: cleanAsset,
                  name: cleanAsset,
                  payoutPercent: pNum,
                  isOtc,
                  isActive: true,
                };
                this.assetPayouts.set(cleanAsset, assetPayout);
              }
            }
          }
        }
      } catch {
        // Page navigation or closed cleanly
      }
    }, 1500);
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
      this.totalTicksReceived++;
      this.latestTicks.set(tick.asset, tick);
      this.emit('tick', tick);
    }

    // Check for Historical Ticks/Candles
    const historyData = this.parser.extractHistory(eventName, data);
    if (historyData) {
      this.emit('history', historyData);
    }

    // Check for Payouts
    const payouts = this.parser.extractPayouts(eventName, data);
    if (payouts.length > 0) {
      for (const p of payouts) {
        this.assetPayouts.set(p.asset, p);
      }
      this.emit('payouts', payouts);
    }

    // Check for Balance
    const balance = this.parser.extractBalance(eventName, data);
    if (balance) {
      this.currentBalance = balance;
      this.emit('balance', balance);
    }

    // Check for Deal
    const deal = this.parser.extractDeal(eventName, data);
    if (deal) {
      this.emit('deal', deal);
    }
  }

  public getLatestTick(asset: string): Tick | undefined {
    return this.latestTicks.get(asset.toUpperCase());
  }

  public getPayout(asset: string): AssetPayout | undefined {
    return this.assetPayouts.get(asset.toUpperCase());
  }

  public getAllPayouts(): AssetPayout[] {
    return Array.from(this.assetPayouts.values());
  }

  public getBalance(): AccountBalance | null {
    return this.currentBalance;
  }
}
