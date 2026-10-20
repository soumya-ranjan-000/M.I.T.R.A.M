// Desktop notifications without a native dependency: each OS already ships a way to raise one.
// The command builder is pure so tests can check every platform from any machine.

export interface NotifyCommand {
  command: string;
  args: string[];
  /** Extra environment variables. The text travels here, never inside a script. */
  env?: Record<string, string>;
}

const APP_NAME = 'M.I.T.R.A.M';
const MAX_TITLE = 80;
const MAX_BODY = 200;

/** One line, no control characters, cut to `max`. Notification daemons render markup and may log text. */
export function cleanText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// Windows PowerShell 5.1 ships with every supported Windows; the toast is attributed to it because a
// toast needs a registered app id, and this is the one that always exists.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$title = [System.Security.SecurityElement]::Escape($env:MITRAM_TITLE)
$body = [System.Security.SecurityElement]::Escape($env:MITRAM_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

/** The command that raises a notification on `platform`, or null where there is no known way. */
export function buildNotifyCommand(platform: string, rawTitle: string, rawBody: string): NotifyCommand | null {
  const title = cleanText(rawTitle, MAX_TITLE) || APP_NAME;
  const body = cleanText(rawBody, MAX_BODY);

  switch (platform) {
    case 'win32':
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64'),
        ],
        env: { MITRAM_TITLE: title, MITRAM_BODY: body },
      };
    case 'darwin':
      return {
        command: 'osascript',
        // The text is passed as arguments, so quotes in it cannot become part of the script.
        args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', '--', title, body],
      };
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return { command: 'notify-send', args: [`--app-name=${APP_NAME}`, '--', title, body] };
    default:
      return null;
  }
}

export type Exec = (command: string, args: string[], options: { env?: Record<string, string>; timeout: number }) => Promise<void>;

/** Raises a desktop notification. Resolves true if the OS command ran, false if it could not. Never throws. */
export async function notifyOs(platform: string, title: string, body: string, exec: Exec): Promise<boolean> {
  const cmd = buildNotifyCommand(platform, title, body);
  if (!cmd) return false;
  try {
    await exec(cmd.command, cmd.args, { env: cmd.env, timeout: 10_000 });
    return true;
  } catch {
    // notify-send missing, no notification service running, or PowerShell blocked by policy.
    return false;
  }
}
