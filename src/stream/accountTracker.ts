import { AccountMode } from './types.js';

export type AccountSource = 'page address' | 'Quotex request' | 'screen label';

/**
 * Decides whether you are on the DEMO or LIVE account.
 *
 * Three independent clues feed it. The rule is simple: the clue that CHANGED most recently
 * wins. That way it does not matter whether Quotex switches accounts by changing the page
 * address, by sending an "account/change" message, or both - whichever happened last is the
 * truth. The on-screen label is only a last resort when nothing else is known.
 */
export class AccountModeTracker {
  private url: { mode: AccountMode; at: number } = { mode: 'UNKNOWN', at: 0 };
  private request: { mode: AccountMode; at: number } = { mode: 'UNKNOWN', at: 0 };
  private screen: AccountMode = 'UNKNOWN';
  private lastSource: AccountSource = 'page address';

  /** Returns true if the overall answer changed. */
  public update(source: AccountSource, mode: AccountMode, now: number = Date.now()): boolean {
    const before = this.current();
    if (source === 'screen label') {
      this.screen = mode;
    } else {
      const slot = source === 'page address' ? this.url : this.request;
      if (mode !== slot.mode || (mode !== 'UNKNOWN' && mode !== before)) {
        slot.mode = mode;
        slot.at = now;
      }
      if (mode !== 'UNKNOWN') this.lastSource = source;
    }
    return this.current() !== before;
  }

  public current(): AccountMode {
    const candidates = [this.url, this.request].filter((s) => s.mode !== 'UNKNOWN');
    if (candidates.length === 0) return this.screen;
    // Most recently changed wins; on an exact tie the explicit Quotex request wins.
    candidates.sort((a, b) => b.at - a.at || (b === this.request ? 1 : -1));
    return candidates[0].mode;
  }

  public source(): AccountSource {
    const cur = this.current();
    if (cur === 'UNKNOWN') return 'screen label';
    if (cur === this.screen && this.url.mode === 'UNKNOWN' && this.request.mode === 'UNKNOWN') return 'screen label';
    return this.request.mode === cur && (this.request.at >= this.url.at || this.url.mode !== cur)
      ? 'Quotex request'
      : 'page address';
  }
}
