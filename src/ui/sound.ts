import { exec } from 'child_process';

/**
 * Triggers an audible PC sound alert, spoken voice announcement, and a Windows Desktop
 * pop-up notification (System Tray Balloon + Top-Most Toast Banner) when a trading signal is called.
 */
export function playAlertSound(
  voiceAnnouncement?: string,
  notificationTitle?: string,
  notificationBody?: string
): void {
  // 1. Standard terminal bell character
  process.stdout.write('\x07');

  if (process.platform !== 'win32') return;

  const clean = (s?: string) =>
    (s || '')
      .replace(/['"`$]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const cleanVoice = clean(voiceAnnouncement);
  const cleanTitle = clean(notificationTitle || 'QX PRO SIGNAL CALL');
  const cleanBody = clean(notificationBody || cleanVoice || 'New high-probability setup detected on Quotex');

  // Build PowerShell script for:
  // A) Windows WAV Audio + SystemSounds through default speakers/headphones
  // B) Windows SAPI Voice Speech
  // C) Windows System Tray Balloon Notification (NotifyIcon)
  const psScript = `
    try {
      [System.Media.SystemSounds]::Exclamation.Play()
      if (Test-Path 'C:\\Windows\\Media\\Alarm01.wav') {
        $p = New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav'
        $p.Play()
      } elseif (Test-Path 'C:\\Windows\\Media\\Ring01.wav') {
        $p = New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\Ring01.wav'
        $p.Play()
      } elseif (Test-Path 'C:\\Windows\\Media\\notify.wav') {
        $p = New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\notify.wav'
        $p.Play()
      }
    } catch {}
    try {
      [System.Console]::Beep(880, 180)
      [System.Console]::Beep(1175, 250)
    } catch {}
    try {
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $notify = New-Object System.Windows.Forms.NotifyIcon
      $notify.Icon = [System.Drawing.SystemIcons]::Information
      $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
      $notify.BalloonTipTitle = '${cleanTitle}'
      $notify.BalloonTipText = '${cleanBody}'
      $notify.Visible = $true
      $notify.ShowBalloonTip(8000)
    } catch {}
    ${
      cleanVoice
        ? `try {
      Add-Type -AssemblyName System.Speech
      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
      $s.Volume = 100
      $s.Rate = 1
      $s.Speak('${cleanVoice}')
    } catch {}`
        : 'Start-Sleep -Seconds 2'
    }
    try {
      if ($notify) {
        Start-Sleep -Seconds 3
        $notify.Dispose()
      }
    } catch {}
  `
    .replace(/\r?\n/g, '; ')
    .replace(/;\s*;/g, ';');

  exec(`powershell -NoProfile -WindowStyle Hidden -Command "${psScript}"`, () => {
    // Non-blocking background alert
  });
}
