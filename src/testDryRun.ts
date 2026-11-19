import { SignalPromptUI } from './ui/prompt.js';
import { TradingSignal } from './analysis/signalEngine.js';

async function testPrompt() {
  console.log('Testing Interactive Signal Alert & Countdown Prompt...\n');

  const promptUI = new SignalPromptUI();

  // Create a realistic sample signal scheduled 15 seconds from now
  const now = Date.now();
  const sampleSignal: TradingSignal = {
    asset: 'EUR/USD',
    isOtc: false,
    direction: 'CALL',
    timeframeSeconds: 300,
    entryTime: now + 15000,
    expiryTime: now + 15000 + 300000,
    confidence: 82,
    payoutPercent: 87,
    marketRegime: 'TRENDING_UP',
    reasons: [
      'Trend alignment: M5 Uptrend (EMA 9 > EMA 21)',
      'Prominent lower rejection wick (55% of candle)',
      'Price bounced off Lower Bollinger Band',
      'High payout tier (87%)',
    ],
    indicatorSnapshot: {
      rsi: 34.2,
      emaFast: 1.0545,
      emaSlow: 1.0540,
    },
  };

  const decision = await promptUI.promptUser(sampleSignal);
  console.log(`\nDecision Result: ${decision.confirmed ? 'CONFIRMED / ARMED' : 'SKIPPED'}\n`);
}

testPrompt().catch(console.error);
