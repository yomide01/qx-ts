import { spawn } from 'child_process';

/**
 * Encodes a PowerShell script as UTF-16LE Base64 for `-EncodedCommand`.
 * Avoids cmd.exe shell parsing and quoting issues completely.
 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Builds safe PowerShell spawn arguments.
 *
 * CRITICAL WINDOWS FIX:
 * NEVER pass `-WindowStyle Hidden` to powershell.exe spawned from a console app!
 * When a child PowerShell inherits a console window, `-WindowStyle Hidden` calls
 * Win32 `ShowWindow(GetConsoleWindow(), SW_HIDE)` on the PARENT terminal window,
 * making the user's bot terminal vanish off-screen while continuing to run invisibly.
 * Instead, Node's `spawn(..., { windowsHide: true, detached: true, stdio: 'ignore' })`
 * spawns a detached windowless child process (`CREATE_NO_WINDOW`) that never touches
 * the parent terminal.
 */
export function buildAlertSpawnArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)];
}

/**
 * Triggers an audible PC sound alert, spoken voice announcement, and a Windows Desktop
 * pop-up notification (System Tray Balloon) when a trading signal or trade executes.
 */
export function playAlertSound(
  voiceAnnouncement?: string,
  notificationTitle?: string,
  notificationBody?: string
): void {
  // 1. Standard terminal bell character
  try {
    process.stdout.write('\x07');
  } catch {
    // Ignore if stdout is closed
  }

  if (process.platform !== 'win32') return;

  const clean = (s?: string) =>
    (s || '')
      .replace(/['"`$]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const cleanVoice = clean(voiceAnnouncement);
  const cleanTitle = clean(notificationTitle || 'QX TS SIGNAL');
  const cleanBody = clean(notificationBody || cleanVoice || 'Trading event triggered on Quotex');

  const psScript = [
    `try {`,
    `  [System.Media.SystemSounds]::Exclamation.Play()`,
    `  if (Test-Path 'C:\\Windows\\Media\\Alarm01.wav') {`,
    `    (New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav').Play()`,
    `  } elseif (Test-Path 'C:\\Windows\\Media\\Ring01.wav') {`,
    `    (New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\Ring01.wav').Play()`,
    `  } elseif (Test-Path 'C:\\Windows\\Media\\notify.wav') {`,
    `    (New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\notify.wav').Play()`,
    `  }`,
    `} catch {}`,
    `try {`,
    `  Add-Type -AssemblyName System.Windows.Forms`,
    `  Add-Type -AssemblyName System.Drawing`,
    `  $notify = New-Object System.Windows.Forms.NotifyIcon`,
    `  $notify.Icon = [System.Drawing.SystemIcons]::Information`,
    `  $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info`,
    `  $notify.BalloonTipTitle = '${cleanTitle}'`,
    `  $notify.BalloonTipText = '${cleanBody}'`,
    `  $notify.Visible = $true`,
    `  $notify.ShowBalloonTip(8000)`,
    `} catch {}`,
    cleanVoice
      ? [
          `try {`,
          `  Add-Type -AssemblyName System.Speech`,
          `  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
          `  $s.Volume = 100`,
          `  $s.Rate = 1`,
          `  $s.Speak('${cleanVoice}')`,
          `} catch {}`,
        ].join('\n')
      : `Start-Sleep -Seconds 2`,
    `try {`,
    `  if ($notify) {`,
    `    Start-Sleep -Seconds 3`,
    `    $notify.Dispose()`,
    `  }`,
    `} catch {}`,
  ].join('\n');

  try {
    const child = spawn('powershell.exe', buildAlertSpawnArgs(psScript), {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      // Non-fatal if powershell.exe cannot be launched
    });
    child.unref();
  } catch {
    // Non-fatal background alert error
  }
}
