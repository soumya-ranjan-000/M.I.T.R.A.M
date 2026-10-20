import { describe, expect, it } from 'vitest';
import { MIN_DONE_MS, chooseChannel, parseMode } from '../src/notifications/policy';

const away = { windowFocused: false, viewVisible: false, remote: false };
const watching = { windowFocused: true, viewVisible: true, remote: false };
const hidden = { windowFocused: true, viewVisible: false, remote: false };

describe('chooseChannel', () => {
  it('stays quiet when off', () => {
    expect(chooseChannel('off', 'approval', away)).toBe('none');
  });

  it('uses a desktop notification when the window is not in front', () => {
    expect(chooseChannel('whenAway', 'approval', away)).toBe('os');
    expect(chooseChannel('whenAway', 'error', away)).toBe('os');
    expect(chooseChannel('whenAway', 'paused', away)).toBe('os');
  });

  it('stays quiet while the user is looking at the chat', () => {
    expect(chooseChannel('whenAway', 'approval', watching)).toBe('none');
  });

  it('uses a VS Code message when the window is in front but the chat is hidden', () => {
    expect(chooseChannel('whenAway', 'approval', hidden)).toBe('inapp');
  });

  it('always notifies on the desktop in "always" mode, even while watching', () => {
    expect(chooseChannel('always', 'approval', watching)).toBe('os');
  });

  it('falls back to VS Code messages when the extension runs remotely', () => {
    expect(chooseChannel('whenAway', 'approval', { ...away, remote: true })).toBe('inapp');
    expect(chooseChannel('always', 'approval', { ...watching, remote: true })).toBe('inapp');
  });

  it('does not announce a run that finished quickly', () => {
    expect(chooseChannel('whenAway', 'done', away, MIN_DONE_MS - 1)).toBe('none');
    expect(chooseChannel('whenAway', 'done', away, MIN_DONE_MS)).toBe('os');
  });
});

describe('parseMode', () => {
  it('accepts the known values and defaults to whenAway', () => {
    expect(parseMode('always')).toBe('always');
    expect(parseMode('off')).toBe('off');
    expect(parseMode('whenAway')).toBe('whenAway');
    expect(parseMode('bogus')).toBe('whenAway');
    expect(parseMode(undefined)).toBe('whenAway');
  });
});
