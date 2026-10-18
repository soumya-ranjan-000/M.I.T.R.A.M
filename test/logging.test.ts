import { describe, expect, it } from 'vitest';
import { Logger, LogSink, buildDiagnostics, redact } from '../src/logging';

describe('redact', () => {
  it('removes API keys and auth headers in common shapes', () => {
    expect(redact('key sk-ant-api03-abcdefghijklmnop1234')).toBe('key sk-***');
    expect(redact('Authorization: Bearer abc123def456ghi789')).not.toMatch(/abc123/);
    expect(redact('x-api-key: abcdef0123456789')).toBe('x-api-key: ***');
    expect(redact('api-key="Zm9vYmFyYmF6"')).toMatch(/\*\*\*/);
    expect(redact('hash 0123456789abcdef0123456789abcdef')).toBe('hash ***');
  });

  it('removes exact secrets wherever they appear, even if no pattern matches', () => {
    expect(redact('failed with key hunter22 on host', ['hunter22'])).toBe('failed with key *** on host');
  });

  it('leaves ordinary text alone', () => {
    const text = 'request failed: status=429 Rate limited. model=claude-opus-5 tool read_file ok';
    expect(redact(text)).toBe(text);
  });
});

describe('Logger', () => {
  it('redacts registered secrets in every level', () => {
    const lines: string[] = [];
    const sink: LogSink = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
    const log = new Logger(sink);
    log.addSecret('my-secret-key');
    log.info('a my-secret-key b');
    log.warn('c my-secret-key');
    log.error('d my-secret-key');
    expect(lines).toEqual(['a *** b', 'c ***', 'd ***']);
  });
});

describe('buildDiagnostics', () => {
  const base = {
    extensionVersion: '0.1.0', vscodeVersion: '1.142.0', platform: 'linux', model: 'claude-opus-5',
    workspaceOpen: true, settings: { autoApproveEdits: false, maxIterations: 25 },
  };

  it('reports only the host of the endpoint, never credentials or the path', () => {
    const out = buildDiagnostics({ ...base, endpoint: 'https://user:pass@res.services.ai.azure.com/anthropic/?key=abc' });
    expect(out).toContain('Endpoint host: res.services.ai.azure.com');
    expect(out).not.toMatch(/pass|key=abc|\/anthropic/);
    expect(out).toContain('autoApproveEdits: false');
  });

  it('handles a missing or invalid endpoint', () => {
    expect(buildDiagnostics({ ...base, endpoint: '' })).toContain('(not set)');
    expect(buildDiagnostics({ ...base, endpoint: 'not a url' })).toContain('(invalid URL)');
  });
});
