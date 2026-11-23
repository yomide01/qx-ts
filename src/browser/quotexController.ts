import { Page } from 'playwright';
import { normalizeAsset } from '../stream/assets.js';

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
  timeframeSeconds: number;
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

/**
 * Provides human-like UI "Hands" on the live Quotex platform:
 * - Switching chart timeframes (5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h, 4h, 1d)
 * - Syncing the Deal Panel expiry timer to match the active chart timeframe
 * - Switching between open asset tabs
 * - Enabling and inspecting Quotex's built-in chart indicators (Moving Average, Bollinger Bands, RSI, Stochastic)
 */
export class QuotexController {
  private isBusy: boolean = false;
  private lastAppliedIndicatorSig: string = '';

  constructor(private page: Page) {}

  /**
   * Executes a browser script with a hard timeout so minimized/throttled Chrome
   * can NEVER hang or freeze the trading loop.
   */
  private async safeEvaluate<T>(script: string, fallback: T, timeoutMs: number = 3500): Promise<T> {
    if (this.page.isClosed()) return fallback;
    try {
      const res = await Promise.race([
        this.page.evaluate(script) as Promise<T>,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
      ]);
      return res;
    } catch {
      return fallback;
    }
  }

  /**
   * Formats timeframe seconds into a human-readable label (e.g. 60 -> "1m", 300 -> "5m", 10 -> "10s").
   */
  public static formatTimeframe(seconds: number): string {
    if (SECONDS_TO_TF_LABEL[seconds]) return SECONDS_TO_TF_LABEL[seconds];
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return '1d';
  }

  /**
   * Formats expiry seconds into "HH:MM:SS" or "MM:SS" label.
   */
  public static formatExpiry(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
  }

