export function formatClockHHMM(timestampMs: number, includeSeconds: boolean = false): string {
  const d = new Date(timestampMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!includeSeconds) return `${hh}:${mm}`;
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatPairDisplay(asset: string, rawName?: string): string {
  if (rawName && rawName.includes('/')) return rawName;
  const isOtc = asset.endsWith('_OTC');
  const base = asset.replace(/_OTC$/i, '');
  if (base.length === 6) {
    return `${base.slice(0, 3)}/${base.slice(3)}${isOtc ? ' (OTC)' : ''}`;
  }
  return isOtc ? `${base} (OTC)` : base;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
