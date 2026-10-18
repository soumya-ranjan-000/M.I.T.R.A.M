import { describe, expect, it } from 'vitest';
import { applyHostEvent } from '../src/webview/displayReducer';
import type { DisplayMessage } from '../src/webview/protocol';

describe('applyHostEvent', () => {
  it('appends streamed text to the last assistant message, or starts a new one after a tool', () => {
    let m: DisplayMessage[] = [{ role: 'user', text: 'hi' }];
    m = applyHostEvent(m, { type: 'streamDelta', text: 'Hel' });
    m = applyHostEvent(m, { type: 'streamDelta', text: 'lo' });
    expect(m).toEqual([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello' }]);

    m = applyHostEvent(m, { type: 'toolStart', id: 't', name: 'read_file', summary: 'Read a', status: 'running' });
    m = applyHostEvent(m, { type: 'streamDelta', text: 'Done' });
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('adds the files the search attached as their own entry', () => {
    const files = [{ path: 'src/a.ts', startLine: 3, endLine: 22 }];
    const m = applyHostEvent([{ role: 'user', text: 'hi' }], { type: 'retrieved', files });
    expect(m).toEqual([{ role: 'user', text: 'hi' }, { role: 'retrieved', files }]);
  });

  it('updates a tool card by id', () => {
    let m = applyHostEvent([], { type: 'toolStart', id: 't', name: 'run_command', summary: 'Run', status: 'pending' });
    m = applyHostEvent(m, { type: 'toolUpdate', id: 't', status: 'ok', output: 'done' });
    expect(m[0]).toMatchObject({ role: 'tool', status: 'ok', output: 'done' });
  });

  it('attaches the suggested "Always allow" rule to a pending command card', () => {
    let m = applyHostEvent([], { type: 'toolStart', id: 't', name: 'run_command', summary: 'Run', status: 'pending' });
    m = applyHostEvent(m, { type: 'toolAllowRule', id: 't', label: 'npm test *', usesShell: false });
    m = applyHostEvent(m, { type: 'toolAllowRule', id: 'other', label: 'rm x', usesShell: false });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ role: 'tool', status: 'pending', allowRule: { label: 'npm test *', usesShell: false } });
  });

  it('groups streamed reasoning into one block, and starts a new answer after it', () => {
    let m: DisplayMessage[] = [{ role: 'user', text: 'hi' }];
    m = applyHostEvent(m, { type: 'thinkingDelta', text: 'Look ' });
    m = applyHostEvent(m, { type: 'thinkingDelta', text: 'closer' });
    m = applyHostEvent(m, { type: 'streamDelta', text: 'Answer' });
    expect(m).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'thinking', text: 'Look closer' },
      { role: 'assistant', text: 'Answer' },
    ]);
  });
});