  /**
   * Ensures core built-in Quotex indicators (Moving Average, Bollinger Bands, RSI, Stochastic Oscillator)
   * are enabled cleanly with zero duplicates on the live Quotex chart.
   */
  public async ensureProIndicatorsOnChart(): Promise<string[]> {
    if (this.isBusy || this.page.isClosed()) return [];
    this.isBusy = true;
    try {
      // Remove any duplicate sub-panel oscillators (e.g. duplicate Stochastic or RSI)
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
        try {
          const chartContainer = document.querySelector('.chart-container');
          const key = chartContainer ? Object.keys(chartContainer).find((k) => k.startsWith('__reactFiber')) : null;
          let curr = chartContainer && key ? chartContainer[key] : null;
          while (curr) {
            if (curr.memoizedProps?.value?.store) {
              const byId = curr.memoizedProps.value.store.getState()?.indicators?.byId || {};
              return Object.values(byId).map((ind) => String(ind?.type || '').toLowerCase());
            }
            curr = curr.return;
          }
        } catch (e) {}
        return [];
      })()`, []);

      const targets: Array<{ menuText: string; matchRegex: RegExp }> = [
        { menuText: 'Moving Average', matchRegex: /^ma$|moving/i },
        { menuText: 'Bollinger Bands', matchRegex: /^bb$|bollinger/i },
        { menuText: 'RSI', matchRegex: /^rsi$/i },
        { menuText: 'Stochastic Oscillator', matchRegex: /^so$|stoch/i },
      ];

      for (const target of targets) {
        const alreadyPresent = existingTypes.some((t) => target.matchRegex.test(t));
        if (alreadyPresent) continue;

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

      const finalIndicators = await this.safeEvaluate<string[]>(`(() => {
        try {
          const chartContainer = document.querySelector('.chart-container');
          const key = chartContainer ? Object.keys(chartContainer).find((k) => k.startsWith('__reactFiber')) : null;
          let curr = chartContainer && key ? chartContainer[key] : null;
          while (curr) {
            if (curr.memoizedProps?.value?.store) {
              const byId = curr.memoizedProps.value.store.getState()?.indicators?.byId || {};
              return Object.values(byId).map((ind) => {
                const p = ind?.settings?.period ? '(' + ind.settings.period + (ind.settings.deviation ? ',' + ind.settings.deviation : '') + ')' : '';
                return String(ind?.type || 'indicator').toUpperCase() + p;
              });
            }
            curr = curr.return;
          }
        } catch (e) {}
        return [];
      })()`, []);

      return finalIndicators;
    } catch {
      return [];
    } finally {
      this.isBusy = false;
    }
  }

  /**
   * Dynamically edits Quotex's real on-screen chart indicators (Moving Average, Bollinger Bands, RSI)
   * to match the active market pair's calibrated parameter profile (FAST / STANDARD / SMOOTH).
   */
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

        // Close settings popover cleanly
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
   * Synchronizes the right-hand Deal Panel's Time (Expiry) input to match the active chart timeframe.
   * For example, when the chart is on 1m -> sets expiry to 01:00 (00:01:00);
   * when on 5m -> sets expiry to 05:00 (00:05:00); when on 10s -> sets expiry to 00:10 (00:00:10).
   */
  public async syncExpiryToTimeframe(timeframeSeconds: number): Promise<boolean> {
    if (this.isBusy || this.page.isClosed()) return false;
    const presetText = SECONDS_TO_EXPIRY_PRESET[timeframeSeconds];
    if (!presetText) return false;

    this.isBusy = true;
    try {
      // Check if current expiry already matches
      const currentExpirySec = (await this.page.evaluate(`(() => {
        const inputs = Array.from(document.querySelectorAll('input.input-control__input'));
        for (const el of inputs) {
          const val = (el.value || '').trim();
          const m = val.match(/^(\\d{2}):(\\d{2}):(\\d{2})$/);
          if (m) {
            return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
          }
        }
        return 0;
      })()`)) as number;

      if (currentExpirySec === timeframeSeconds) {
        return true;
      }

      // Click the Time input box or directly click the preset option in div.VPv5q
      const switched = (await this.page.evaluate(`((targetText) => {
        // Ensure timer mode is selected if available
        const timerBtns = Array.from(document.querySelectorAll('button.n6Y_k'));
        const timerBtn = timerBtns.find((b) => (b.textContent || '').trim().toLowerCase() === 'timer');
        if (timerBtn && !timerBtn.classList.contains('K8TIp')) {
          timerBtn.click();
        }
        const presets = Array.from(document.querySelectorAll('div.VPv5q'));
        const match = presets.find((el) => (el.textContent || '').trim() === targetText);
        if (match) {
          match.click();
          return true;
        }
        return false;
      })(${JSON.stringify(presetText)})`)) as boolean;

      if (switched) {
        await this.page.waitForTimeout(200);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      this.isBusy = false;
    }
  }

  /**
   * Plays an in-browser Web Audio API chime + Web Speech announcement and displays a Telegram-style
   * floating visual HUD alert banner right on the Quotex chart screen when a signal call is made.
   */
  public async triggerInBrowserSignalAlert(signal: {
    asset: string;
    displayPair?: string;
    direction: 'CALL' | 'PUT';
    timeframeSeconds: number;
    entryTimeStr?: string;
    expiryTimeStr?: string;
    confidence: number;
    payoutPercent: number;
    reasons: string[];
  }): Promise<void> {
    if (this.page.isClosed()) return;
    const tfLabel = QuotexController.formatTimeframe(signal.timeframeSeconds);
    const expiryClock = QuotexController.formatExpiry(signal.timeframeSeconds);
    const now = new Date();
    const entryClock =
      signal.entryTimeStr ||
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const expDate = new Date(now.getTime() + signal.timeframeSeconds * 1000);
    const toClock =
      signal.expiryTimeStr ||
      `${String(expDate.getHours()).padStart(2, '0')}:${String(expDate.getMinutes()).padStart(2, '0')}`;

    const payload = {
      asset: signal.displayPair || signal.asset,
      direction: signal.direction,
      tfLabel,
      expiryClock,
      entryClock,
      toClock,
      confidence: signal.confidence,
      payoutPercent: signal.payoutPercent,
      reasons: signal.reasons.slice(0, 4),
    };

    try {
      await this.page.evaluate(`((data) => {
        try {
          // 1. Play loud, unmistakable 3-tone Web Audio API chime inside Chrome using persistent unlocked AudioContext
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) {
            if (!window.__qxAudioCtx) {
              window.__qxAudioCtx = new AudioCtx();
            }
            const ctx = window.__qxAudioCtx;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            const playTone = (freq, startSec, durSec) => {
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.type = 'triangle';
              osc.frequency.setValueAtTime(freq, ctx.currentTime + startSec);
              gain.gain.setValueAtTime(0.65, ctx.currentTime + startSec);
              gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startSec + durSec);
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.start(ctx.currentTime + startSec);
              osc.stop(ctx.currentTime + startSec + durSec);
            };
            // Double chime sequence so it is impossible to miss
            if (data.direction === 'CALL') {
              playTone(659.25, 0.0, 0.16);
              playTone(880.0, 0.18, 0.16);
              playTone(1046.5, 0.36, 0.35);
              playTone(659.25, 0.85, 0.16);
              playTone(880.0, 1.03, 0.16);
              playTone(1046.5, 1.21, 0.40);
            } else {
              playTone(987.77, 0.0, 0.16);
              playTone(783.99, 0.18, 0.16);
              playTone(587.33, 0.36, 0.35);
              playTone(987.77, 0.85, 0.16);
              playTone(783.99, 1.03, 0.16);
              playTone(587.33, 1.21, 0.40);
            }
          }

          // 2. Spoken announcement via Web Speech API inside Chrome
          if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(
              'Signal Call: ' +
                data.asset.replace('_OTC', ' O T C').replace('(OTC)', 'O T C').replace('/', ' ') +
                ', ' +
                data.entryClock +
                ', ' +
                (data.direction === 'CALL' ? 'CALL UP' : 'PUT DOWN') +
                ', Time to ' +
                data.toClock
            );
            u.volume = 1.0;
            u.rate = 1.02;
            window.speechSynthesis.speak(u);
          }

