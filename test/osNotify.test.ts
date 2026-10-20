import { describe, expect, it } from 'vitest';
import { buildNotifyCommand, cleanText, notifyOs } from '../src/notifications/osNotify';

describe('cleanText', () => {
  it('puts the text on one line without control characters', () => {
    expect(cleanText('a\nb\u0007c\t d', 50)).toBe('a b c d');
  });
  it('cuts long text with an ellipsis', () => {
    expect(cleanText('x'.repeat(30), 10)).toBe('xxxxxxxxx…');
  });
});

describe('buildNotifyCommand', () => {
  it('uses notify-send on Linux, with the text after -- so it cannot be read as a flag', () => {
    const cmd = buildNotifyCommand('linux', '--help', 'Run rm -rf')!;
    expect(cmd.command).toBe('notify-send');
    expect(cmd.args.slice(-3)).toEqual(['--', '--help', 'Run rm -rf']);
  });

  it('passes the text to osascript as arguments, never inside the script', () => {
    const cmd = buildNotifyCommand('darwin', 'T', 'say "hi" & quit')!;
    expect(cmd.command).toBe('osascript');
    expect(cmd.args.slice(0, cmd.args.indexOf('--')).join(' ')).not.toContain('say');
    expect(cmd.args.slice(-2)).toEqual(['T', 'say "hi" & quit']);
  });

  it('runs a fixed encoded script on Windows and sends the text through the environment', () => {
    const cmd = buildNotifyCommand('win32', "It's <b>done</b>", '$(calc)')!;
    expect(cmd.command).toBe('powershell.exe');
    expect(cmd.env).toEqual({ MITRAM_TITLE: "It's <b>done</b>", MITRAM_BODY: '$(calc)' });
    const script = Buffer.from(cmd.args[cmd.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toContain('ToastNotificationManager');
    expect(script).not.toContain('calc');
    expect(script).toContain('SecurityElement]::Escape');
  });

  it('has no command for an unknown platform', () => {
    expect(buildNotifyCommand('aix', 'a', 'b')).toBeNull();
  });

  it('falls back to a default title', () => {
    expect(buildNotifyCommand('linux', '  ', 'b')!.args).toContain('M.I.T.R.A.M');
  });
});

describe('notifyOs', () => {
  it('reports success when the command runs', async () => {
    const calls: string[] = [];
    const ok = await notifyOs('linux', 'T', 'B', async (command) => void calls.push(command));
    expect(ok).toBe(true);
    expect(calls).toEqual(['notify-send']);
  });

  it('reports failure instead of throwing when the command is missing', async () => {
    const ok = await notifyOs('linux', 'T', 'B', async () => {
      throw new Error('ENOENT');
    });
    expect(ok).toBe(false);
  });

  it('reports failure on an unsupported platform without running anything', async () => {
    let ran = false;
    expect(await notifyOs('aix', 'T', 'B', async () => void (ran = true))).toBe(false);
    expect(ran).toBe(false);
  });
});
