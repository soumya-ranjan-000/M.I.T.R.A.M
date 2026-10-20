import { describe, expect, it } from 'vitest';
import { appWindowArgs, findAppBrowser } from '../src/voice/appWindow';

const have = (...present: string[]) => (p: string) => present.includes(p);

describe('findAppBrowser', () => {
  it('prefers Edge on Windows, since every install has it', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' };
    const found = findAppBrowser({
      platform: 'win32',
      env,
      exists: have('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
    });
    expect(found).toEqual({ name: 'Microsoft Edge', command: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  });

  it('finds a per-user Chrome on Windows', () => {
    const found = findAppBrowser({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
      exists: have('C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    });
    expect(found?.name).toBe('Google Chrome');
  });

  it('finds an app bundle on macOS', () => {
    const found = findAppBrowser({ platform: 'darwin', env: {}, exists: have('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge') });
    expect(found?.name).toBe('Microsoft Edge');
  });

  it('finds a program on PATH on Linux', () => {
    expect(findAppBrowser({ platform: 'linux', env: {}, exists: have('chromium') })?.command).toBe('chromium');
  });

  it('returns null when only a browser without app mode is installed', () => {
    expect(findAppBrowser({ platform: 'linux', env: {}, exists: have('firefox') })).toBeNull();
    expect(findAppBrowser({ platform: 'win32', env: {}, exists: () => true })).toBeNull();
  });
});

describe('appWindowArgs', () => {
  it('opens the url as a small window', () => {
    const args = appWindowArgs('http://127.0.0.1:5000/?t=x');
    expect(args[0]).toBe('--app=http://127.0.0.1:5000/?t=x');
    expect(args).toContain('--window-size=440,460');
  });
});

describe('appWindowArgs platform flags', () => {
  it('asks Chrome for X11 on Linux when a display is available', () => {
    expect(appWindowArgs('http://x/', { platform: 'linux', env: { DISPLAY: ':0' } })).toContain('--ozone-platform=x11');
  });
  it('adds nothing on Linux without X11, or elsewhere', () => {
    expect(appWindowArgs('http://x/', { platform: 'linux', env: {} })).not.toContain('--ozone-platform=x11');
    expect(appWindowArgs('http://x/', { platform: 'win32', env: { DISPLAY: ':0' } })).not.toContain('--ozone-platform=x11');
  });
});
