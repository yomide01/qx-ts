# QX TS: Quotex Semi-Automated Trading Assistant

A TypeScript & Playwright-based trading companion built with human-in-the-loop confirmation, persistent session management, and passive stream monitoring.

---

## Architecture Overview

* **Phase 1 (Completed)**: Persistent Browser Profile & Anti-Detection Harness.
* **Phase 2 (Completed)**: WebSocket & Live Price Stream Interceptor.
* **Phase 3 (Completed)**: Trade Outcome Journal & SQLite Analytics Database.
* **Phase 4 (Completed)**: Mathematical Indicator & Setup Analysis Engine (EMA, RSI, Rejections).
* **Phase 5 (Completed)**: Interactive Terminal / Desktop Alert Confirmation System.

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
