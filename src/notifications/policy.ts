// When and how to tell the user something happened. Pure, so every combination can be tested.

export type NotifyMode = 'whenAway' | 'always' | 'off';
export type NotifyKind = 'approval' | 'done' | 'paused' | 'error';
/** `os` is a desktop notification, `inapp` a VS Code message, `none` stays quiet. */
export type NotifyChannel = 'os' | 'inapp' | 'none';

export interface Presence {
  /** The VS Code window has the keyboard focus. */
  windowFocused: boolean;
  /** The chat view is on screen (its sidebar is open and not hidden behind another view). */
  viewVisible: boolean;
  /** The extension runs on another machine (SSH, WSL, container), where a desktop notification would never reach the user. */
  remote: boolean;
}

/** A run shorter than this ends before the user has looked away, so it is not worth a notification. */
export const MIN_DONE_MS = 8_000;

export function parseMode(value: unknown): NotifyMode {
  return value === 'always' || value === 'off' ? value : 'whenAway';
}

export function chooseChannel(mode: NotifyMode, kind: NotifyKind, presence: Presence, runMs = 0): NotifyChannel {
  if (mode === 'off') return 'none';
  if (kind === 'done' && runMs < MIN_DONE_MS && mode !== 'always') return 'none';
  const os: NotifyChannel = presence.remote ? 'inapp' : 'os';
  if (mode === 'always') return os;
  // whenAway: a desktop notification when the window is not in front, a VS Code message when the
  // window is in front but the chat is out of sight, and nothing while the user is looking at it.
  if (!presence.windowFocused) return os;
  return presence.viewVisible ? 'none' : 'inapp';
}
