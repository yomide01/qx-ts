import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { buildAlertSpawnArgs } from '../ui/sound.js';

dotenv.config();

export function parseCloseChromeOnExit(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  const v = raw.trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

export function buildChromeLaunchArgs(port: number, userDataDir: string, startUrl: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    startUrl,
  ];
}

function getConfig() {
  return {
    qxUrl: process.env.QX_URL || 'https://quotex.com/en/demo-trade',
    userDataDir: path.resolve(process.cwd(), process.env.USER_DATA_DIR || './qx_user_profile'),
    chromePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: process.env.HEADLESS === 'true',
    remoteDebugPort: process.env.CHROME_REMOTE_DEBUG ? Number(process.env.CHROME_REMOTE_DEBUG) : 9222,
    closeChromeOnExit: parseCloseChromeOnExit(process.env.CLOSE_CHROME_ON_EXIT),
  };
}

export interface SessionStatus {
  isAuthenticated: boolean;
  isCloudflareBlocked?: boolean;
  isLoginPage?: boolean;
  currentUrl: string;
  pageTitle?: string;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  isExternalChrome: boolean;
  closeChromeOnExit: boolean;
  closeBrowser: () => Promise<void>;
}

/**
 * Inspects the actual live page DOM and title to determine whether the browser
 * is on a Cloudflare verification challenge, a Quotex login screen, or inside
 * the authenticated trading room.
 */
