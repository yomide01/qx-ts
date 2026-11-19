/**
 * WS Frame Debugger — Run this ONCE to capture raw Quotex WebSocket messages.
 * This tells us the EXACT event names and data shapes Quotex uses, so the
 * parser can be tuned to match them precisely.
 *
 * Usage: npm run debug:ws
 * Output: data/ws_frames_captured.jsonl (one JSON object per line)
 */
import { launchBrowserSession } from '../browser/launcher.js';
import { QxWsSniffer } from './wsSniffer.js';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('====================================================');
  console.log('  QUOTEX WEBSOCKET RAW FRAME DEBUGGER               ');
  console.log('  Capturing ALL frames to: data/ws_frames_captured.jsonl');
  console.log('  Let it run for 30-60 seconds then press Ctrl+C   ');
  console.log('====================================================\n');

  const outputPath = path.resolve(process.cwd(), 'data', 'ws_frames_captured.jsonl');
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const writeStream = fs.createWriteStream(outputPath, { flags: 'a' });
  let frameCount = 0;
  let parsedCount = 0;

  const sniffer = new QxWsSniffer();

  const { context, page } = await launchBrowserSession(async (p) => {
    // Hook BEFORE navigation to catch everything

    // Playwright native WS frames
    p.on('websocket', (ws) => {
      console.log(`[WS] New WebSocket opened: ${ws.url()}`);

      ws.on('framereceived', ({ payload }) => {
        frameCount++;
        const text = typeof payload === 'string' ? payload : payload.toString('utf-8');

        // Skip pure heartbeat frames
        if (text === '2' || text === '3') return;

        const record = {
          ts: Date.now(),
          source: 'playwright',
          url: ws.url(),
          rawLength: text.length,
          raw: text.length > 2000 ? text.slice(0, 2000) + '...[TRUNCATED]' : text,
        };

        writeStream.write(JSON.stringify(record) + '\n');

        // Print non-heartbeat frames to terminal
        if (text.length < 500) {
          console.log(`[FRAME #${frameCount}] ${text}`);
        } else {
          console.log(`[FRAME #${frameCount}] (${text.length} chars) ${text.slice(0, 150)}...`);
        }
      });

      ws.on('framesent', ({ payload }) => {
        const text = typeof payload === 'string' ? payload : payload.toString('utf-8');
        if (text === '2' || text === '3') return;
        console.log(`[SENT→] ${text.length < 300 ? text : text.slice(0, 150) + '...'}`);
      });
    });

    // Also enable debug mode on sniffer
    sniffer.debugMode = true;
    sniffer.on('raw', (msg) => {
      parsedCount++;
      console.log(`\n✅ [PARSED EVENT #${parsedCount}] Name: "${msg.eventName}" | Data: ${JSON.stringify(msg.data).slice(0, 300)}`);
    });

    await sniffer.attachToPage(p);
  });

  console.log('\n[Debug] Watching frames... interact with Quotex (change assets, check balance, make a demo trade)');
  console.log('[Debug] The more you do in the browser, the more data we capture.\n');

  const heartbeat = setInterval(() => {
    console.log(`[Debug] Total WS frames received: ${frameCount} | Parsed by engine: ${parsedCount}`);
  }, 10000);

  process.on('SIGINT', async () => {
    clearInterval(heartbeat);
    writeStream.end();
    console.log(`\n[Debug] Session ended. Captured ${frameCount} frames.`);
    console.log(`[Debug] Frames saved to: ${outputPath}`);
    console.log('[Debug] Share this file so the parser can be tuned to Quotex\'s actual protocol.\n');
    await context.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Debug Error]', err);
  process.exit(1);
});
