/**
 * Asset-name handling shared by the whole bot.
 *
 * Quotex describes the same market in several different ways:
 *   WebSocket symbol : "EURGBP_otc"
 *   Instruments list : "EUR/GBP (OTC)"
 *   Chart header text: "EUR/GBP OTC"
 * If those are not turned into ONE canonical form, price ticks, candles and payouts
 * end up stored under different keys and the bot silently loses track of the market
 * you switched to. Everything goes through normalizeAsset() so they all match.
 *
 * Canonical form: upper-case letters/digits, with "_OTC" appended for OTC markets.
 *   "EURGBP"          -> "EURGBP"
 *   "EURGBP_otc"      -> "EURGBP_OTC"
 *   "EUR/GBP (OTC)"   -> "EURGBP_OTC"
 *   "Notcoin (OTC)"   -> "NOTCOIN_OTC"   (a plain "otc" inside a name is NOT treated as OTC)
 */
const OTC_SUFFIX = /(^|[\s_(\-])otc\)?\s*$/i;

export function normalizeAsset(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  const isOtc = OTC_SUFFIX.test(s);
  if (isOtc) s = s.replace(OTC_SUFFIX, '');
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  return isOtc ? `${s}_OTC` : s;
}

export function isOtcAsset(asset: string): boolean {
  return asset.endsWith('_OTC');
}

/**
 * Remembers how Quotex names each market so a name read from the screen can be
 * matched back to the symbol used on the data stream.
 */
export class AssetRegistry {
  private byDisplayName = new Map<string, string>();
  private known = new Set<string>();

  learn(symbol: string, displayName?: string): void {
    const canonical = normalizeAsset(symbol);
    if (!canonical) return;
    this.known.add(canonical);
    if (displayName) {
      const key = normalizeAsset(displayName);
      if (key) this.byDisplayName.set(key, canonical);
    }
  }

  /** Turns whatever text we found (symbol or on-screen name) into the canonical symbol. */
  resolve(text: unknown): string {
    const key = normalizeAsset(text);
    if (!key) return '';
    return this.byDisplayName.get(key) ?? key;
  }

  isKnown(asset: string): boolean {
    return this.known.has(asset);
  }

  markSeen(asset: string): void {
    if (asset) this.known.add(asset);
  }
}
