import { Page } from 'playwright';
import { normalizeAsset } from '../stream/assets.js';
import {
  REDUX_STORE_HELPER_JS,
  PERIOD_CODE_MAP_JS,
  verifyPlatformHealth,
  PlatformHealthReport,
} from './reduxBridge.js';
import { showInBrowserSignalAlert, BrowserSignalAlertPayload } from './signalHud.js';

export interface OpenMarketTab {
  rawSymbol: string;
  normAsset: string;
  label: string;
  payout: number;
  isActive: boolean;
}

export interface VerifiedMarketSnapshot {
  rawSymbol: string;
  normAsset: string;
  label: string;
  price: number;
  payout: number;
  /** True chart CANDLE timeframe in seconds (from .NDbAT / graph.chartPeriod, NEVER graph.timePeriod!). */
  timeframeSeconds: number;
  /** Current deal panel EXPIRY duration in seconds (graph.timePeriod). */
  expirySeconds: number;
  firstPointValue: number;
  hasOpenDealOnSymbol: boolean;
  totalOpenDealsCount: number;
  historyPoints: Array<{ value: number; time: number }>;
}

const SECONDS_TO_TF_LABEL: Record<number, string> = {
  5: '5s',
  10: '10s',
  15: '15s',
  30: '30s',
  60: '1m',
  120: '2m',
  300: '5m',
  600: '10m',
  900: '15m',
  1800: '30m',
  3600: '1h',
  14400: '4h',
  86400: '1d',
};

const SECONDS_TO_EXPIRY_PRESET: Record<number, string> = {
  5: '00:05',
  10: '00:10',
  15: '00:15',
  30: '00:30',
  60: '01:00',
  120: '02:00',
  300: '05:00',
  600: '10:00',
  900: '15:00',
  1800: '30:00',
  3600: '01:00:00',
  7200: '02:00:00',
  14400: '04:00:00',
};

export class QuotexController {
  private isBusy: boolean = false;
  private lastAppliedIndicatorSig: string = '';

  constructor(private page: Page) {}

  private async safeEvaluate<T>(script: string, fallback: T, timeoutMs: number = 3500): Promise<T> {
    if (this.page.isClosed()) return fallback;
    try {
      return await Promise.race([
        this.page.evaluate(script) as Promise<T>,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
      ]);
    } catch {
      return fallback;
    }
  }

  public static formatTimeframe(seconds: number): string {
    if (SECONDS_TO_TF_LABEL[seconds]) return SECONDS_TO_TF_LABEL[seconds];
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return '1d';
  }

  public static formatExpiry(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
  }

  public async checkPlatformHealth(): Promise<PlatformHealthReport> {
    return verifyPlatformHealth(this.page);
  }

