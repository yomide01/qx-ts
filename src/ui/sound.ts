import { exec } from 'child_process';

/**
 * Triggers an audible alert when a high-probability signal is detected.
 */
export function playAlertSound(): void {
  // 1. Standard terminal bell character
  process.stdout.write('\x07');

  // 2. On Windows, trigger system frequency beep asynchronously
  if (process.platform === 'win32') {
    exec('powershell -c "[System.Console]::Beep(900, 200); [System.Console]::Beep(1200, 300)"', () => {
      // Ignore background exec callbacks
    });
  }
}