export async function inspectPageStatus(page: Page): Promise<SessionStatus> {
  const currentUrl = page.url();
  try {
    const info = (await page.evaluate(`(() => {
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
    })()`)) as {
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

function cleanStaleProfileLocks(userDataDir: string): void {
  const locks = ['lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const file of locks) {
    const fullPath = path.join(userDataDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // Ignored if actively held
      }
    }
  }
}

/**
 * Spawns a zero-CPU kernel WaitForExit watcher on Windows so that even if the user
 * closes the terminal window via the red X button (hard-killing node.exe before async
 * cleanup runs), ONLY the dedicated bot Chrome profile (`qx_user_profile`) closes cleanly.
 * Never touches the user's personal Chrome profile.
 */
function startWindowsChromeExitGuard(nodePid: number, userDataDir: string): ChildProcess | null {
  if (process.platform !== 'win32') return null;
  const escapedDir = userDataDir.replace(/'/g, "''");
  const script = [
    `try {`,
    `  $parent = [System.Diagnostics.Process]::GetProcessById(${nodePid})`,
    `  $parent.WaitForExit()`,
    `} catch {}`,
    `Start-Sleep -Milliseconds 400`,
    `try {`,
    `  $target = '${escapedDir}'`,
    `  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {`,
    `    $_.CommandLine -and $_.CommandLine.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -notmatch '--type='`,
    `  }`,
    `  foreach ($p in $procs) {`,
    `    try {`,
    `      $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue`,
    `      if ($gp) {`,
    `        [void]$gp.CloseMainWindow()`,
    `        if (-not $gp.WaitForExit(3500)) {`,
    `          Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue`,
    `        }`,
    `      }`,
    `    } catch {}`,
    `  }`,
    `} catch {}`,
  ].join('\n');

  try {
    const guard = spawn('powershell.exe', buildAlertSpawnArgs(script), {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    guard.on('error', () => {});
    guard.unref();
    return guard;
  } catch {
    return null;
  }
}

async function tryConnectToExistingChrome(
  port: number,
  qxUrl: string,
  onPageCreated?: (page: Page) => Promise<void>
): Promise<{ browser: Browser; context: BrowserContext; page: Page } | null> {
  const endpoints = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  for (const endpoint of endpoints) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const contexts = browser.contexts();
      const context = contexts[0];
      if (!context) continue;

      const pages = context.pages();
      let page = pages.find((p) => p.url().includes('quotex.com') || p.url().includes('qxbroker.com'));
      if (!page) {
        page = pages[0] ?? (await context.newPage());
      }

      console.log(`[Browser] Attached to dedicated Chrome window (${endpoint}): ${page.url()}`);
      if (onPageCreated) {
        await onPageCreated(page);
      }

      if (!page.url().includes('quotex.com') && !page.url().includes('qxbroker.com')) {
        console.log(`[Browser] Navigating Chrome tab to ${qxUrl}...`);
        try {
          await page.goto(qxUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        } catch {}
      }

      try {
        await page.bringToFront();
      } catch {}

      return { browser, context, page };
    } catch {
      // Try next endpoint
    }
  }
  return null;
}

/**
 * Attaches to or automatically launches a dedicated, visible Google Chrome window using
 * `./qx_user_profile` (completely isolated from your personal Chrome) on CDP port 9222.
 *
 * When `CLOSE_CHROME_ON_EXIT=true` (default), closing the terminal (via Ctrl+C or the X button)
 * automatically closes the dedicated bot Chrome window cleanly.
 */
export async function launchBrowserSession(
  onPageCreated?: (page: Page) => Promise<void>
): Promise<BrowserSession> {
  const config = getConfig();

  console.log('======================================================');
  console.log('   QX Persistent Browser Harness — Dedicated Chrome   ');
  console.log('======================================================');
  console.log(`[Browser] Profile Directory : ${config.userDataDir}`);
  console.log(`[Browser] Chrome Executable : ${config.chromePath}`);
  console.log(`[Browser] Quotex URL        : ${config.qxUrl}`);
  console.log(`[Browser] Auto-Close Chrome : ${config.closeChromeOnExit ? 'YES (closes with terminal)' : 'NO (stays open)'}`);

  if (!fs.existsSync(config.userDataDir)) {
    fs.mkdirSync(config.userDataDir, { recursive: true });
  }

  const debugPort = config.remoteDebugPort || 9222;
  console.log(`[Browser] Checking for dedicated Chrome on port ${debugPort}...`);
  let connected = await tryConnectToExistingChrome(debugPort, config.qxUrl, onPageCreated);
  let spawnedChromePid: number | null = null;

  if (!connected && fs.existsSync(config.chromePath)) {
    cleanStaleProfileLocks(config.userDataDir);
    console.log(`[Browser] Launching dedicated Chrome window on port ${debugPort}...`);
    const chromeArgs = buildChromeLaunchArgs(debugPort, config.userDataDir, config.qxUrl);
    const chromeProc = spawn(config.chromePath, chromeArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    chromeProc.on('error', () => {});
    chromeProc.unref();
    spawnedChromePid = chromeProc.pid ?? null;

    // Wait up to 20s for Chrome's CDP port to come online
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((r) => setTimeout(r, 800));
      connected = await tryConnectToExistingChrome(debugPort, config.qxUrl, onPageCreated);
      if (connected) break;
    }
  }

  if (connected) {
    const { browser, context, page } = connected;

    await page
      .waitForSelector('canvas, .chart-container, .OmOPV, input[type="password"], #challenge-running', {
        timeout: 15000,
      })
      .catch(() => {});
    await page.waitForTimeout(1200);

    const status = await inspectPageStatus(page);
    if (status.isCloudflareBlocked) {
      console.log('\n------------------------------------------------------');
      console.log('>>> [CLOUDFLARE VERIFICATION REQUIRED] Complete the security check in Chrome.');
      console.log(`>>> Current URL: ${status.currentUrl}`);
      console.log('------------------------------------------------------\n');
    } else if (status.isAuthenticated) {
      console.log(`\n>>> [STATUS: LOGGED IN] Authenticated Quotex Trading Room active!`);
      console.log(`>>> Current URL: ${status.currentUrl}\n`);
    } else {
      console.log('\n------------------------------------------------------');
      console.log('>>> [ACTION REQUIRED] Please log into your Quotex account in Chrome.');
      console.log(`>>> Current URL: ${status.currentUrl}`);
      console.log('------------------------------------------------------\n');
    }

    const exitGuard = config.closeChromeOnExit
      ? startWindowsChromeExitGuard(process.pid, config.userDataDir)
      : null;

    let closedOnce = false;
    const closeBrowser = async () => {
      if (closedOnce) return;
      closedOnce = true;

      if (!config.closeChromeOnExit) {
        return;
      }

      try {
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send('Browser.close');
      } catch {
        // Fallback: terminate only our spawned Chrome PID if CDP Browser.close failed
        if (spawnedChromePid && process.platform === 'win32') {
          try {
            spawn('taskkill', ['/PID', String(spawnedChromePid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
          } catch {}
        }
      }

      if (exitGuard?.pid) {
        try {
          process.kill(exitGuard.pid);
        } catch {}
      }
    };

    return {
      context,
      page,
      isExternalChrome: true,
      closeChromeOnExit: config.closeChromeOnExit,
      closeBrowser,
    };
  }

  // Fallback: Playwright persistent context if system Chrome executable was not found
  console.log('[Browser] Falling back to Playwright persistent context...');
  cleanStaleProfileLocks(config.userDataDir);

  const context = await chromium.launchPersistentContext(config.userDataDir, {
    executablePath: fs.existsSync(config.chromePath) ? config.chromePath : undefined,
    headless: config.headless,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    chromiumSandbox: true,
    args: ['--start-maximized', '--window-position=0,0', '--no-default-browser-check', '--no-first-run'],
  });

  await context.addInitScript(() => {
    try {
      Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
        get: () => undefined,
      });
    } catch {}
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  if (onPageCreated) {
    await onPageCreated(page);
  }

  try {
    await page.goto(config.qxUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
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

  return {
    context,
    page,
    isExternalChrome: false,
    closeChromeOnExit: config.closeChromeOnExit,
    closeBrowser: async () => {
      await context.close().catch(() => {});
    },
  };
}

/**
 * Checks if the current page URL represents an authenticated trading room.
 */
export function checkSessionStatus(url: string): SessionStatus {
  const isAuth =
    (url.includes('/trade') || url.includes('/demo-trade')) && !url.includes('/sign-in') && !url.includes('__cf_chl');
  return {
    isAuthenticated: isAuth,
    currentUrl: url,
  };
}
