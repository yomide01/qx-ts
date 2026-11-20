# QX TS: Quotex Semi-Automated Trading Assistant

A TypeScript & Playwright-based trading companion built with human-in-the-loop confirmation, persistent session management, and passive stream monitoring.

---

## Architecture Overview

* **Phase 1 (Completed)**: Persistent Browser Profile & Anti-Detection Harness.
* **Phase 2 (Completed)**: WebSocket & Live Price Stream Interceptor.
* **Phase 3 (Completed)**: Trade Outcome Journal & SQLite Analytics Database.
* **Phase 4 (Completed)**: Mathematical Indicator & Setup Analysis Engine (EMA, RSI, Rejections).
* **Phase 5 (Completed)**: Interactive Terminal / Desktop Alert Confirmation System.
* **Phase 6 (Completed)**: Market-switch tracking, Demo/Live account detection, and honest binary-options maths.

---

## Phase 1: How the Persistent Browser Session Works

Instead of storing passwords in plaintext or using brittle auto-login scripts that get flagged by Cloudflare:
1. The script launches your installed **Google Chrome** (`C:\Program Files\Google\Chrome\Application\chrome.exe`).
2. It attaches to a local profile folder: `./qx_user_profile`.
3. It disables automation flags (`--disable-blink-features=AutomationControlled`, removes `enable-automation` banners).
4. **First time**: You log in manually once in the opened Chrome window.
5. **Subsequent runs**: Your cookies, local tokens, and 2FA credentials remain preserved in `./qx_user_profile`. The script opens directly to the authenticated trading room without triggering bot detection.

---

## Quick Start

### 1. Launch the Browser Harness
```bash
npm run browser:init
```

### 2. What to do on first launch
* The browser will open to Quotex.
* Sign into your account (Demo or Live).
* Once you are in the trading room, the terminal will display:
  `[Session Watcher] Trading Room detected: https://.../trade`
* You can now close the browser or press `Ctrl+C` in the terminal. Your login is permanently stored in `./qx_user_profile`.

---

## Phase 2: Live Stream & Sniffer Test

Once logged in, you can run the passive stream listener:

```bash
npm run stream:test
```

This will:
1. Re-open your saved browser session.
2. Passively intercept real-time WebSocket frames without modifying or injecting code into Quotex.
3. Display live ticks, real-time asset payout percentages ($\ge 80\%$), account balance, and M1/M5 candle closes in your terminal.

---

## Phase 3: Trade Journal & Performance Analytics

To inspect your trading analytics dashboard at any time:

```bash
npm run journal:report
```

This will:
* Calculate overall win rate, win rate on Live pairs vs. OTC pairs.
* Calculate your broker breakeven win rate based on real payout percentages.
* Compute Expected Value (EV) per trade.
* Break down performance by asset and market regime.
* Provide automated self-learning recommendations based on your historical edge.

---

## Phase 5: Complete Semi-Automated Trading Assistant

### 1. Test the Alert & Countdown Prompt (Dry Run)
To see how signals look and sound before running live:
```bash
npm run prompt:test
```

### 2. Launch the Full Bot
```bash
npm start
```

### How the Live Session Operates:
1. Opens your saved Google Chrome session directly to Quotex.
2. Passively streams ticks, dynamic payouts, and deals via WebSocket.
3. Automatically computes EMAs, Wilder's RSI, Bollinger Bands, and Rejection Wicks.
4. When a $\ge 70\%$ confidence setup is found 30–45s before the 5M candle open:
   - Sounds an audible alert beep.
   - Prints the full confluence breakdown and win probability.
   - Counts down live until the exact candle open timestamp.
   - Asks for your confirmation: `Press [Y] to ARM / [N] to SKIP`.
5. When you confirm and enter the trade on Quotex:
   - The trade watcher catches your deal and attaches the signal confidence and indicator snapshot into `./data/qx_trading.db`.
   - When the trade closes, it logs your outcome (`WON` / `LOST`), PnL, and updates your historical analytics.

---

## Phase 6: Market switching, Demo/Live detection and honest maths

### The bot now follows the market on your chart
Quotex only streams prices for the market(s) you have open on your chart, so the bot can only
analyse those. Every name Quotex uses (`EURGBP_otc`, `EUR/GBP (OTC)`, `EUR/GBP OTC`) is now
turned into one key, so switching to any OTC or live market works. The screen shows:
`[Market] Now analysing GBPUSD_OTC ... M5 candles ready: 3/25`. A new market needs 25 five-minute
candles (about 2 hours of history) before signals can appear.

### The bot knows Demo from Live
It reads the page address (`/demo-trade` = demo, `/trade` = live), Quotex's own account data, and the
on-screen label, and reacts the moment you switch. The status line shows `[demo]` or `[LIVE!]`,
LIVE gets a red banner, and trades are journaled under the correct account. If it cannot tell, it
says `??` instead of guessing.

### If it reads the wrong market or account after a Quotex update
Run `npm run debug:dom` with Quotex open. It prints which page elements the bot can read.

### What the bot can and cannot do
Binary options are a fixed-odds bet: at an 85% payout you must win 54.05% of trades just to break even.
The bot's "setup score" is a rule score, **not** a win probability. It cannot predict Quotex markets:
OTC prices are produced by the broker, not a real market, and the live status line now reports
`Structure: coin-flip-like` when a market shows no exploitable pattern. `npm run journal:report`
now says whether your results are a real edge or could be luck. Test on a Demo account.

### Tests
`npm run test:unit` runs the market-switching, account-detection and maths tests.

---

## Strategy: EMA + RSI + Stochastic (5-minute candles)

The bot signals only when all three line up on closed M5 candles:

| | CALL (price UP) | PUT (price DOWN) |
|---|---|---|
| Trend | EMA 9 above EMA 21 | EMA 9 below EMA 21 |
| Momentum | RSI 40-70 and rising | RSI 30-60 and falling |
| Timing | Stochastic %K crosses UP through %D while %K < 40 | %K crosses DOWN through %D while %K > 60 |

Every signal states the direction and the **expiry (5 minutes)**, and lists the exact indicator values
that triggered it. This is the classic "buy the dip in an uptrend" rule set. It follows the rules
exactly; it cannot know the future, so judge it by your own Demo results (`npm run journal:report`).

## Protocol fixes (from studying pyquotex)
* Balance messages use the names `liveBalance` / `demoBalance` (both accounts in one message).
* The browser's own `account/change` / `authorization` messages are read (demo flag only, never the
  login session) so a Demo/Live switch is noticed instantly. The most recent clue always wins.
* Quotex keeps a separate payout per expiry length; a 5-minute trade now uses the 5-minute payout.
