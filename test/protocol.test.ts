import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, base64Bytes, isWebviewToHost } from '../src/webview/protocol';

describe('isWebviewToHost', () => {
  it('accepts valid messages', () => {
    expect(isWebviewToHost({ type: 'ready' })).toBe(true);
    expect(
      isWebviewToHost({ type: 'sendMessage', text: 'hi', includeActive: true, mentions: ['a.ts'], plan: false, images: [], files: [] }),
    ).toBe(true);
    for (const type of ['retry', 'stop', 'openSettings', 'setApiKey', 'newChat', 'revert', 'pickModel', 'managePermissions', 'pickFiles', 'voiceStart', 'voiceCancel']) {
      expect(isWebviewToHost({ type })).toBe(true);
    }
    expect(isWebviewToHost({ type: 'switchSession', id: 'x' })).toBe(true);
    expect(isWebviewToHost({ type: 'searchFiles', query: 'ab' })).toBe(true);
    expect(isWebviewToHost({ type: 'insertCode', code: 'x' })).toBe(true);
    expect(isWebviewToHost({ type: 'approval', id: 't', decision: 'always' })).toBe(true);
    expect(isWebviewToHost({ type: 'openFile', path: 'src/a.ts', line: 12 })).toBe(true);
    expect(isWebviewToHost({ type: 'viewChange', id: 'toolu_1' })).toBe(true);
    expect(isWebviewToHost({ type: 'viewChatChange', path: 'src/a.ts' })).toBe(true);
    expect(isWebviewToHost({ type: 'revertChatFile', path: 'src/a.ts' })).toBe(true);
    expect(isWebviewToHost({ type: 'revertChat' })).toBe(true);
    expect(isWebviewToHost({ type: 'keepChatChanges' })).toBe(true);
    expect(isWebviewToHost({ type: 'watchProcess', id: 'p1' })).toBe(true);
    expect(isWebviewToHost({ type: 'watchProcess' })).toBe(true);
    expect(isWebviewToHost({ type: 'processAction', id: 'p1', action: 'restart' })).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isWebviewToHost(null)).toBe(false);
    expect(isWebviewToHost('ready')).toBe(false);
    expect(isWebviewToHost({ type: 'nope' })).toBe(false);
    expect(isWebviewToHost({ type: 'viewChange' })).toBe(false);
    expect(isWebviewToHost({ type: 'viewChange', id: 5 })).toBe(false);
    expect(isWebviewToHost({ type: 'revertChatFile' })).toBe(false);
    expect(isWebviewToHost({ type: 'viewChatChange', path: ['a'] })).toBe(false);
    expect(isWebviewToHost({ type: 'processAction', id: 'p1', action: 'kill -9 everything' })).toBe(false);
    expect(isWebviewToHost({ type: 'watchProcess', id: 3 })).toBe(false);
    expect(isWebviewToHost({ type: 'sendMessage', text: 'hi' })).toBe(false);
    expect(isWebviewToHost({ type: 'sendMessage', text: 'hi', includeActive: true, mentions: [] })).toBe(false);
    expect(isWebviewToHost({ type: 'sendMessage', text: 'hi', includeActive: true, mentions: [1], plan: false })).toBe(false);
    expect(isWebviewToHost({ type: 'sendMessage', text: 'hi', includeActive: true, mentions: [], plan: false })).toBe(false);
    expect(isWebviewToHost({ type: 'sendMessage', text: 'hi', includeActive: true, mentions: [], plan: false, images: [] })).toBe(false);
    expect(isWebviewToHost({ type: 'switchSession' })).toBe(false);
    expect(isWebviewToHost({ type: 'deleteSession', id: 5 })).toBe(false);
    expect(isWebviewToHost({ type: 'approval', id: 't', decision: 'maybe' })).toBe(false);
    expect(isWebviewToHost({ type: 'approval', decision: 'approve' })).toBe(false);
    expect(isWebviewToHost({ type: 'openFile', path: 'src/a.ts' })).toBe(false);
    expect(isWebviewToHost({ type: 'openFile', path: 'src/a.ts', line: 0 })).toBe(false);
    expect(isWebviewToHost({ type: 'openFile', path: 'src/a.ts', line: 1.5 })).toBe(false);
    expect(isWebviewToHost({ type: 'openFile', path: 'x'.repeat(2000), line: 1 })).toBe(false);
  });
});