  /**
   * Ensures core built-in Quotex indicators (Moving Average, Bollinger Bands, RSI, Stochastic Oscillator)
   * are enabled cleanly with zero duplicates on the live Quotex chart.
   */
  public async ensureProIndicatorsOnChart(): Promise<string[]> {
    if (this.isBusy || this.page.isClosed()) return [];
    this.isBusy = true;
    try {
      await this.safeEvaluate(`(() => {
        const seen = new Set();
        for (const p of Array.from(document.querySelectorAll('.kKfA7'))) {
          const t = (p.textContent || '').trim();
          const key = t.includes('Stochastic') ? 'so' : t.includes('RSI') ? 'rsi' : '';
          if (key) {
            if (seen.has(key)) {
              const closeBtn = p.querySelector('.eLd0K');
              if (closeBtn) closeBtn.click();
            } else {
              seen.add(key);
            }
          }
        }
      })()`, undefined);

      const existingTypes = await this.safeEvaluate<string[]>(`(() => {
        ${REDUX_STORE_HELPER_JS}
        const byId = getReduxState()?.indicators?.byId || {};
        return Object.values(byId).map((ind) => String(ind?.type || '').toLowerCase());
      })()`, []);

      const targets: Array<{ menuText: string; matchRegex: RegExp }> = [
        { menuText: 'Moving Average', matchRegex: /^ma$|moving/i },
        { menuText: 'Bollinger Bands', matchRegex: /^bb$|bollinger/i },
        { menuText: 'RSI', matchRegex: /^rsi$/i },
        { menuText: 'Stochastic Oscillator', matchRegex: /^so$|stoch/i },
      ];

      for (const target of targets) {
        if (existingTypes.some((t) => target.matchRegex.test(t))) continue;

        const menuItems = this.page.locator('li.yEJt5');
        if ((await menuItems.count()) === 0) {
          const rulerBtn = this.page.locator('.NDbAT > div').nth(4);
          if ((await rulerBtn.count()) > 0) {
            await rulerBtn.click({ timeout: 2000 }).catch(() => {});
            await this.page.waitForTimeout(350);
          }
        }

        const menuItem = this.page.locator('li.yEJt5').filter({ hasText: new RegExp(`^${target.menuText}$`, 'i') });
        if ((await menuItem.count()) > 0) {
          await menuItem.first().click({ timeout: 2000 }).catch(() => {});
          await this.page.waitForTimeout(450);
          const closeBtn = this.page.locator('button.WEqlX').last();
          if ((await closeBtn.count()) > 0) {
            await closeBtn.click({ timeout: 800 }).catch(() => {});
          } else {
            await this.page.keyboard.press('Escape').catch(() => {});
          }
          await this.page.waitForTimeout(300);
        }
      }

      return await this.safeEvaluate<string[]>(`(() => {
        ${REDUX_STORE_HELPER_JS}
        const byId = getReduxState()?.indicators?.byId || {};
        return Object.values(byId).map((ind) => {
          const p = ind?.settings?.period ? '(' + ind.settings.period + (ind.settings.deviation ? ',' + ind.settings.deviation : '') + ')' : '';
          return String(ind?.type || 'indicator').toUpperCase() + p;
        });
      })()`, []);
    } catch {
      return [];
    } finally {
      this.isBusy = false;
    }
  }

  public async configureOnScreenIndicators(profile: {
    name: string;
    emaFast: number;
    bbPeriod: number;
    bbDev: number;
    rsiPeriod: number;
  }): Promise<boolean> {
    if (this.isBusy || this.page.isClosed()) return false;
    const sig = `${profile.emaFast}_${profile.bbPeriod}_${profile.bbDev}_${profile.rsiPeriod}`;
    if (sig === this.lastAppliedIndicatorSig) return true;

    this.isBusy = true;
    try {
      const editIndicator = async (nameSubstr: string, isSubPanel: boolean, fields: Record<string, string>) => {
        const opened = await this.safeEvaluate<boolean>(`((targetName, sub) => {
          const rows = Array.from(document.querySelectorAll(sub ? 'div.kKfA7' : 'div.FU1Jc'));
          const row = rows.find((r) => (r.textContent || '').includes(targetName));
          if (!row) return false;
          const pencil = row.querySelector(sub ? 'button.PBFlt.TKFkI' : 'button.FwNY9.qlMiF');
          if (pencil) { pencil.click(); return true; }
          return false;
        })(${JSON.stringify(nameSubstr)}, ${isSubPanel})`, false);
        if (!opened) return;
        await this.page.waitForTimeout(320);

        await this.safeEvaluate(`((fieldMap) => {
          const inputs = Array.from(document.querySelectorAll('input.bi82M'));
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          for (const inp of inputs) {
            const lbl = (inp.parentElement?.parentElement?.innerText || '').trim().toLowerCase();
            for (const [keyWord, newVal] of Object.entries(fieldMap)) {
              if (lbl.includes(keyWord) && !lbl.includes('%k') && !lbl.includes('%d')) {
                inp.focus();
                if (setter) setter.call(inp, String(newVal));
                else inp.value = String(newVal);
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                inp.blur();
                break;
              }
            }
          }
        })(${JSON.stringify(fields)})`, undefined);
        await this.page.waitForTimeout(220);

        await this.safeEvaluate(`(() => {
          const btns = Array.from(document.querySelectorAll('button.WEqlX'));
          if (btns.length > 0) btns[btns.length - 1].click();
        })()`, undefined);
        await this.page.waitForTimeout(180);
      };

      await editIndicator('Moving Average', false, { period: String(profile.emaFast) });
      await editIndicator('Bollinger Bands', false, {
        period: String(profile.bbPeriod),
        deviation: String(profile.bbDev),
      });
      await editIndicator('RSI', true, { period: String(profile.rsiPeriod) });

      this.lastAppliedIndicatorSig = sig;
      return true;
    } catch {
      return false;
    } finally {
      this.isBusy = false;
    }
  }