          // 3. Browser Desktop Notification if permitted
          if ('Notification' in window) {
            if (Notification.permission === 'granted') {
              new Notification(data.asset + '; ' + data.entryClock + '; ' + data.direction, {
                body: 'TIME TO ' + data.toClock + ' (' + data.tfLabel + ' | Payout: ' + data.payoutPercent + '%)',
              });
            } else if (Notification.permission === 'default') {
              Notification.requestPermission().catch(() => {});
            }
          }

          // 4. Render Telegram-Style Floating Signal Card at top-center of Quotex chart
          const existing = document.getElementById('qx-ts-signal-hud');
          if (existing) existing.remove();

          const hud = document.createElement('div');
          hud.id = 'qx-ts-signal-hud';
          const isCall = data.direction === 'CALL';
          const accent = isCall ? '#0FAF59' : '#FF6251';
          const badge = isCall ? '🟩 CALL (UP)' : '🟥 PUT (DOWN)';
          hud.style.cssText = [
            'position:fixed',
            'top:98px',
            'left:50%',
            'transform:translateX(-50%)',
            'z-index:999999',
            'background:rgba(15, 22, 34, 0.97)',
            'border:2px solid ' + accent,
            'border-radius:12px',
            'padding:14px 22px',
            'color:#ffffff',
            'font-family:system-ui,-apple-system,sans-serif',
            'box-shadow:0 12px 36px rgba(0,0,0,0.75)',
            'cursor:pointer',
            'min-width:340px',
            'max-width:520px',
            'text-align:left',
          ].join(';');

          const reasonsHtml = (data.reasons || [])
            .map((r) => '<div style="font-size:11px;color:#cbd5e1;margin-top:2px">• ' + r + '</div>')
            .join('');

          hud.innerHTML =
            '<div style="font-size:17px;font-weight:800;letter-spacing:0.3px;color:#ffffff">' +
            data.asset +
            '; ' +
            data.entryClock +
            '; <span style="color:' +
            accent +
            '">' +
            badge +
            '</span></div>' +
            '<div style="font-size:15px;font-weight:700;margin-top:6px;color:#f8fafc">🕒 TIME TO ' +
            data.toClock +
            ' &nbsp;<span style="font-size:12px;font-weight:500;color:#94a3b8">(' +
            data.tfLabel +
            ' Expiry | Payout: ' +
            data.payoutPercent +
            '% | Confluence: ' +
            data.confidence +
            '%)</span></div>' +
            '<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.12)">' +
            reasonsHtml +
            '</div>';

