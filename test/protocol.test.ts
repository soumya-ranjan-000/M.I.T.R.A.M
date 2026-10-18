import { describe, expect, it } from 'vitest';
import { isWebviewToHost } from '../src/webview/protocol';

describe('isWebviewToHost', () => {
  it('accepts valid messages', () => {
    expect(isWebviewToHost({ type: 'ready' })).toBe(true);
    expect(
      isWebviewToHost({ type: 'sendMessage', text: 'hi', includeActive: true, mentions: ['a.ts'], plan: false }),
    ).toBe(true);
    for (const type of ['retry', 'stop', 'openSettings', 'setApiKey', 'newChat', 'revert', 'pickModel']) {
      expect(isWebviewToHost({ type })).toBe(true);
    }
    expect(isWebviewToHost({ type: 'switchSession', id: 'x' })).toBe(true);
    expect(isWebviewToHost({ type: 'searchFiles', query: 'ab' })).toBe(true);
    expect(isWebviewToHost({ type: 'insertCode', code: 'x' })).toBe(true);
    expect(isWebviewToHost({ type: 'approval', id: 't', decision: 'always' })).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isWebviewToHost(null)).toBe(false);
    expect(isWebviewToHost('ready')).toBe(false);
    expect(isWebviewToHost({ type: 'nope' })).toBe(false);
    expect(isWebviewToHost({ type: 'sendMessage', text: 'hi' })).toBe(false);
    expect(isWebviewToHost({ type: 'sendMessage', text: 'hi', includeActive: true, mentions: [] })).toBe(false);
    expect(isWebviewToHost({ type: 'sendMessage', text: 'hi', includeActive: true, mentions: [1], plan: false })).toBe(false);
    expect(isWebviewToHost({ type: 'switchSession' })).toBe(false);
    expect(isWebviewToHost({ type: 'deleteSession', id: 5 })).toBe(false);
    expect(isWebviewToHost({ type: 'approval', id: 't', decision: 'maybe' })).toBe(false);
    expect(isWebviewToHost({ type: 'approval', decision: 'approve' })).toBe(false);
  });
});
