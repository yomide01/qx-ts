import { chromium, BrowserContext, Page } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const config = {
  qxUrl: process.env.QX_URL || 'https://quotex.com/en/demo-trade',
  userDataDir: path.resolve(process.cwd(), process.env.USER_DATA_DIR || './qx_user_profile'),
  chromePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: process.env.HEADLESS === 'true',
  remoteDebugPort: process.env.CHROME_REMOTE_DEBUG ? Number(process.env.CHROME_REMOTE_DEBUG) : null,
};

export interface SessionStatus {
  isAuthenticated: boolean;
  isCloudflareBlocked?: boolean;
  isLoginPage?: boolean;
  currentUrl: string;
  pageTitle?: string;
}

/**
 * Inspects the actual live page DOM and title (not just the URL string)
 * to determine whether the browser is on a Cloudflare verification challenge,
 * a Quotex login screen, or inside the authenticated trading room.
 */
export async function inspectPageStatus(page: Page): Promise<SessionStatus> {
  const currentUrl = page.url();
  try {
    const info = await page.evaluate(`(() => {
      const title = document.title || '';
      const bodyText = document.body?.innerText || '';
      const url = window.location.href;
      const isCf =
        title.includes('Just a moment') ||
        title.includes('Attention Required') ||
        url.includes('__cf_chl') ||
        !!document.querySelector('#challenge-running, #cf-wrapper, iframe[src*="challenges.cloudflare.com"]') ||
        bodyText.includes('Performing security verification');

      const hasChartCanvas = document.querySelectorAll('canvas').length > 0;
      const hasTradingUI =
        !!document.querySelector('[class*="deal-form"], [class*="current-symbol"], [class*="usermenu"], [class*="balance"]');
      const hasLoginForm =
        url.includes('/sign-in') ||
        url.includes('/login') ||
        (!!document.querySelector('input[type="password"], input[name="email"]') && !hasChartCanvas);

      return { title, isCf, hasChartCanvas, hasTradingUI, hasLoginForm };
    })()`) as {
      title: string;
      isCf: boolean;
      hasChartCanvas: boolean;
      hasTradingUI: boolean;
      hasLoginForm: boolean;
    };

    const urlHasTrade = currentUrl.includes('/trade') || currentUrl.includes('/demo-trade');
    const isAuthenticated = !info.isCf && !info.hasLoginForm && urlHasTrade && (info.hasChartCanvas || info.hasTradingUI);

    return {
      isAuthenticated,
      isCloudflareBlocked: info.isCf,
      isLoginPage: info.hasLoginForm,
      currentUrl,
      pageTitle: info.title,
    };
  } catch {
    return checkSessionStatus(currentUrl);
  }
}

/**
 * Removes stale Chrome lockfiles left behind if Chrome previously crashed or was force-closed.
 * This prevents the "Failed to create a ProcessSingleton / Lock file cannot be created" error.
 */
function cleanStaleProfileLocks(userDataDir: string): void {
  const locks = ['lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const file of locks) {
    const fullPath = path.join(userDataDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // Ignored if file is actively held
      }
    }
  }
}

/**
 * Attempts to connect to an already-running visible Chrome instance on the remote debug port.
 */
async function tryConnectToExistingChrome(
  port: number,
  onPageCreated?: (page: Page) => Promise<void>
): Promise<{ context: BrowserContext; page: Page; isExternalChrome: boolean } | null> {
  const endpoints = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  for (const endpoint of endpoints) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 });
      const contexts = browser.contexts();
      const context = contexts[0];
      if (!context) continue;

      const pages = context.pages();
      let page = pages.find((p) => p.url().includes('quotex.com') || p.url().includes('qxbroker.com'));
      if (!page) {
        page = pages[0] ?? (await context.newPage());
      }

      console.log(`[Browser] ✅ Attached to visible Chrome window (${endpoint}): ${page.url()}`);
      if (onPageCreated) {
        await onPageCreated(page);
      }

      // If the tab hasn't navigated to Quotex yet, navigate it now
      if (!page.url().includes('quotex.com') && !page.url().includes('qxbroker.com')) {
        console.log(`[Browser] Navigating visible Chrome tab to ${config.qxUrl}...`);
        try {
          await page.goto(config.qxUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        } catch {}
      }

      try {
        await page.bringToFront();
      } catch {}

      return { context, page, isExternalChrome: true };
    } catch {
      // Try next endpoint
    }
  }
  return null;
}

/**
 * Launches or attaches to a dedicated, visible Google Chrome window with the saved Quotex trading profile.
 */
