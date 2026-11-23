# QX TS: Quotex Analytics, Backtester & Trading Assistant

A TypeScript & Playwright trading assistant, candle recorder, offline walk-forward backtester, and SQLite performance journal for Quotex. Attaches via Chrome DevTools Protocol (CDP port `9222`) to a visible Google Chrome window running a dedicated profile (`./qx_user_profile`).

---

## Architecture Overview

* **Persistent Chrome Harness (`src/browser/launcher.ts`)**: Attaches via CDP port `9222` to a visible Chrome window (`./qx_user_profile`), preserving cookies, 2FA, and Cloudflare clearance.
* **Redux Bridge & Platform Health Check (`src/browser/reduxBridge.ts`, `src/browser/quotexController.ts`, `src/browser/signalHud.ts`)**: Centralizes Quotex React Fiber / Redux inspection, strictly separates chart candle timeframe (`graph.chartPeriod` / `.NDbAT .HgaSf`) from deal expiry duration (`graph.timePeriod`), verifies stake (`graph.dealValue`) and expiry updates in Redux before clicking, and runs a DOM/Redux health check before trade execution.
* **Dual-Layer Stream & Screen Telemetry (`src/stream/wsSniffer.ts`, `src/stream/screenTelemetry.ts`, `src/stream/wsParser.ts`)**: Passively intercepts Socket.IO WebSocket frames and throttled Redux telemetry with frame deduplication, exact per-deal `percentProfit` extraction, and clean resource teardown.
* **Persistent Multi-Timeframe Candle Aggregator (`src/stream/candleAggregator.ts`)**: Merges live ticks and historical `historyPoints` by timestamp without overwriting prior history, and automatically archives closed candles into SQLite (`data/qx_trading.db`) so datasets grow across sessions.
* **Leak-Free Signal & Walk-Forward Calibration Engine (`src/analysis/signalEngine.ts`, `src/analysis/binaryMath.ts`)**:
  * Evaluates 3 playbooks (`EMA Pullback`, `Momentum Channel`, `Exhaustion Fade`) across 3 indicator profiles (`FAST`, `STANDARD`, `SMOOTH`) and multi-candle horizons using O(N) precomputed series.
  * Selects the top candidate **strictly on the Training split (60%)** ranked by Bonferroni-adjusted Wilson lower bound — **zero Out-of-Sample (OOS) peeking during selection**.
  * Evaluates only the single Train winner **once on the untouched Holdout OOS split (40%)** and classifies edge honestly into `PROVEN_EDGE` (`>= 30` OOS trades and 95% Wilson lower bound > break-even), `PRELIMINARY` (smaller OOS sample clearing 1-sigma lower bound; explicitly labeled unproven), or `NO_EDGE`.
  * Replaces arbitrary conviction scores with Empirical Bayes shrunk win-probability estimates and Expected Value (EV) per `$1` staked.
* **Symmetric Risk Controls & LIVE Safety Gate (`src/engine/riskManager.ts`, `src/cli/startupPrompt.ts`)**:
  * Enforces **both** a session profit goal **and** hard loss stops: Max Session Loss, persistent Max Daily Loss (across restarts via SQLite), Max Trades per Session, and Global Consecutive Loss Circuit Breaker.
  * Blocks LIVE auto-trading by default until the SQLite journal records at least **300 settled demo trades** with a statistically `PROVEN_EDGE` verdict (or an explicit typed risk override).
  * Includes an OTC market toggle with counterparty-feed warnings.
* **Offline Rolling Walk-Forward Backtester (`src/analysis/backtester.ts`)**: Runs rolling out-of-sample walk-forward simulations over SQLite-archived candles, external OHLC CSV files, or live Chrome chart history, complete with Bonferroni multiple-testing p-values, max drawdown, losing streaks, and a sign-flipped random-walk Monte Carlo baseline.

---

## Quick Start

### 1. Launch Dedicated Chrome & Bot (Windows)
Double-click `START_QX_BOT.bat` or run directly from any terminal:

```bash
npm start
```

The bot automatically launches a dedicated Google Chrome window using `./qx_user_profile` (completely isolated from your personal Chrome) on CDP port `9222`. By default (`CLOSE_CHROME_ON_EXIT=true`), closing the terminal (`Ctrl+C` or the window's `X` button) also closes the dedicated bot Chrome window cleanly. Set `CLOSE_CHROME_ON_EXIT=false` in `.env` if you prefer Chrome to stay open across bot restarts.

### 2. First-Time Login
* Sign into your Quotex **Demo** account in Chrome and complete any Cloudflare check.
* Your session stays in `./qx_user_profile`.

### 3. Operating Modes
On startup, the CLI prompts for:
1. **Account (`DEMO` vs `LIVE`)**
2. **Operating Mode (`MANUAL` vs `AUTO`)**
3. **Market Feed (`All including OTC` vs `Exchange-backed Live only`)**
4. **Risk Limits (AUTO mode)**: Stake, Hard Max Session Loss, Hard Max Daily Loss, and Session Profit Goal.

---

## Backtesting & Performance Journal

### Offline Walk-Forward Backtester
Pull live chart history from your open Chrome window, archive it to SQLite, and run a rolling walk-forward backtest:

```bash
npm run backtest -- --pull-chrome
```

Backtest all archived candle series in SQLite (`data/qx_trading.db`) or an external OHLC CSV file:

```bash
npm run backtest
npm run backtest -- --csv path/to/EURUSD_M5.csv --asset EURUSD --tf 300 --payout 85 --save
```

### Trade Journal Report
Inspect your recorded trade history, separate Demo/Live performance, regime breakdown, LIVE readiness gate status, and archived candle counts (or double-click `VIEW_REPORT.bat`):

```bash
npm run journal:report
```

---

## Development & Tests

```bash
npm run typecheck
npm test
```

---

## Statistical Reality Check
Binary options are negative-sum fixed-odds bets: at an 85% payout you must win **54.05%** of trades just to break even. OTC prices are generated by the broker, who is also your counterparty. Automated trading also violates Quotex's Terms of Service and can result in account restrictions or withheld withdrawals. Always test on **Demo** and backtest over thousands of candles before risking real money.