          hud.onclick = () => hud.remove();
          document.body.appendChild(hud);
          setTimeout(() => {
            if (hud.parentElement) hud.remove();
          }, 30000);
        } catch (e) {}
      })(${JSON.stringify(payload)})`);
    } catch {}
  }

  /**
   * Returns all currently open market tabs on the Quotex top bar ([data-symbol]).
   */
  public async getOpenMarketTabs(): Promise<OpenMarketTab[]> {
    if (this.page.isClosed()) return [];
    try {
      const rawTabs = (await this.page.evaluate(`(() => {
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
      })()`)) as Array<{ rawSymbol: string; label: string; payout: number; isActive: boolean }>;

      return rawTabs.map((t) => ({
        ...t,
        normAsset: normalizeAsset(t.rawSymbol),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Switches the active Quotex Chrome window between DEMO Account and LIVE Account
   * using the native top-right header dropdown (<qx-usermenu-trigger>), or stays if already on target.
   */
  public async switchAccountMode(targetMode: 'DEMO' | 'LIVE'): Promise<boolean> {
    if (this.page.isClosed()) return false;
    try {
      const current = (await this.page.evaluate(`(() => {
        const url = window.location.href.toLowerCase();
        const chartContainer = document.querySelector('.chart-container');
        const key = chartContainer ? Object.keys(chartContainer).find((k) => k.startsWith('__reactFiber')) : null;
        let curr = chartContainer && key ? chartContainer[key] : null;
        let activeAcc = '';
        while (curr) {
          if (curr.memoizedProps?.value?.store) {
            activeAcc = String(curr.memoizedProps.value.store.getState()?.global?.activeAccount || '').toLowerCase();
            break;
          }
          curr = curr.return;
        }
        return { url, activeAcc };
      })()`)) as { url: string; activeAcc: string };

      const alreadyDemo = current.activeAcc === 'demo' || current.url.includes('/demo-trade');
      const alreadyLive = current.activeAcc === 'live' || (!current.url.includes('/demo-trade') && current.url.includes('/trade'));

      if (targetMode === 'DEMO' && alreadyDemo) return true;
      if (targetMode === 'LIVE' && alreadyLive) return true;

      // Click the native header account menu trigger (<qx-usermenu-trigger>)
      await this.page.evaluate(`(() => {
        const trigger = document.querySelector('qx-usermenu-trigger');
        if (trigger) trigger.click();
      })()`);
      await this.page.waitForTimeout(450);

      const clicked = (await this.page.evaluate(`((wantLive) => {
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
      })(${targetMode === 'LIVE'})`)) as boolean;

      if (!clicked) {
        // Fallback: navigate directly using the same origin & language prefix
        const curUrl = new URL(this.page.url());
        const langMatch = curUrl.pathname.match(/^\/([a-z]{2})\//i);
        const langPrefix = langMatch ? `/${langMatch[1]}` : '/en';
        const targetUrl = `${curUrl.origin}${langPrefix}/${targetMode === 'LIVE' ? 'trade' : 'demo-trade'}`;
        await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      }

      // Wait up to 6s for Quotex to finish switching account state
      for (let i = 0; i < 15; i++) {
        await this.page.waitForTimeout(400);
        const nowAcc = (await this.page.evaluate(`(() => {
          const url = window.location.href.toLowerCase();
          const chartContainer = document.querySelector('.chart-container');
          const key = chartContainer ? Object.keys(chartContainer).find((k) => k.startsWith('__reactFiber')) : null;
          let curr = chartContainer && key ? chartContainer[key] : null;
          let activeAcc = '';
          while (curr) {
            if (curr.memoizedProps?.value?.store) {
              activeAcc = String(curr.memoizedProps.value.store.getState()?.global?.activeAccount || '').toLowerCase();
              break;
            }
            curr = curr.return;
          }
          return { url, activeAcc };
        })()`)) as { url: string; activeAcc: string };

        if (targetMode === 'DEMO' && (nowAcc.activeAcc === 'demo' || nowAcc.url.includes('/demo-trade'))) {
          return true;
        }
        if (targetMode === 'LIVE' && (nowAcc.activeAcc === 'live' || (!nowAcc.url.includes('/demo-trade') && nowAcc.url.includes('/trade')))) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Closes / removes a specific market tab ([data-symbol="..."] .LtauB) from the Quotex top bar
   * when its payout drops too low or its volatility/structure becomes erratic/toxic.
   */
  public async closeMarketTab(rawSymbol: string): Promise<boolean> {
    if (this.page.isClosed()) return false;
    try {
      const tabs = await this.getOpenMarketTabs();
      if (tabs.length <= 1) {
        return false; // Always keep at least 1 tab open on Quotex
      }

      const closed = (await this.page.evaluate(`((sym) => {
        const tab = document.querySelector('[data-symbol="' + sym + '"]');
        if (!tab) return false;
        const closeBtn = tab.querySelector('.LtauB');
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
        return false;
      })(${JSON.stringify(rawSymbol)})`)) as boolean;

      if (closed) {
        await this.page.waitForTimeout(450 + Math.floor(Math.random() * 250));
      }
      return closed;
    } catch {
      return false;
    }
  }

  /**
   * Opens multiple high-payout currency markets into the Quotex top tab bar simultaneously,
   * skipping any pairs currently blacklisted/removed for erratic volatility or poor calibration.
   */
  public async ensureMultiMarketTabsOpen(
    targetCount: number = 4,
    minPayout: number = 84,
    excludedNormAssets?: Set<string>
  ): Promise<OpenMarketTab[]> {
    if (this.page.isClosed()) return [];
    this.isBusy = true;
    try {
      let currentTabs = await this.getOpenMarketTabs();
      if (currentTabs.filter((t) => t.payout >= minPayout).length >= targetCount) {
        return currentTabs;
      }

      // Click the "+" button (button.CAZSg) to open the Quotex asset table
      await this.page.evaluate(`(() => {
        const plusBtn = document.querySelector('button.CAZSg');
        if (plusBtn) plusBtn.click();
      })()`);
      await this.page.waitForTimeout(550);

      // Read all visible high-payout rows inside the asset modal (.vPvlJ)
      const candidates = (await this.page.evaluate(`((minPct) => {
        return Array.from(document.querySelectorAll('.vPvlJ')).map((row) => {
          const nameEl = row.querySelector('.Wztsn');
          const label = nameEl ? (nameEl.textContent || '').trim() : '';
          const text = (row.textContent || '').trim();
          const pcts = (text.match(/(\\d+)%/g) || []).map((s) => parseInt(s, 10));
          const maxPct = pcts.length > 0 ? Math.max(...pcts) : 0;
          return { label, maxPct };
        }).filter((r) => r.label && r.maxPct >= minPct);
      })(${minPayout})`)) as Array<{ label: string; maxPct: number }>;

      candidates.sort((a, b) => b.maxPct - a.maxPct);

      for (const cand of candidates) {
        currentTabs = await this.getOpenMarketTabs();
        if (currentTabs.length >= targetCount) break;
        if (currentTabs.some((t) => t.label === cand.label)) continue;
        if (excludedNormAssets && excludedNormAssets.has(normalizeAsset(cand.label))) continue;

        // Re-open asset modal if it closed after clicking the previous row
        const modalOpen = (await this.page.evaluate(`(() => document.querySelectorAll('.vPvlJ').length > 0)()`)) as boolean;
        if (!modalOpen) {
          await this.page.evaluate(`(() => {
            const plusBtn = document.querySelector('button.CAZSg');
            if (plusBtn) plusBtn.click();
          })()`);
          await this.page.waitForTimeout(480);
        }

        const clicked = (await this.page.evaluate(`((targetLabel) => {
          const items = Array.from(document.querySelectorAll('.vPvlJ .Wztsn'));
          const match = items.find((el) => (el.textContent || '').trim() === targetLabel);
          if (match) {
            match.click();
            return true;
          }
          return false;
        })(${JSON.stringify(cand.label)})`)) as boolean;

        if (clicked) {
          // Calm humanized delay between opening market tabs
          await this.page.waitForTimeout(650 + Math.floor(Math.random() * 300));
        }
      }

      // Close asset selector modal cleanly if still open
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(300);

      return await this.getOpenMarketTabs();
    } catch {
      return await this.getOpenMarketTabs();
    } finally {
      this.isBusy = false;
    }
  }

  /**
   * Switches to a specific open market tab ([data-symbol]) and performs a strict 4-point
   * isolation verification on Redux chartSettings.chartById.graph before returning its history.
   * Guarantees zero hallucination or cross-pair data mixing.
   */
  public async switchToMarketTabAndVerify(
    targetRawSymbol: string,
    prevFirstPointValue: number = -1
  ): Promise<VerifiedMarketSnapshot | null> {
    if (this.page.isClosed()) return null;
    try {
      // Click the tab ONLY if it is not already #tab-active; remember whether we actually switched
      const didSwitch = await this.safeEvaluate<boolean>(`((sym) => {
        const tab = document.querySelector('[data-symbol="' + sym + '"]');
        if (tab && tab.id !== 'tab-active') {
          const clickTarget = tab.querySelector('.H4wMV') || tab;
          clickTarget.click();
          return true;
        }
        return false;
      })(${JSON.stringify(targetRawSymbol)})`, false);

      const maxAttempts = didSwitch ? 14 : 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (didSwitch || attempt > 0) {
          await this.page.waitForTimeout(160);
        }
        const snap = await this.safeEvaluate<any>(`((expectedSym, prevFirstVal, switched, att) => {
          try {
            const activeTab = document.querySelector('#tab-active');
            const domActiveSym = activeTab ? activeTab.getAttribute('data-symbol') : '';
            if (domActiveSym && domActiveSym !== expectedSym) {
              return { ready: false };
            }

            const chartContainer = document.querySelector('.chart-container');
            const key = chartContainer ? Object.keys(chartContainer).find((k) => k.startsWith('__reactFiber')) : null;
            let curr = chartContainer && key ? chartContainer[key] : null;
            let st = null;
            while (curr) {
              if (curr.memoizedProps?.value?.store) {
                st = curr.memoizedProps.value.store.getState();
                break;
              }
              curr = curr.return;
            }

            const g = st?.chartSettings?.chartById?.graph;
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

            // Strict price-scale consistency check: last history point must match currentAsset.price within 1.8%
            const relDiff = Math.abs(lastVal - curPrice) / Math.max(1e-9, curPrice);
            if (relDiff >= 0.018) {
              return { ready: false };
            }

            // Only require history fingerprint change when we actually switched from another market
            if (switched && prevFirstVal > 0 && Math.abs(firstVal - prevFirstVal) < 1e-12 && att < 4) {
              return { ready: false };
            }

            const pctText = (activeTab?.querySelector('.ElyTP')?.textContent || document.querySelector('.OmOPV .eB25d')?.textContent || '');
            const pctMatch = pctText.match(/(\\d+)%/);
            const domPayout = pctMatch ? parseInt(pctMatch[1], 10) : 0;
            const obj = g?.currentAsset?.obj || {};
            const tfSec = typeof g?.timePeriod === 'number' && g.timePeriod > 0 ? g.timePeriod : 300;
            const storePayout = tfSec >= 300 && obj.payout_5 ? obj.payout_5 : (obj.payout_1 || obj.payout || 80);

            const openDeals = Object.values(st?.deals?.openedById || {});
            const hasOpenDealOnSymbol = openDeals.some((d) => d && String(d.asset || '').toLowerCase() === String(curSym).toLowerCase());

            return {
              ready: true,
              rawSymbol: curSym,
              label: obj.label || curSym,
              price: curPrice,
              payout: domPayout > 0 ? domPayout : storePayout,
              timeframeSeconds: tfSec,
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
   * Sets the Deal Panel's Investment ($) stake input box using React's native HTMLInputElement setter
   * and verifies that Quotex's Redux store (graph.dealValue) accepted the exact amount.
   */
  public async setInvestmentStake(stakeAmount: number): Promise<boolean> {
    if (this.page.isClosed() || stakeAmount <= 0) return false;
    const cleanStake = Math.max(1, Math.round(stakeAmount * 100) / 100);
    try {
      const ok = (await this.page.evaluate(`((targetStake) => {
        const inputs = Array.from(document.querySelectorAll('input.input-control__input'));
        const invInput = inputs.find((el) => {
          const val = (el.value || '').trim();
          return !val.includes(':') && /[0-9]/.test(val);
        });
        if (!invInput) return false;

        const currentNum = parseFloat((invInput.value || '').replace(/[^0-9.]/g, ''));
        if (Math.abs(currentNum - targetStake) < 0.001) return true;

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        invInput.focus();
        if (setter) {
          setter.call(invInput, String(targetStake));
        } else {
          invInput.value = String(targetStake);
        }
        invInput.dispatchEvent(new Event('input', { bubbles: true }));
        invInput.dispatchEvent(new Event('change', { bubbles: true }));
        invInput.blur();
        return true;
      })(${cleanStake})`)) as boolean;

      await this.page.waitForTimeout(120);
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Executes a live CALL (Buy / Up) or PUT (Sell / Down) trade on the active Quotex chart
   * with strict pre-flight symbol verification, stake/expiry sync, humanized stealth click timing,
   * and post-click Redux deal verification.
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
      // 1. Sync expiry timer & investment stake first
      await this.syncExpiryToTimeframe(params.timeframeSeconds);
      const stakeSet = await this.setInvestmentStake(params.stakeAmount);
      if (!stakeSet) {
        return { executed: false, reason: 'Could not locate or set Investment stake input box' };
      }

      // 2. Strict pre-click symbol & button readiness verification
      const preCheck = await this.safeEvaluate<any>(`((expectedSym, dir) => {
        const activeTab = document.querySelector('#tab-active');
        const domSym = activeTab ? activeTab.getAttribute('data-symbol') : '';

        const chartContainer = document.querySelector('.chart-container');
        const key = chartContainer ? Object.keys(chartContainer).find((k) => k.startsWith('__reactFiber')) : null;
        let curr = chartContainer && key ? chartContainer[key] : null;
        let st = null;
        while (curr) {
          if (curr.memoizedProps?.value?.store) {
            st = curr.memoizedProps.value.store.getState();
            break;
          }
          curr = curr.return;
        }

        const g = st?.chartSettings?.chartById?.graph;
        const storeSym = g?.currentAsset?.symbol;
        const storePrice = g?.currentAsset?.price;
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
      if (!preCheck?.btnReady || !preCheck?.rect) {
        return { executed: false, reason: `Trade button (${params.direction}) not ready on screen` };
      }

      const prevDealIds = new Set<string>(preCheck.openDealIds || []);

      // 3. Humanized stealth pause & randomized click position inside the Buy/Sell button
      await this.page.waitForTimeout(120 + Math.floor(Math.random() * 160));
      const clickX = preCheck.rect.x + preCheck.rect.w * (0.3 + Math.random() * 0.4);
      const clickY = preCheck.rect.y + preCheck.rect.h * (0.3 + Math.random() * 0.4);
      await this.page.mouse.move(clickX, clickY, { steps: 4 });
      await this.page.waitForTimeout(35 + Math.floor(Math.random() * 45));
      await this.page.mouse.click(clickX, clickY);

      // 4. Verify in Redux store (deals.openedById) that Quotex accepted and opened the new deal
      for (let attempt = 0; attempt < 10; attempt++) {
        await this.page.waitForTimeout(200);
        const postCheck = await this.safeEvaluate<
          Array<{ id: string; asset: string; amount: number; openPrice: number; command: number }>
        >(
          `(() => {
          const chartContainer = document.querySelector('.chart-container');
          const key = chartContainer ? Object.keys(chartContainer).find((k) => k.startsWith('__reactFiber')) : null;
          let curr = chartContainer && key ? chartContainer[key] : null;
          while (curr) {
            if (curr.memoizedProps?.value?.store) {
              const openedById = curr.memoizedProps.value.store.getState()?.deals?.openedById || {};
              return Object.values(openedById).map((d) => ({
                id: String(d.id),
                asset: d.asset,
                amount: d.amount,
                openPrice: d.openPrice,
                command: d.command
              }));
            }
            curr = curr.return;
          }
          return [];
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