  /**
   * Synchronizes the Deal Panel's Expiry timer (`graph.timePeriod`) to `expirySeconds`
   * and verifies that Quotex's Redux store actually updated `timePeriod`.
   */
  public async syncExpiryToTimeframe(expirySeconds: number): Promise<boolean> {
    if (this.isBusy || this.page.isClosed()) return false;
    const presetText = SECONDS_TO_EXPIRY_PRESET[expirySeconds];
    if (!presetText) return false;

    this.isBusy = true;
    try {
      const readStoreExpiry = async (): Promise<number> => {
        return await this.safeEvaluate<number>(`(() => {
          ${REDUX_STORE_HELPER_JS}
          const g = getActiveGraph(getReduxState());
          if (typeof g?.timePeriod === 'number' && g.timePeriod > 0) return g.timePeriod;
          const inputs = Array.from(document.querySelectorAll('input.input-control__input'));
          for (const el of inputs) {
            const m = (el.value || '').trim().match(/^(\\d{2}):(\\d{2}):(\\d{2})$/);
            if (m) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
          }
          return 0;
        })()`, 0);
      };

      if ((await readStoreExpiry()) === expirySeconds) {
        return true;
      }

      // Ensure timer mode is selected and open the expiry dropdown if presets are collapsed
      const switched = await this.safeEvaluate<boolean>(`((targetText) => {
        const timerBtns = Array.from(document.querySelectorAll('button.n6Y_k'));
        const timerBtn = timerBtns.find((b) => (b.textContent || '').trim().toLowerCase() === 'timer');
        if (timerBtn && !timerBtn.classList.contains('K8TIp')) {
          timerBtn.click();
        }
        const findPreset = () =>
          Array.from(document.querySelectorAll('div.VPv5q')).find((el) => (el.textContent || '').trim() === targetText);

        let match = findPreset();
        if (match) {
          const rect = match.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            const timeInput = Array.from(document.querySelectorAll('input.input-control__input')).find((el) =>
              /^\\d{2}:\\d{2}:\\d{2}$/.test((el.value || '').trim())
            );
            if (timeInput) {
              timeInput.click();
              timeInput.focus();
            }
          }
          match = findPreset();
          if (match) {
            match.click();
            return true;
          }
        }
        return false;
      })(${JSON.stringify(presetText)})`, false);

      if (switched) {
        await this.page.waitForTimeout(250);
        // Close dropdown cleanly if still open
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(100);
        const verified = (await readStoreExpiry()) === expirySeconds;
        return verified;
      }
      return false;
    } catch {
      return false;
    } finally {
      this.isBusy = false;
    }
  }

  public async triggerInBrowserSignalAlert(signal: BrowserSignalAlertPayload): Promise<void> {
    await showInBrowserSignalAlert(this.page, signal);
  }

  public async getOpenMarketTabs(): Promise<OpenMarketTab[]> {
    if (this.page.isClosed()) return [];
    const rawTabs = await this.safeEvaluate<
      Array<{ rawSymbol: string; label: string; payout: number; isActive: boolean }>
    >(`(() => {
      return Array.from(document.querySelectorAll('[data-symbol]')).map((el) => {
        const rawSymbol = el.getAttribute('data-symbol') || '';
        const nameEl = el.querySelector('.WRocw');
        const pctEl = el.querySelector('.ElyTP');
        const rawText = (el.textContent || '').trim();
        const label = nameEl ? (nameEl.textContent || '').trim() : rawText.replace(/\\d+%/g, '').trim();
        const pctMatch = (pctEl ? pctEl.textContent || '' : rawText).match(/(\\d+)%/);
        const payout = pctMatch ? parseInt(pctMatch[1], 10) : 80;
        const isActive = el.id === 'tab-active';
        return { rawSymbol, label, payout, isActive };
      }).filter((t) => t.rawSymbol);
    })()`, []);

    return rawTabs.map((t) => ({
      ...t,
      normAsset: normalizeAsset(t.rawSymbol),
    }));
  }

