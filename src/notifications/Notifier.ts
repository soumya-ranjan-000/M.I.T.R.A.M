import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { NotifyKind, NotifyMode, chooseChannel } from './policy';
import { notifyOs } from './osNotify';

export interface NotifierDeps {
  mode: () => NotifyMode;
  /** The chat view is on screen. */
  viewVisible: () => boolean;
  openChat: () => void;
  log: (message: string) => void;
}

/** The same message within this window is shown once (several sub-agents can ask at the same moment). */
const DEDUPE_MS = 3_000;

/** Tells the user what the agent needs or has done, on the desktop when they are away from VS Code. */
export class Notifier {
  private last = { key: '', at: 0 };
  private osFailureLogged = false;

  constructor(private readonly deps: NotifierDeps) {}

  async notify(kind: NotifyKind, title: string, body: string, runMs = 0): Promise<void> {
    const channel = chooseChannel(
      this.deps.mode(),
      kind,
      { windowFocused: vscode.window.state.focused, viewVisible: this.deps.viewVisible(), remote: !!vscode.env.remoteName },
      runMs,
    );
    if (channel === 'none') return;

    const key = `${kind}|${title}|${body}`;
    const now = Date.now();
    if (key === this.last.key && now - this.last.at < DEDUPE_MS) return;
    this.last = { key, at: now };

    if (channel === 'os' && (await notifyOs(process.platform, title, body, run))) return;
    if (channel === 'os' && !this.osFailureLogged) {
      this.osFailureLogged = true;
      this.deps.log(
        `notifications: no desktop notification could be raised on ${process.platform}${process.platform === 'linux' ? ' (is notify-send installed?)' : ''}; using VS Code messages instead`,
      );
    }
    this.showInApp(kind, title, body);
  }

  private showInApp(kind: NotifyKind, title: string, body: string): void {
    const show = kind === 'error' || kind === 'approval' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void Promise.resolve(show(body ? `${title}: ${body}` : title, 'Open chat')).then((choice) => {
      if (choice === 'Open chat') this.deps.openChat();
    });
  }
}

function run(command: string, args: string[], options: { env?: Record<string, string>; timeout: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: options.timeout, windowsHide: true, env: { ...process.env, ...options.env } },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
