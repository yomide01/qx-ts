/**
 * A single "live" line at the bottom of the screen that is redrawn in place.
 *
 * The old version wrote the status with a bare carriage return, so any other message printed
 * while it was showing ended up glued onto the end of it, and a line longer than the window
 * wrapped and left stray copies behind. This keeps the status to one line that never wraps,
 * and wipes it before any other message is printed.
 */
export function fitStatusLine(text: string, columns: number): string {
  const width = Math.max(20, columns - 1);
  const trimmed = text.length > width ? text.slice(0, width - 1) + '…' : text;
  return trimmed.padEnd(width);
}

export interface StatusOutput {
  write(text: string): unknown;
  columns?: number;
}

export class StatusLine {
  private visible = false;

  constructor(private out: StatusOutput = process.stdout) {}

  public show(text: string): void {
    this.out.write('\r' + fitStatusLine(text, this.out.columns ?? 80));
    this.visible = true;
  }

  /** Erases the status line (if it is showing) so the next message starts on a clean line. */
  public clear(): void {
    if (!this.visible) return;
    const width = Math.max(20, (this.out.columns ?? 80) - 1);
    this.out.write('\r' + ' '.repeat(width) + '\r');
    this.visible = false;
  }
}

/** Makes every console.log / warn / error wipe the status line first. */
export function installCleanConsole(status: StatusLine): void {
  for (const method of ['log', 'warn', 'error'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      status.clear();
      original(...args);
    };
  }
}
