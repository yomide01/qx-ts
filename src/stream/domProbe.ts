/**
 * DOM Probe: shows exactly what the bot can read from your Quotex screen.
 *
 * Quotex changes its page layout from time to time. If the bot ever reads the wrong market
 * name, price or account label, run this while Quotex is open on the chart you care about:
 *
 *     npm run debug:dom
 *
 * It prints, for each thing the bot tries to read, which page element matched and what text
 * it contained. That makes it quick to fix a selector that has stopped working.
 */
import { launchBrowserSession } from '../browser/launcher.js';
import { accountModeFromUrl } from './wsSniffer.js';

async function main() {
  console.log('Opening Quotex. Switch to the market/account you want to test, then watch the output.\n');
  const { page } = await launchBrowserSession();

  setInterval(async () => {
    try {
      if (page.isClosed()) return;
      const report = await page.evaluate(() => {
        const probe = (selectors: string[]) =>
          selectors.map((sel) => {
            const els = Array.from(document.querySelectorAll(sel));
            return {
              selector: sel,
              matches: els.length,
              firstText: (els[0]?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            };
          });
        return {
          url: window.location.href,
          symbol: probe(['.current-symbol__name', '[class*="current-symbol"]', '[class*="symbol-name"]', '[class*="asset-name"]', '.tab-item--active .tab-item__name', '[class*="pair-name"]', '.chart-top-panel__asset-name', '[data-id="asset-name"]']),
          price: probe(['.current-price', '[class*="current-price"]', '[class*="chart-quote"]', '[class*="quote__value"]', '.price-value']),
          payout: probe(['[class*="payout-percent"]', '[class*="profit-percent"]', '[class*="deal-form__payout"]', '.payout-value']),
          account: probe(['[class*="account"]', '[class*="balance"]', 'header']),
        };
      });
      console.clear();
      console.log(`URL: ${report.url}`);
      console.log(`Account mode from URL: ${accountModeFromUrl(report.url)}\n`);
      for (const group of ['symbol', 'price', 'payout', 'account'] as const) {
        console.log(`== ${group.toUpperCase()} ==`);
        for (const r of report[group]) {
          console.log(`  ${r.matches > 0 ? 'FOUND ' : 'none  '} ${r.selector.padEnd(46)} ${r.matches > 0 ? `(${r.matches}) "${r.firstText}"` : ''}`);
        }
      }
    } catch {
      // page navigating
    }
  }, 2000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