// The webview is the other side of a trust boundary: these messages add, remove and restart
// programs, so a malformed one must be rejected rather than reaching the host handlers.
describe('isWebviewToHost: MCP messages', () => {
  it('accepts the messages that carry no payload', () => {
    expect(isWebviewToHost({ type: 'mcpRefresh' })).toBe(true);
    expect(isWebviewToHost({ type: 'mcpAdd' })).toBe(true);
  });

  it('accepts a server id where one is required', () => {
    expect(isWebviewToHost({ type: 'mcpRemove', id: 'github' })).toBe(true);
    expect(isWebviewToHost({ type: 'mcpSetKey', id: 'github' })).toBe(true);
  });

  it('rejects a missing or non-string server id', () => {
    for (const type of ['mcpRemove', 'mcpSetKey']) {
      expect(isWebviewToHost({ type })).toBe(false);
      expect(isWebviewToHost({ type, id: 5 })).toBe(false);
      expect(isWebviewToHost({ type, id: null })).toBe(false);
      expect(isWebviewToHost({ type, id: { toString: () => 'x' } })).toBe(false);
    }
  });

  it('accepts mcpEnable with both fields', () => {
    expect(isWebviewToHost({ type: 'mcpEnable', id: 'github', enabled: true })).toBe(true);
    expect(isWebviewToHost({ type: 'mcpEnable', id: 'github', enabled: false })).toBe(true);
  });

  it('rejects mcpEnable without a real boolean', () => {
    expect(isWebviewToHost({ type: 'mcpEnable', id: 'github' })).toBe(false);
    expect(isWebviewToHost({ type: 'mcpEnable', id: 'github', enabled: 'true' })).toBe(false);
    expect(isWebviewToHost({ type: 'mcpEnable', id: 'github', enabled: 1 })).toBe(false);
    expect(isWebviewToHost({ type: 'mcpEnable', enabled: true })).toBe(false);
  });

  it('accepts mcpRestart with an id or without one', () => {
    expect(isWebviewToHost({ type: 'mcpRestart' })).toBe(true);
    expect(isWebviewToHost({ type: 'mcpRestart', id: undefined })).toBe(true);
    expect(isWebviewToHost({ type: 'mcpRestart', id: 'github' })).toBe(true);
  });

  it('rejects mcpRestart with an id that is not a string', () => {
    expect(isWebviewToHost({ type: 'mcpRestart', id: 5 })).toBe(false);
    expect(isWebviewToHost({ type: 'mcpRestart', id: null })).toBe(false);
    expect(isWebviewToHost({ type: 'mcpRestart', id: ['github'] })).toBe(false);
  });

  // The key is typed into a native prompt in the host, so no message type may declare a field
  // for one. Checked against the source, since a type cannot be inspected at run time.
  it('declares no field for an API key on any MCP message', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'webview', 'protocol.ts'), 'utf8');
    const mcpMessages = source.match(/\{ type: 'mcp[^}]*\}/g) ?? [];

    expect(mcpMessages.length).toBeGreaterThan(5);
    for (const message of mcpMessages) {
      expect(message, message).not.toMatch(/\b(key|apiKey|token|secret|password)\s*[?]?:/);
    }
  });
});

