// Opens the listening page as a small app-style window (no tabs, no address bar) in a Chromium-based
// browser, so voice input feels like a widget. Pure helpers here; the launch itself is injectable.

export interface AppBrowser {
  name: string;
  command: string;
}

export interface FindOptions {
  platform: string;
  env: Record<string, string | undefined>;
  /** Whether a file exists (absolute paths) or a program is on PATH (bare names). */
  exists: (pathOrName: string) => boolean;
}

const WINDOWS: [string, string[]][] = [
  ['Microsoft Edge', ['Microsoft\\Edge\\Application\\msedge.exe']],
  ['Google Chrome', ['Google\\Chrome\\Application\\chrome.exe']],
  ['Brave', ['BraveSoftware\\Brave-Browser\\Application\\brave.exe']],
];
const MAC: [string, string][] = [
  ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
];
const LINUX = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'chromium', 'chromium-browser'];

/** The first installed Chromium-based browser, which can open a page as an app window; null if none. */
export function findAppBrowser({ platform, env, exists }: FindOptions): AppBrowser | null {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    for (const [name, rels] of WINDOWS) {
      for (const root of roots) {
        for (const rel of rels) {
          const command = `${root}\\${rel}`;
          if (exists(command)) return { name, command };
        }
      }
    }
    return null;
  }
  if (platform === 'darwin') {
    const found = MAC.find(([, command]) => exists(command));
    return found ? { name: found[0], command: found[1] } : null;
  }
  const command = LINUX.find((name) => exists(name));
  return command ? { name: command, command } : null;
}

export interface WindowOptions {
  size?: { width: number; height: number };
  platform?: string;
  env?: Record<string, string | undefined>;
}

/** Arguments that open `url` as a small standalone window. */
export function appWindowArgs(url: string, options: WindowOptions = {}): string[] {
  const { width, height } = options.size ?? { width: 440, height: 460 };
  const args = [`--app=${url}`, `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check'];
  // On a Wayland desktop Chrome picks Wayland itself, and on some setups (GNOME with missing settings
  // schemas) it aborts at start. X11, which XWayland provides almost everywhere, starts reliably.
  if (options.platform === 'linux' && options.env?.DISPLAY) args.push('--ozone-platform=x11');
  return args;
}
