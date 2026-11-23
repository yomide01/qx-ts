import { Page } from 'playwright';

/**
 * Shared browser-side helper snippet for traversing Quotex's React Fiber tree
 * to access the live Redux store state and active chart graph slice.
 * Centralizes all fragile internal store access in one place.
 */
export const REDUX_STORE_HELPER_JS = `
  function getReduxState() {
    try {
      const root = document.querySelector('.chart-container') || document.querySelector('canvas');
      if (!root) return null;
      const key = Object.keys(root).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      let curr = key ? root[key] : null;
      let depth = 0;
      while (curr && depth < 24) {
        const p = curr.memoizedProps;
        if (p?.value?.store && typeof p.value.store.getState === 'function') {
          return p.value.store.getState();
        }
        curr = curr.return;
        depth++;
      }
    } catch (e) {}
    return null;
  }

  function getActiveGraph(st) {
    const cs = st?.chartSettings;
    if (!cs) return null;
    const globalSt = st?.global;
    const activeChartId =
      globalSt?.currentChartId ||
      (Array.isArray(cs.visibleChartIds) && cs.visibleChartIds[0]) ||
      (Array.isArray(cs.chartIds) && cs.chartIds[0]) ||
      'graph';
    return cs.chartById?.[activeChartId] || cs.chartById?.graph || (cs.chartById ? Object.values(cs.chartById)[0] : null);
  }
`;

/**
 * Shared browser-side helper for resolving Quotex's TRUE candle timeframe (in seconds).
 *
 * CRITICAL DISTINCTION in Quotex Redux:
 *  - graph.chartPeriod (1..13) & `.NDbAT .HgaSf` = CANDLE TIMEFRAME (e.g. 6 -> 300s = 5m candles)
 *  - graph.timePeriod (e.g. 60, 300, 600)        = DEAL EXPIRY DURATION, NOT candle timeframe!
 */
export const PERIOD_CODE_MAP_JS = `
  const PERIOD_CODE_MAP = {
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

  function parseTfLabel(str) {
    if (!str) return null;
    const m = String(str).trim().toLowerCase().match(/^(5s|10s|15s|30s|1m|2m|5m|10m|15m|30m|1h|4h|1d)$/);
    if (!m) return null;
    const val = parseInt(m[1].slice(0, -1), 10);
    const unit = m[1].slice(-1);
    return unit === 's' ? val : unit === 'm' ? val * 60 : unit === 'h' ? val * 3600 : val * 86400;
  }

  function inferTimeframeFromHistoryPoints(pts) {
    if (!Array.isArray(pts) || pts.length < 12) return null;
    // Quotex compresses historical bars into 4 points: t0, t0+1, t0+2, t0+(tf-1), next bar at t0+tf
    // So the dominant gap between anchor points (where tick > 0) equals the true candle period.
    const anchors = pts.filter((p) => typeof p?.time === 'number' && typeof p?.tick === 'number' && p.tick > 1);
    if (anchors.length < 3) return null;
    const counts = {};
    for (let i = 1; i < Math.min(anchors.length, 40); i++) {
      const diff = Math.round(anchors[i].time - anchors[i - 1].time);
      if (diff >= 5 && diff <= 86400) {
        counts[diff] = (counts[diff] || 0) + 1;
      }
    }
    let bestTf = null;
    let bestCount = 0;
    for (const [k, c] of Object.entries(counts)) {
      if (c > bestCount) {
        bestCount = c;
        bestTf = Number(k);
      }
    }
    return bestCount >= 2 ? bestTf : null;
  }

  function resolveCandleTimeframeSeconds(graph) {
    // Priority 1: Strictly scoped chart timeframe badge (.NDbAT .HgaSf)
    const badges = Array.from(document.querySelectorAll('.NDbAT .HgaSf'));
    for (const el of badges) {
      const parsed = parseTfLabel(el.textContent || '');
      if (parsed) return parsed;
    }
    // Priority 2: Redux graph.chartPeriod code map
    if (graph && typeof graph.chartPeriod === 'number' && PERIOD_CODE_MAP[graph.chartPeriod]) {
      return PERIOD_CODE_MAP[graph.chartPeriod];
    }
    // Priority 3: Infer from historyPoints anchor spacing
    const inferred = inferTimeframeFromHistoryPoints(graph?.historyPoints);
    if (inferred) return inferred;
    return 300;
  }

  function resolveAccountIsDemo(st) {
    const path = (window.location.pathname || '').toLowerCase();
    if (path.includes('/demo-trade')) return true;
    if (path.includes('/trade') && !path.includes('/demo-trade')) return false;

    const g = st?.global;
    if (g) {
      if (typeof g.isDemo === 'boolean') return g.isDemo;
      if (typeof g.activeAccount === 'string') {
        if (g.activeAccount.toLowerCase() === 'demo') return true;
        if (g.activeAccount.toLowerCase() === 'live') return false;
      }
      if (typeof g.balance === 'number' && typeof g.demoBalance === 'number' && typeof g.liveBalance === 'number') {
        if (g.demoBalance !== g.liveBalance) {
          if (Math.abs(g.balance - g.demoBalance) < 0.01) return true;
          if (Math.abs(g.balance - g.liveBalance) < 0.01) return false;
        }
      }
    }
    if (typeof window !== 'undefined' && window.settings && window.settings.isDemo !== undefined) {
      return Boolean(Number(window.settings.isDemo));
    }
    return null;
  }
`;