describe('image attachments', () => {
  const image = (over: Record<string, unknown> = {}) => ({
    id: 'i1', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'shot.png', width: 10, height: 10, bytes: 8, ...over,
  });
  const send = (images: unknown[], files: unknown[] = []) => ({ type: 'sendMessage', text: '', includeActive: false, mentions: [], plan: false, images, files });

  it('accepts up to five valid images, even with no text', () => {
    expect(isWebviewToHost(send([image()]))).toBe(true);
    expect(isWebviewToHost(send(Array.from({ length: 5 }, (_, i) => image({ id: `i${i}` }))))).toBe(true);
  });

  it('rejects a sixth image, a bad media type, data that is not base64, and oversized data', () => {
    expect(isWebviewToHost(send(Array.from({ length: 6 }, () => image())))).toBe(false);
    expect(isWebviewToHost(send([image({ mediaType: 'image/svg+xml' })]))).toBe(false);
    expect(isWebviewToHost(send([image({ data: 'data:image/png;base64,iVBO' })]))).toBe(false);
    expect(isWebviewToHost(send([image({ data: 'abc' })]))).toBe(false);
    expect(isWebviewToHost(send([image({ data: '' })]))).toBe(false);
    expect(isWebviewToHost(send([image({ data: 'A'.repeat(5_000_004) })]))).toBe(false);
    expect(isWebviewToHost(send([image({ width: 'wide' })]))).toBe(false);
    expect(isWebviewToHost(send([null]))).toBe(false);
  });

  it('measures the decoded size, not what the webview claims', () => {
    expect(base64Bytes('iVBORw0KGgo=')).toBe(8);
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AA==')).toBe(1);
    expect(base64Bytes('A'.repeat(5_000_000))).toBe(MAX_IMAGE_BYTES);
  });

  it('accepts a list of URIs to read, and nothing else', () => {
    expect(isWebviewToHost({ type: 'readFiles', uris: ['file:///tmp/a.png'] })).toBe(true);
    expect(isWebviewToHost({ type: 'readFiles', uris: [5] })).toBe(false);
    expect(isWebviewToHost({ type: 'readFiles', uris: 'file:///tmp/a.png' })).toBe(false);
  });

  const file = (over: Record<string, unknown> = {}) => ({
    id: 'f1', name: 'notes.txt', kind: 'text', data: 'hello', bytes: 5, detail: '1 line', truncated: false, ...over,
  });

  it('accepts text files and PDFs', () => {
    expect(isWebviewToHost(send([], [file()]))).toBe(true);
    expect(isWebviewToHost(send([], [file({ kind: 'pdf', name: 'a.pdf', data: 'JVBERi0xLjcK' })]))).toBe(true);
  });

  it('rejects a sixth file, an unknown kind, a PDF that is not one, oversized text, and too much in one message', () => {
    expect(isWebviewToHost(send([], Array.from({ length: 6 }, () => file())))).toBe(false);
    expect(isWebviewToHost(send([], [file({ kind: 'docx' })]))).toBe(false);
    expect(isWebviewToHost(send([], [file({ kind: 'pdf', data: 'aGVsbG8gd29ybGQh' })]))).toBe(false);
    expect(isWebviewToHost(send([], [file({ data: 'x'.repeat(200_001) })]))).toBe(false);
    expect(isWebviewToHost(send([], [file({ data: '' })]))).toBe(false);
    expect(isWebviewToHost(send([], [file({ truncated: 'no' })]))).toBe(false);
    const bigPdf = (id: string) => file({ id, kind: 'pdf', data: `JVBERi0x${'A'.repeat(13_000_000)}` });
    expect(isWebviewToHost(send([], [bigPdf('a')]))).toBe(true);
    expect(isWebviewToHost(send([], [bigPdf('a'), bigPdf('b')]))).toBe(false);
  });

  it('accepts dropped file data for the host to read', () => {
    expect(isWebviewToHost({ type: 'attachFileData', name: 'a.docx', data: 'UEsDBA==' })).toBe(true);
    expect(isWebviewToHost({ type: 'attachFileData', name: 'a.docx', data: 'not base64!' })).toBe(false);
    expect(isWebviewToHost({ type: 'attachFileData', data: 'UEsDBA==' })).toBe(false);
  });
});
