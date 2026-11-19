import readline from 'readline';
import { TradingSignal } from '../analysis/signalEngine.js';
import { playAlertSound } from './sound.js';
import { AccountMode } from '../stream/types.js';

export interface PromptDecision {
  confirmed: boolean;
  signal: TradingSignal;
}

export class SignalPromptUI {
  private activePrompt: boolean = false;

  /**
   * Displays an interactive countdown prompt for a detected trading signal.
   */
  public async promptUser(signal: TradingSignal, accountMode: AccountMode = 'UNKNOWN'): Promise<PromptDecision> {
    if (this.activePrompt) {
      console.log(`[Prompt] An active prompt is already awaiting decision. Skipping secondary alert for ${signal.asset}.`);
      return { confirmed: false, signal };
    }

    this.activePrompt = true;
    playAlertSound();

    const isCall = signal.direction === 'CALL';
    const directionColor = isCall ? '\x1b[32m' : '\x1b[31m'; // Green for CALL, Red for PUT
    const resetColor = '\x1b[0m';
    const bold = '\x1b[1m';
    const cyan = '\x1b[36m';
    const yellow = '\x1b[33m';

    console.log('\n');
    console.log(`${cyan}╔════════════════════════════════════════════════════════════════════╗${resetColor}`);
    console.log(`${cyan}║${bold}                  SETUP DETECTED (not a guaranteed win)            ${cyan}║${resetColor}`);
    console.log(`${cyan}╠════════════════════════════════════════════════════════════════════╣${resetColor}`);
    console.log(`${cyan}║${resetColor} Asset      : ${bold}${signal.asset.padEnd(16)}${resetColor} (${signal.isOtc ? 'OTC' : 'Live'}) ${' '.repeat(34)} ${cyan}║${resetColor}`);
    console.log(
      `${cyan}║${resetColor} Direction  : ${directionColor}${bold}${signal.direction.padEnd(5)} (${isCall ? 'GREEN / UP' : 'RED / DOWN'})${resetColor}${' '.repeat(
        36 - (isCall ? 12 : 10)
      )}${cyan}║${resetColor}`
    );
    console.log(
      `${cyan}║${resetColor} Entry Time : ${yellow}${new Date(signal.entryTime).toLocaleTimeString()}${resetColor} (Expiry: ${new Date(
        signal.expiryTime
      ).toLocaleTimeString()}) ${' '.repeat(24)}${cyan}║${resetColor}`
    );
    const accountLabel =
      accountMode === 'LIVE' ? '\x1b[41m\x1b[97m LIVE - REAL MONEY \x1b[0m' : accountMode === 'DEMO' ? 'DEMO' : 'UNKNOWN (check Quotex!)';
    console.log(
      `${cyan}║${resetColor} Setup score: ${bold}${signal.confidence}${resetColor} (rule score, NOT a win probability) | Payout: ${bold}${signal.payoutPercent}%${resetColor}`
    );
    console.log(`${cyan}║${resetColor} Account    : ${accountLabel}`);
    console.log(`${cyan}║${resetColor} Regime     : ${signal.marketRegime.padEnd(53)}${cyan}║${resetColor}`);
    console.log(`${cyan}╠════════════════════════════════════════════════════════════════════╣${resetColor}`);
    console.log(`${cyan}║${resetColor} Confluence Reasons: ${' '.repeat(45)}${cyan}║${resetColor}`);
    for (const r of signal.reasons) {
      console.log(`${cyan}║${resetColor} • ${r.padEnd(63)}${cyan}║${resetColor}`);
    }
    console.log(`${cyan}╚════════════════════════════════════════════════════════════════════╝${resetColor}\n`);

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      let resolved = false;

      // Timer countdown loop
      const interval = setInterval(() => {
        const remainingSeconds = Math.max(0, Math.round((signal.entryTime - Date.now()) / 1000));
        process.stdout.write(`\r>>> Time until candle open: [ ${yellow}${remainingSeconds}s${resetColor} ] | Press [Y] to ARM / [N] to SKIP: `);

        if (remainingSeconds <= 0 && !resolved) {
          resolved = true;
          clearInterval(interval);
          rl.close();
          this.activePrompt = false;
          console.log('\n[Prompt] Time window elapsed. Trade signal expired.');
          resolve({ confirmed: false, signal });
        }
      }, 1000);

      rl.question('', (answer) => {
        if (!resolved) {
          resolved = true;
          clearInterval(interval);
          rl.close();
          this.activePrompt = false;

          const trimmed = answer.trim().toLowerCase();
          const confirmed = trimmed === 'y' || trimmed === 'yes' || trimmed === '';

          if (confirmed) {
            console.log(`\n>>> ${bold}\x1b[32mTRADE ARMED! Enter the ${signal.direction} trade on ${signal.asset} now.${resetColor}`);
          } else {
            console.log(`\n>>> Trade skipped by user.`);
          }

          resolve({ confirmed, signal });
        }
      });
    });
  }
}
