import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface SessionStatus {
  isAuthenticated: boolean;
  currentUrl: string;
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
 * Attempts to connect to an already-running Chrome instance ONLY if explicitly configured.
 */
async function tryConnectToExistingChrome(
  port: number,
  onPageCreated?: (page: Page) => Promise<void>
): Promise<{ context: BrowserContext; page: Page } | null> {
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 1500 });
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) return null;

    const pages = context.pages();
    let page = pages.find((p) => p.url().includes('quotex.com') || p.url().includes('qxbroker.com'));
    if (!page) {
      page = pages[0] ?? await context.newPage();
    }

    console.log(`[Browser] ✅ Attached to existing Chrome window: ${page.url()}`);
    if (onPageCreated) {
      await onPageCreated(page);
    }
    return { context, page };
  } catch {
    return null;
  }
}

/**
 * Launches a dedicated, visible Google Chrome window with the saved Quotex trading profile.
 */
export async function launchBrowserSession(
  onPageCreated?: (page: Page) => Promise<void>
): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  console.log('======================================================');
  console.log('   QX Persistent Browser Harness — Dedicated Chrome   ');
  console.log('======================================================');
  console.log(`[Browser] Profile Directory: ${config.userDataDir}`);
  console.log(`[Browser] Chrome Executable: ${config.chromePath}`);
  console.log(`[Browser] Quotex URL       : ${config.qxUrl}`);
  console.log(`[Browser] Headless Mode    : ${config.headless}`);

  // Optional: If user explicitly configured an external remote debug port, try it first
  if (config.remoteDebugPort) {
    console.log(`[Browser] Checking for existing Chrome on port ${config.remoteDebugPort}...`);
    const existing = await tryConnectToExistingChrome(config.remoteDebugPort, onPageCreated);
    if (existing) {
      return existing;
    }
    console.log('[Browser] No active debug port found. Launching dedicated Chrome window...');
  }

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
    await page.bringToFront();
  } catch (err) {
    console.warn('[Browser Warning] Navigation notice:', (err as Error).message);
  }

  const status = checkSessionStatus(page.url());
  if (status.isAuthenticated) {
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
      if (updatedUrl.includes('/trade') || updatedUrl.includes('/demo-trade')) {
        console.log(`[Session Watcher] Trading Room detected: ${updatedUrl}`);
      }
    }
  });

  return { context, page };
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
