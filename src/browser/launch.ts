import { launchBrowserSession } from './launcher.js';

async function main() {
  try {
    const { context, page } = await launchBrowserSession();

    console.log('[Runner] Browser session is active.');
    console.log('[Runner] Press Ctrl+C in this terminal when you wish to close the browser.\n');

    // Keep script alive until manually interrupted or browser closed
    page.on('close', () => {
      console.log('[Runner] Page closed by user.');
      process.exit(0);
    });

    context.on('close', () => {
      console.log('[Runner] Browser context closed.');
      process.exit(0);
    });

    // Handle clean termination
    process.on('SIGINT', async () => {
      console.log('\n[Runner] Shutting down browser session cleanly...');
      await context.close();
      process.exit(0);
    });
  } catch (error) {
    console.error('[Error] Failed to initialize browser harness:', error);
    process.exit(1);
  }
}

main();