export interface PlatformHealthReport {
  healthy: boolean;
  issues: string[];
  details: {
    storeFound: boolean;
    activeSymbol: string | null;
    candleTimeframeSeconds: number | null;
    expirySeconds: number | null;
    dealValue: number | null;
    upButtonFound: boolean;
    downButtonFound: boolean;
    stakeInputFound: boolean;
    expiryInputFound: boolean;
    openTabCount: number;
  };
}

/**
 * Verifies that Quotex's Redux store and critical trade UI selectors are intact.
 * Prevents the bot from blindly clicking if Quotex deploys a frontend DOM change.
 */
export async function verifyPlatformHealth(page: Page): Promise<PlatformHealthReport> {
  const fallback: PlatformHealthReport = {
    healthy: false,
    issues: ['Browser page closed or unresponsive'],
    details: {
      storeFound: false,
      activeSymbol: null,
      candleTimeframeSeconds: null,
      expirySeconds: null,
      dealValue: null,
      upButtonFound: false,
      downButtonFound: false,
      stakeInputFound: false,
      expiryInputFound: false,
      openTabCount: 0,
    },
  };
  if (page.isClosed()) return fallback;

  try {
    const res = await Promise.race([
      page.evaluate(`(() => {
        ${REDUX_STORE_HELPER_JS}
        ${PERIOD_CODE_MAP_JS}
        const st = getReduxState();
        const g = getActiveGraph(st);
        const inputs = Array.from(document.querySelectorAll('input.input-control__input'));
        const expiryInputFound = inputs.some((el) => /^\\d{2}:\\d{2}:\\d{2}$/.test((el.value || '').trim()));
        const stakeInputFound = inputs.some((el) => {
          const v = (el.value || '').trim();
          return !v.includes(':') && /[0-9]/.test(v);
        });
        const upBtn = document.querySelector('#trade-button-up, button.call-btn, [class*="button--up"], [class*="deal-button--up"]');
        const downBtn = document.querySelector('#trade-button-down, button.put-btn, [class*="button--down"], [class*="deal-button--down"]');
        const tabs = document.querySelectorAll('[data-symbol]');

        return {
          storeFound: !!st && !!g,
          activeSymbol: g?.currentAsset?.symbol || null,
          candleTimeframeSeconds: g ? resolveCandleTimeframeSeconds(g) : null,
          expirySeconds: typeof g?.timePeriod === 'number' ? g.timePeriod : null,
          dealValue: typeof g?.dealValue === 'number' ? g.dealValue : null,
          upButtonFound: !!upBtn,
          downButtonFound: !!downBtn,
          stakeInputFound,
          expiryInputFound,
          openTabCount: tabs.length,
        };
      })()`) as Promise<PlatformHealthReport['details']>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
    ]);

    if (!res) return fallback;

    const issues: string[] = [];
    if (!res.storeFound) issues.push('Quotex Redux store not accessible on .chart-container');
    if (!res.activeSymbol) issues.push('Active chart symbol missing from Redux');
    if (!res.upButtonFound) issues.push('Buy/CALL button selector not found');
    if (!res.downButtonFound) issues.push('Sell/PUT button selector not found');
    if (!res.stakeInputFound) issues.push('Investment stake input box not found');
    if (!res.expiryInputFound) issues.push('Expiry timer input box not found');
    if (res.openTabCount === 0) issues.push('Top market tab bar ([data-symbol]) not found');

    return {
      healthy: issues.length === 0,
      issues,
      details: res,
    };
  } catch {
    return fallback;
  }
}
