import { Page } from 'playwright';

export interface BrowserSignalAlertPayload {
  asset: string;
  displayPair?: string;
  direction: 'CALL' | 'PUT';
  timeframeSeconds: number;
  entryTimeStr?: string;
  expiryTimeStr?: string;
  /** Honest shrunk win-probability estimate (0-100), NOT fake confluence. */
  estimatedWinProb: number;
  expectedValuePerDollar?: number;
  tierLabel?: string;
  payoutPercent: number;
  reasons: string[];
}

function formatExpiryClock(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatTfLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return '1d';
}

/**
 * Plays an in-browser Web Audio API chime + Web Speech announcement and displays a
 * floating HUD card on the Quotex chart with honest statistical metrics (OOS tier,
 * shrunk win probability, and expected value).
 */
export async function showInBrowserSignalAlert(page: Page, signal: BrowserSignalAlertPayload): Promise<void> {
  if (page.isClosed()) return;
  const tfLabel = formatTfLabel(signal.timeframeSeconds);
  const expiryClock = formatExpiryClock(signal.timeframeSeconds);
  const now = new Date();
  const entryClock =
    signal.entryTimeStr ||
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const expDate = new Date(now.getTime() + signal.timeframeSeconds * 1000);
  const toClock =
    signal.expiryTimeStr ||
    `${String(expDate.getHours()).padStart(2, '0')}:${String(expDate.getMinutes()).padStart(2, '0')}`;

  const evText =
    signal.expectedValuePerDollar !== undefined
      ? `EV: ${signal.expectedValuePerDollar >= 0 ? '+' : ''}$${signal.expectedValuePerDollar.toFixed(3)}/$1`
      : '';

  const payload = {
    asset: signal.displayPair || signal.asset,
    direction: signal.direction,
    tfLabel,
    expiryClock,
    entryClock,
    toClock,
    estimatedWinProb: signal.estimatedWinProb.toFixed(1),
    evText,
    tierLabel: signal.tierLabel || 'PRELIMINARY [UNPROVEN]',
    payoutPercent: signal.payoutPercent,
    reasons: signal.reasons.slice(0, 4),
  };

  try {
    await page.evaluate(`((data) => {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          if (!window.__qxAudioCtx) {
            window.__qxAudioCtx = new AudioCtx();
          }
          const ctx = window.__qxAudioCtx;
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          const playTone = (freq, startSec, durSec) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + startSec);
            gain.gain.setValueAtTime(0.65, ctx.currentTime + startSec);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startSec + durSec);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + startSec);
            osc.stop(ctx.currentTime + startSec + durSec);
          };
          if (data.direction === 'CALL') {
            playTone(659.25, 0.0, 0.16);
            playTone(880.0, 0.18, 0.16);
            playTone(1046.5, 0.36, 0.35);
          } else {
            playTone(987.77, 0.0, 0.16);
            playTone(783.99, 0.18, 0.16);
            playTone(587.33, 0.36, 0.35);
          }
        }

        if (window.speechSynthesis) {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(
            'Signal: ' +
              data.asset.replace('_OTC', ' O T C').replace('(OTC)', 'O T C').replace('/', ' ') +
              ', ' +
              data.entryClock +
              ', ' +
              (data.direction === 'CALL' ? 'CALL UP' : 'PUT DOWN') +
              ', Time to ' +
              data.toClock
          );
          u.volume = 1.0;
          u.rate = 1.02;
          window.speechSynthesis.speak(u);
        }

        if ('Notification' in window) {
          if (Notification.permission === 'granted') {
            new Notification(data.asset + '; ' + data.entryClock + '; ' + data.direction, {
              body: 'TIME TO ' + data.toClock + ' (' + data.tfLabel + ' | Payout: ' + data.payoutPercent + '% | ' + data.tierLabel + ')',
            });
          } else if (Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
          }
        }

        const existing = document.getElementById('qx-ts-signal-hud');
        if (existing) existing.remove();

        const hud = document.createElement('div');
        hud.id = 'qx-ts-signal-hud';
        const isCall = data.direction === 'CALL';
        const accent = isCall ? '#0FAF59' : '#FF6251';
        const badge = isCall ? 'CALL (UP)' : 'PUT (DOWN)';
        hud.style.cssText = [
          'position:fixed',
          'top:98px',
          'left:50%',
          'transform:translateX(-50%)',
          'z-index:999999',
          'background:rgba(15, 22, 34, 0.97)',
          'border:2px solid ' + accent,
          'border-radius:12px',
          'padding:14px 22px',
          'color:#ffffff',
          'font-family:system-ui,-apple-system,sans-serif',
          'box-shadow:0 12px 36px rgba(0,0,0,0.75)',
          'cursor:pointer',
          'min-width:340px',
          'max-width:540px',
          'text-align:left',
        ].join(';');

        const escapeHtml = (s) =>
          String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const reasonsHtml = (data.reasons || [])
          .map((r) => '<div style="font-size:11px;color:#cbd5e1;margin-top:2px">&bull; ' + escapeHtml(r) + '</div>')
          .join('');

        hud.innerHTML =
          '<div style="font-size:17px;font-weight:800;letter-spacing:0.3px;color:#ffffff">' +
          escapeHtml(data.asset) +
          '; ' +
          escapeHtml(data.entryClock) +
          '; <span style="color:' +
          accent +
          '">' +
          badge +
          '</span></div>' +
          '<div style="font-size:14px;font-weight:700;margin-top:6px;color:#f8fafc">TIME TO ' +
          escapeHtml(data.toClock) +
          ' &nbsp;<span style="font-size:12px;font-weight:500;color:#94a3b8">(' +
          escapeHtml(data.tfLabel) +
          ' Expiry | Payout: ' +
          escapeHtml(data.payoutPercent) +
          '% | Est Prob: ' +
          escapeHtml(data.estimatedWinProb) +
          '%' +
          (data.evText ? ' | ' + escapeHtml(data.evText) : '') +
          ' | ' +
          escapeHtml(data.tierLabel) +
          ')</span></div>' +
          '<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.12)">' +
          reasonsHtml +
          '</div>';

        hud.onclick = () => hud.remove();
        document.body.appendChild(hud);
        setTimeout(() => {
          if (hud.parentElement) hud.remove();
        }, 30000);
      } catch (e) {}
    })(${JSON.stringify(payload)})`);
  } catch {}
}
