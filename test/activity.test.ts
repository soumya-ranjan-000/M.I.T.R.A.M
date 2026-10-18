import { describe, expect, it } from 'vitest';
import { describeActivity, formatElapsed } from '../src/webview/activity';
import type { DisplayMessage } from '../src/webview/protocol';

const tool = (status: 'pending' | 'running' | 'ok' | 'error' | 'rejected', summary = 'Read a.ts'): DisplayMessage => ({
  role: 'tool', id: 't', name: 'read_file', summary, status,
});

describe('describeActivity', () => {
  it('says thinking before anything has arrived, and while reasoning streams', () => {
    expect(describeActivity([])).toEqual({ label: 'Thinking…', waitingForUser: false });
    expect(describeActivity([{ role: 'user', text: 'hi' }]).label).toBe('Thinking…');
    expect(describeActivity([{ role: 'user', text: 'hi' }, { role: 'thinking', text: 'hmm' }]).label).toBe('Thinking…');
  });

  it('says writing while the answer streams', () => {
    expect(describeActivity([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'He' }]).label).toBe('Writing…');
  });

  it('names the running tool', () => {
    expect(describeActivity([tool('running', 'Run: npm test')])).toEqual({ label: 'Run: npm test…', waitingForUser: false });
  });

  it('flags when it is waiting on the user', () => {
    expect(describeActivity([tool('pending')])).toEqual({ label: 'Waiting for your approval', waitingForUser: true });
  });

  it('says reviewing after a tool finishes, however it ended', () => {
    for (const s of ['ok', 'error', 'rejected'] as const) {
      expect(describeActivity([tool(s)]).label).toBe('Reviewing the result…');
    }
  });
});

describe('formatElapsed', () => {
  it('formats seconds and minutes', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(-5)).toBe('0s');
  });
});