export async function launchBrowserSession(
  onPageCreated?: (page: Page) => Promise<void>
): Promise<{
  context: BrowserContext;
  page: Page;
  isExternalChrome?: boolean;
}> {
  console.log('======================================================');
  console.log('   QX Persistent Browser Harness — Dedicated Chrome   ');
  console.log('======================================================');
  console.log(`[Browser] Profile Directory: ${config.userDataDir}`);
  console.log(`[Browser] Chrome Executable: ${config.chromePath}`);
  console.log(`[Browser] Quotex URL       : ${config.qxUrl}`);
  console.log(`[Browser] Headless Mode    : ${config.headless}`);

  // If remote debug port is configured (default 9222), attach to the user's visible Chrome on port 9222.
  // Never spawn a hidden background Chrome from a non-interactive shell!
  const debugPort = config.remoteDebugPort || 9222;
  console.log(`[Browser] Checking for visible Chrome on port ${debugPort}...`);
  let existing = await tryConnectToExistingChrome(debugPort, onPageCreated);

  if (!existing) {
    cleanStaleProfileLocks(config.userDataDir);
    console.log(
      `[Browser] Waiting for visible Chrome on port ${debugPort} (double-click OPEN_QUOTEX_CHROME.bat or START_QX_BOT.bat)...`
    );
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      existing = await tryConnectToExistingChrome(debugPort, onPageCreated);
      if (existing) break;
    }
  }

  if (existing) {
    // Wait for Quotex's React app splash screen (.loading) to mount the trading chart or login form
    await existing.page
      .waitForSelector('canvas, .chart-container, .OmOPV, input[type="password"], #challenge-running', {
        timeout: 15000,
      })
      .catch(() => {});
    await existing.page.waitForTimeout(1200);

    const status = await inspectPageStatus(existing.page);
    if (status.isCloudflareBlocked) {
      console.log('\n------------------------------------------------------');
      console.log('>>> [CLOUDFLARE VERIFICATION REQUIRED] Complete the security check in your visible Chrome window.');
      console.log(`>>> Current URL: ${status.currentUrl}`);
      console.log('------------------------------------------------------\n');
    } else if (status.isAuthenticated) {
      console.log(`\n>>> [STATUS: LOGGED IN] Authenticated Quotex Trading Room active!`);
      console.log(`>>> Current URL: ${status.currentUrl}\n`);
    } else {
      console.log('\n------------------------------------------------------');
      console.log('>>> [ACTION REQUIRED] Please log into your Quotex DEMO account in the visible Chrome window.');
      console.log(`>>> Current URL: ${status.currentUrl}`);
      console.log('------------------------------------------------------\n');
    }
    return existing;
  }
  console.log('[Browser] Falling back to Playwright persistent context...');

  // 1. Ensure profile directory exists and clean stale lock files
  if (!fs.existsSync(config.userDataDir)) {
    fs.mkdirSync(config.userDataDir, { recursive: true });
  } else {
    cleanStaleProfileLocks(config.userDataDir);
  }

  // 2. Launch dedicated visible Google Chrome
  console.log('[Browser] Opening dedicated Google Chrome window...');
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    executablePath: fs.existsSync(config.chromePath) ? config.chromePath : undefined,
    headless: config.headless,
    viewport: null, // Natural window scaling to fit screen
    ignoreDefaultArgs: ['--enable-automation'],
    // Playwright switches Chrome's security sandbox OFF unless told otherwise, which is what
    // causes Chrome's "unsupported command-line flag: --no-sandbox" warning bar.
    chromiumSandbox: true,
    args: [
      '--start-maximized',
      '--window-position=0,0',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });

  // Inject stealth script to clean navigator.webdriver without unsupported command-line flags
  await context.addInitScript(() => {
    try {
      // Overwrite webdriver getter on Navigator prototype
      Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
        get: () => undefined,
      });
    } catch {}
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  // Attach interceptors/listeners BEFORE page navigates
  if (onPageCreated) {
    await onPageCreated(page);
  }

  console.log('[Browser] Navigating directly to Quotex...');
  try {
    await page.goto(config.qxUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    // Wait for Quotex's React app splash screen (.loading) to mount the trading chart or login form
    await page
      .waitForSelector('canvas, .chart-container, .OmOPV, input[type="password"], #challenge-running', {
        timeout: 15000,
      })
      .catch(() => {});
    await page.waitForTimeout(1500);
    await page.bringToFront();
  } catch (err) {
    console.warn('[Browser Warning] Navigation notice:', (err as Error).message);
  }

  const status = await inspectPageStatus(page);
  if (status.isCloudflareBlocked) {
    console.log('\n------------------------------------------------------');
    console.log('>>> [CLOUDFLARE VERIFICATION REQUIRED] Complete the security check in the Chrome window.');
    console.log(`>>> Current URL: ${page.url()}`);
    console.log('------------------------------------------------------\n');
  } else if (status.isAuthenticated) {
    console.log(`\n>>> [STATUS: LOGGED IN] Active trading session restored!`);
    console.log(`>>> Current URL: ${page.url()}\n`);
  } else {
    console.log('\n------------------------------------------------------');
    console.log('>>> [ACTION REQUIRED] Please log in manually in the Chrome window.');
    console.log('>>> Your session and cookies will be saved in ./qx_user_profile.');
    console.log('------------------------------------------------------\n');
  }

  // Continuous trading room navigation watcher
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      const updatedUrl = frame.url();
      if ((updatedUrl.includes('/trade') || updatedUrl.includes('/demo-trade')) && !updatedUrl.includes('__cf_chl')) {
        console.log(`[Session Watcher] Trading Room URL loaded: ${updatedUrl}`);
      }
    }
  });

  return { context, page, isExternalChrome: false };
}

/**
 * Checks if the current page URL represents an authenticated trading room
 */
export function checkSessionStatus(url: string): SessionStatus {
  const isTradeRoom = url.includes('/trade') || url.includes('/demo-trade');
  return {
    isAuthenticated: isTradeRoom,
    currentUrl: url,
  };
}