  /**
   * Switches the active Quotex Chrome window between DEMO and LIVE accounts.
   * Uses URL path + Redux balance checks (not the absent global.activeAccount field).
   */
  public async switchAccountMode(targetMode: 'DEMO' | 'LIVE'): Promise<boolean> {
    if (this.page.isClosed()) return false;
    try {
      const checkMode = async (): Promise<'DEMO' | 'LIVE' | 'UNKNOWN'> => {
        const res = await this.safeEvaluate<boolean | null>(`(() => {
          ${REDUX_STORE_HELPER_JS}
          ${PERIOD_CODE_MAP_JS}
          return resolveAccountIsDemo(getReduxState());
        })()`, null);
        return res === true ? 'DEMO' : res === false ? 'LIVE' : 'UNKNOWN';
      };

      if ((await checkMode()) === targetMode) return true;

      await this.safeEvaluate(`(() => {
        const trigger = document.querySelector('qx-usermenu-trigger');
        if (trigger) trigger.click();
      })()`, undefined);
      await this.page.waitForTimeout(450);

      const clicked = await this.safeEvaluate<boolean>(`((wantLive) => {
        const links = Array.from(document.querySelectorAll('a[href*="trade"]'));
        const match = links.find((a) => {
          const href = (a.getAttribute('href') || '').toLowerCase();
          const txt = (a.textContent || '').trim().toLowerCase();
          if (wantLive) {
            return (href.endsWith('/trade') && !href.includes('demo')) || txt === 'live account';
          }
          return href.includes('/demo-trade') || txt === 'demo account';
        });
        if (match) {
          match.click();
          return true;
        }
        return false;
      })(${targetMode === 'LIVE'})`, false);

      if (!clicked) {
        const curUrl = new URL(this.page.url());
        const langMatch = curUrl.pathname.match(/^\/([a-z]{2})\//i);
        const langPrefix = langMatch ? `/${langMatch[1]}` : '/en';
        const targetUrl = `${curUrl.origin}${langPrefix}/${targetMode === 'LIVE' ? 'trade' : 'demo-trade'}`;
        await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      }

      for (let i = 0; i < 15; i++) {
        await this.page.waitForTimeout(400);
        if ((await checkMode()) === targetMode) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public async closeMarketTab(rawSymbol: string): Promise<boolean> {
    if (this.page.isClosed()) return false;
    try {
      const tabs = await this.getOpenMarketTabs();
      if (tabs.length <= 1) return false;

      const closed = await this.safeEvaluate<boolean>(`((sym) => {
        const tab = document.querySelector('[data-symbol="' + sym + '"]');
        if (!tab) return false;
        const closeBtn = tab.querySelector('.LtauB');
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
        return false;
      })(${JSON.stringify(rawSymbol)})`, false);

      if (closed) {
        await this.page.waitForTimeout(450 + Math.floor(Math.random() * 250));
      }
      return closed;
    } catch {
      return false;
    }
  }

  /**
   * Opens multiple high-payout markets into the Quotex top tab bar.
   * Reads Redux `assets.assetBySymbol` so payout filtering uses the ACTUAL payout for the active
   * timeframe (`payout_5` for >= 5m, `payout_1` for < 5m) and respects `allowOtc`.
   */
  public async ensureMultiMarketTabsOpen(
    targetCount: number = 4,
    minPayout: number = 84,
    excludedNormAssets?: Set<string>,
    options?: { allowOtc?: boolean; activeTimeframeSeconds?: number }
  ): Promise<OpenMarketTab[]> {
    if (this.page.isClosed()) return [];
    const allowOtc = options?.allowOtc ?? true;
    const tfSec = options?.activeTimeframeSeconds ?? 300;

    this.isBusy = true;
    try {
      let currentTabs = await this.getOpenMarketTabs();
      const validOpenCount = currentTabs.filter(
        (t) => t.payout >= minPayout && (allowOtc || !t.normAsset.endsWith('_OTC'))
      ).length;
      if (validOpenCount >= targetCount) {
        return currentTabs;
      }

      // Query Redux directly for accurate timeframe-specific payouts & OTC flags
      const storeCandidates = await this.safeEvaluate<
        Array<{ symbol: string; label: string; payout: number; isOtc: boolean }>
      >(`((minPct, use5m, allowOtcFlag) => {
        ${REDUX_STORE_HELPER_JS}
        const bySym = getReduxState()?.assets?.assetBySymbol || {};
        const out = [];
        for (const a of Object.values(bySym)) {
          if (!a || !a.active || !a.label) continue;
          const isOtc = Boolean(a.is_otc) || String(a.symbol || '').toLowerCase().includes('otc');
          if (!allowOtcFlag && isOtc) continue;
          const tfPayout = use5m
            ? (typeof a.payout_5 === 'number' && a.payout_5 > 0 ? a.payout_5 : a.payout)
            : (typeof a.payout_1 === 'number' && a.payout_1 > 0 ? a.payout_1 : a.payout);
          if (typeof tfPayout === 'number' && tfPayout >= minPct) {
            out.push({ symbol: a.symbol, label: a.label, payout: tfPayout, isOtc });
          }
        }
        return out.sort((x, y) => y.payout - x.payout);
      })(${minPayout}, ${tfSec >= 300}, ${allowOtc})`, []);

      if (storeCandidates.length === 0) {
        return currentTabs;
      }

      await this.safeEvaluate(`(() => {
        const plusBtn = document.querySelector('button.CAZSg');
        if (plusBtn) plusBtn.click();
      })()`, undefined);
      await this.page.waitForTimeout(550);

      for (const cand of storeCandidates) {
        currentTabs = await this.getOpenMarketTabs();
        const openValid = currentTabs.filter(
          (t) => t.payout >= minPayout && (allowOtc || !t.normAsset.endsWith('_OTC'))
        ).length;
        if (openValid >= targetCount || currentTabs.length >= targetCount + 2) break;
        const norm = normalizeAsset(cand.symbol);
        if (currentTabs.some((t) => t.normAsset === norm || t.label === cand.label)) continue;
        if (excludedNormAssets && excludedNormAssets.has(norm)) continue;

        const modalOpen = await this.safeEvaluate<boolean>(
          `(() => document.querySelectorAll('.vPvlJ').length > 0)()`,
          false
        );
        if (!modalOpen) {
          await this.safeEvaluate(`(() => {
            const plusBtn = document.querySelector('button.CAZSg');
            if (plusBtn) plusBtn.click();
          })()`, undefined);
          await this.page.waitForTimeout(480);
        }

        const clicked = await this.safeEvaluate<boolean>(`((targetLabel) => {
          const items = Array.from(document.querySelectorAll('.vPvlJ .Wztsn'));
          const match = items.find((el) => (el.textContent || '').trim() === targetLabel);
          if (match) {
            match.click();
            return true;
          }
          return false;
        })(${JSON.stringify(cand.label)})`, false);

        if (clicked) {
          await this.page.waitForTimeout(650 + Math.floor(Math.random() * 300));
        }
      }

      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(300);

      return await this.getOpenMarketTabs();
    } catch {
      return await this.getOpenMarketTabs();
    } finally {
      this.isBusy = false;
    }
  }

  /**
   * Switches to a specific open market tab ([data-symbol]) and performs strict
   * isolation verification on Redux before returning its historyPoints.
   *
   * CRITICAL FIX: returns the TRUE candle timeframe (`resolveCandleTimeframeSeconds(g)`),
   * never `g.timePeriod` (which is the expiry timer!).
   */
  public async switchToMarketTabAndVerify(
    targetRawSymbol: string,
    prevFirstPointValue: number = -1
  ): Promise<VerifiedMarketSnapshot | null> {
    if (this.page.isClosed()) return null;
    try {
      const didSwitch = await this.safeEvaluate<boolean>(`((sym) => {
        const tab = document.querySelector('[data-symbol="' + sym + '"]');
        if (tab && tab.id !== 'tab-active') {
          const clickTarget = tab.querySelector('.H4wMV') || tab;
          clickTarget.click();
          return true;
        }
        return false;
      })(${JSON.stringify(targetRawSymbol)})`, false);

      // Freshly opened tabs can take 2-4s for Quotex to stream historyPoints even if already #tab-active
      const maxAttempts = didSwitch ? 24 : 10;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (didSwitch || attempt > 0) {
          await this.page.waitForTimeout(200);
        }
        const snap = await this.safeEvaluate<any>(`((expectedSym, prevFirstVal, switched, att) => {
          try {
            ${REDUX_STORE_HELPER_JS}
            ${PERIOD_CODE_MAP_JS}
            const activeTab = document.querySelector('#tab-active');
            const domActiveSym = activeTab ? activeTab.getAttribute('data-symbol') : '';
            if (domActiveSym && domActiveSym !== expectedSym) {
              return { ready: false };
            }

            const st = getReduxState();
            const g = getActiveGraph(st);
            const curSym = g?.currentAsset?.symbol;
            const curPrice = g?.currentAsset?.price;
            const pts = Array.isArray(g?.historyPoints) ? g.historyPoints : [];

            if (curSym !== expectedSym || typeof curPrice !== 'number' || curPrice <= 0 || pts.length < 40) {
              return { ready: false };
            }

            const firstVal = pts[0]?.value;
            const lastVal = pts[pts.length - 1]?.value;
            if (typeof firstVal !== 'number' || typeof lastVal !== 'number') {
              return { ready: false };
            }

            const relDiff = Math.abs(lastVal - curPrice) / Math.max(1e-9, curPrice);
            if (relDiff >= 0.018) {
              return { ready: false };
            }

            if (switched && prevFirstVal > 0 && Math.abs(firstVal - prevFirstVal) < 1e-12 && att < 4) {
              return { ready: false };
            }

            const candleTfSec = resolveCandleTimeframeSeconds(g);
            const expirySec = typeof g?.timePeriod === 'number' && g.timePeriod > 0 ? g.timePeriod : candleTfSec;

            const pctText = (activeTab?.querySelector('.ElyTP')?.textContent || document.querySelector('.OmOPV .eB25d')?.textContent || '');
            const pctMatch = pctText.match(/(\\d+)%/);
            const domPayout = pctMatch ? parseInt(pctMatch[1], 10) : 0;
            const obj = g?.currentAsset?.obj || {};
            const storePayout = expirySec >= 300 && obj.payout_5 ? obj.payout_5 : (obj.payout_1 || obj.payout || 80);

            const openDeals = Object.values(st?.deals?.openedById || {});
            const hasOpenDealOnSymbol = openDeals.some((d) => d && String(d.asset || '').toLowerCase() === String(curSym).toLowerCase());

            return {
              ready: true,
              rawSymbol: curSym,
              label: obj.label || curSym,
              price: curPrice,
              payout: domPayout > 0 ? domPayout : storePayout,
              timeframeSeconds: candleTfSec,
              expirySeconds: expirySec,
              firstPointValue: firstVal,
              hasOpenDealOnSymbol,
              totalOpenDealsCount: openDeals.length,
              historyPoints: pts
            };
          } catch (e) {
            return { ready: false };
          }
        })(${JSON.stringify(targetRawSymbol)}, ${prevFirstPointValue}, ${didSwitch}, ${attempt})`, null, 3000);

        if (snap && snap.ready) {
          return {
            rawSymbol: snap.rawSymbol,
            normAsset: normalizeAsset(snap.rawSymbol),
            label: snap.label,
            price: snap.price,
            payout: snap.payout,
            timeframeSeconds: snap.timeframeSeconds,
            expirySeconds: snap.expirySeconds,
            firstPointValue: snap.firstPointValue,
            hasOpenDealOnSymbol: Boolean(snap.hasOpenDealOnSymbol),
            totalOpenDealsCount: Number(snap.totalOpenDealsCount || 0),
            historyPoints: snap.historyPoints,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Sets the Deal Panel's Investment ($) stake input box AND verifies in Quotex's
   * Redux store (`graph.dealValue`) that the exact stake was accepted!
   */
  public async setInvestmentStake(stakeAmount: number): Promise<boolean> {
    if (this.page.isClosed() || stakeAmount <= 0) return false;
    const cleanStake = Math.max(1, Math.round(stakeAmount * 100) / 100);

    const readStoreStake = async (): Promise<number | null> => {
      return await this.safeEvaluate<number | null>(`(() => {
        ${REDUX_STORE_HELPER_JS}
        const dv = getActiveGraph(getReduxState())?.dealValue;
        return typeof dv === 'number' ? dv : null;
      })()`, null);
    };

    try {
      const existing = await readStoreStake();
      if (existing !== null && Math.abs(existing - cleanStake) < 0.01) {
        return true;
      }

      // Attempt 1: Native React input setter
      await this.safeEvaluate<boolean>(`((targetStake) => {
        const inputs = Array.from(document.querySelectorAll('input.input-control__input'));
        const invInput = inputs.find((el) => {
          const val = (el.value || '').trim();
          return !val.includes(':') && /[0-9]/.test(val);
        });
        if (!invInput) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        invInput.focus();
        if (setter) setter.call(invInput, String(targetStake));
        else invInput.value = String(targetStake);
        invInput.dispatchEvent(new Event('input', { bubbles: true }));
        invInput.dispatchEvent(new Event('change', { bubbles: true }));
        invInput.blur();
        return true;
      })(${cleanStake})`, false);

      await this.page.waitForTimeout(180);
      const afterSetter = await readStoreStake();
      if (afterSetter !== null && Math.abs(afterSetter - cleanStake) < 0.01) {
        return true;
      }

      // Attempt 2: Genuine Playwright focus + Ctrl+A + keyboard typing (handles masked "$ " inputs)
      const stakeIdx = await this.safeEvaluate<number>(`(() => {
        const inputs = Array.from(document.querySelectorAll('input.input-control__input'));
        return inputs.findIndex((el) => {
          const val = (el.value || '').trim();
          return !val.includes(':') && /[0-9]/.test(val);
        });
      })()`, -1);

      if (stakeIdx >= 0) {
        const loc = this.page.locator('input.input-control__input').nth(stakeIdx);
        await loc.click({ timeout: 2000 });
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.press('Backspace');
        await this.page.keyboard.type(String(cleanStake), { delay: 25 });
        await this.page.keyboard.press('Enter');
        await this.page.waitForTimeout(220);

        const afterType = await readStoreStake();
        return afterType !== null && Math.abs(afterType - cleanStake) < 0.01;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Executes a live CALL (Buy / Up) or PUT (Sell / Down) trade on the active Quotex chart
   * with strict health check, Redux-verified stake & expiry sync, symbol check, and deal confirmation.
   */
  public async executeTradeOnScreen(params: {
    expectedRawSymbol: string;
    direction: 'CALL' | 'PUT';
    stakeAmount: number;
    timeframeSeconds: number;
  }): Promise<{ executed: boolean; dealId?: string; entryPrice?: number; reason?: string }> {
    if (this.page.isClosed()) {
      return { executed: false, reason: 'Browser page is closed' };
    }

    try {
      const health = await this.checkPlatformHealth();
      if (!health.healthy) {
        return { executed: false, reason: `Platform health check failed: ${health.issues.join('; ')}` };
      }

      // 1. Sync expiry timer & verify investment stake in Redux
      const expiryOk = await this.syncExpiryToTimeframe(params.timeframeSeconds);
      if (!expiryOk) {
        return {
          executed: false,
          reason: `Could not verify expiry ${QuotexController.formatTimeframe(params.timeframeSeconds)} in Quotex Redux store`,
        };
      }

      const stakeSet = await this.setInvestmentStake(params.stakeAmount);
      if (!stakeSet) {
        return {
          executed: false,
          reason: `Could not verify investment stake $${params.stakeAmount} in Quotex Redux store`,
        };
      }

      // 2. Strict pre-click symbol & button readiness verification
      const preCheck = await this.safeEvaluate<any>(`((expectedSym, dir) => {
        ${REDUX_STORE_HELPER_JS}
        const activeTab = document.querySelector('#tab-active');
        const domSym = activeTab ? activeTab.getAttribute('data-symbol') : '';
        const st = getReduxState();
        const g = getActiveGraph(st);
        const storeSym = g?.currentAsset?.symbol;
        const storePrice = g?.currentAsset?.price;
        const storeStake = g?.dealValue;
        const openDealIds = Object.keys(st?.deals?.openedById || {});

        const btnSelector =
          dir === 'CALL'
            ? '#trade-button-up, button.call-btn, [class*="button--up"], [class*="deal-button--up"]'
            : '#trade-button-down, button.put-btn, [class*="button--down"], [class*="deal-button--down"]';
        const btn = document.querySelector(btnSelector);
        const rect = btn ? btn.getBoundingClientRect() : null;

        return {
          symbolMatches: storeSym === expectedSym && (!domSym || domSym === expectedSym),
          storeSym,
          domSym,
          storePrice,
          storeStake,
          openDealIds,
          btnReady: !!btn && !btn.hasAttribute('disabled') && !!rect && rect.width > 10 && rect.height > 10,
          rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null
        };
      })(${JSON.stringify(params.expectedRawSymbol)}, ${JSON.stringify(params.direction)})`, null);

      if (!preCheck?.symbolMatches) {
        return {
          executed: false,
          reason: `Active chart symbol mismatch (expected ${params.expectedRawSymbol}, saw ${preCheck?.storeSym}/${preCheck?.domSym})`,
        };
      }
      if (typeof preCheck.storeStake === 'number' && Math.abs(preCheck.storeStake - params.stakeAmount) > 0.05) {
        return {
          executed: false,
          reason: `Stake mismatch before click (expected $${params.stakeAmount}, store has $${preCheck.storeStake})`,
        };
      }
      if (!preCheck?.btnReady || !preCheck?.rect) {
        return { executed: false, reason: `Trade button (${params.direction}) not ready on screen` };
      }

      const prevDealIds = new Set<string>(preCheck.openDealIds || []);

      // 3. Humanized pause & click inside the Buy/Sell button
      await this.page.waitForTimeout(120 + Math.floor(Math.random() * 160));
      const clickX = preCheck.rect.x + preCheck.rect.w * (0.3 + Math.random() * 0.4);
      const clickY = preCheck.rect.y + preCheck.rect.h * (0.3 + Math.random() * 0.4);
      await this.page.mouse.move(clickX, clickY, { steps: 4 });
      await this.page.waitForTimeout(35 + Math.floor(Math.random() * 45));
      await this.page.mouse.click(clickX, clickY);

      // 4. Verify in Redux store (deals.openedById) that Quotex opened the deal
      for (let attempt = 0; attempt < 10; attempt++) {
        await this.page.waitForTimeout(200);
        const postCheck = await this.safeEvaluate<
          Array<{ id: string; asset: string; amount: number; openPrice: number; command: number }>
        >(
          `(() => {
            ${REDUX_STORE_HELPER_JS}
            const openedById = getReduxState()?.deals?.openedById || {};
            return Object.values(openedById).map((d) => ({
              id: String(d.id),
              asset: d.asset,
              amount: d.amount,
              openPrice: d.openPrice,
              command: d.command
            }));
          })()`,
          []
        );

        const newDeal = postCheck.find((d) => !prevDealIds.has(d.id));
        if (newDeal) {
          return {
            executed: true,
            dealId: newDeal.id,
            entryPrice: newDeal.openPrice || preCheck.storePrice,
          };
        }
      }

      return {
        executed: false,
        reason: 'Deal was not confirmed in Quotex Redux store (deals.openedById) after button click',
      };
    } catch (err) {
      return { executed: false, reason: (err as Error).message };
    }
  }
}
