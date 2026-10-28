import { describe, expect, it } from 'vitest';
import { MAX_LIVE_OUTPUT_CHARS, applyHostEvent } from '../src/webview/displayReducer';
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

  it('times reasoning from its first piece to its latest', () => {
    let m: DisplayMessage[] = [];
    m = applyHostEvent(m, { type: 'thinkingDelta', text: 'a', at: 1000 });
    m = applyHostEvent(m, { type: 'thinkingDelta', text: 'b', at: 4500 });
    expect(m).toEqual([{ role: 'thinking', text: 'ab', startedAt: 1000, endedAt: 4500 }]);
  });

  it('appends live output to a running card, then takes the finished result', () => {
    let m = applyHostEvent([], { type: 'toolStart', id: 't', name: 'run_command', summary: 'Run', status: 'running' });
    m = applyHostEvent(m, { type: 'toolOutput', id: 't', text: 'one\n' });
    m = applyHostEvent(m, { type: 'toolOutput', id: 't', text: 'two\n' });
    expect(m[0]).toMatchObject({ output: 'one\ntwo\n' });
    m = applyHostEvent(m, { type: 'toolUpdate', id: 't', status: 'ok', output: 'exit code 0\none\ntwo' });
    expect(m[0]).toMatchObject({ status: 'ok', output: 'exit code 0\none\ntwo' });
  });

  it("appends a sub-agent's live output to its own step", () => {
    let m = applyHostEvent([], { type: 'toolStart', id: 'p', name: 'delegate_task', summary: 'Task', status: 'running' });
    m = applyHostEvent(m, { type: 'toolStart', id: 'c', name: 'run_command', summary: 'Run', status: 'running', parentId: 'p' });
    m = applyHostEvent(m, { type: 'toolOutput', id: 'c', text: 'hi', parentId: 'p' });
    expect(m[0]).toMatchObject({ steps: [{ id: 'c', output: 'hi' }] });
  });

  it('keeps only the newest live output, starting at a whole line', () => {
    let m = applyHostEvent([], { type: 'toolStart', id: 't', name: 'run_command', summary: 'Run', status: 'running' });
    const line = 'x'.repeat(99) + '\n';
    m = applyHostEvent(m, { type: 'toolOutput', id: 't', text: line.repeat(MAX_LIVE_OUTPUT_CHARS / 100 + 50) });
    const output = (m[0] as { output: string }).output;
    expect(output.length).toBeLessThanOrEqual(MAX_LIVE_OUTPUT_CHARS);
    expect(output.startsWith('x'.repeat(99) + '\n')).toBe(true);
  });

  it('puts a warning on an approval prompt, including a sub-agent\'s', () => {
    let m = applyHostEvent([], { type: 'toolStart', id: 't', name: 'edit_file', summary: 'Edit a', status: 'pending' });
    m = applyHostEvent(m, { type: 'toolWarning', id: 't', text: 'Another chat changed this file.' });
    expect(m[0]).toMatchObject({ warning: 'Another chat changed this file.' });
  });
});
