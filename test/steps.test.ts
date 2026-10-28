import { describe, expect, it } from 'vitest';
import type { DisplayMessage } from '../src/webview/protocol';
import { commandExit, describeSteps, groupSteps, liveSteps, stepsStatus, type StepMessage } from '../src/webview/steps';

type Status = 'pending' | 'running' | 'ok' | 'error' | 'rejected';
type ToolMessage = Extract<StepMessage, { role: 'tool' }>;
const tool = (id: string, name: string, status: Status = 'ok', output?: string): ToolMessage => ({
  role: 'tool', id, name, summary: name, status, ...(output ? { output } : {}),
});
const user: DisplayMessage = { role: 'user', text: 'fix it' };
const reply: DisplayMessage = { role: 'assistant', text: 'Done.' };
const thinking: StepMessage = { role: 'thinking', text: 'hmm' };

describe('groupSteps', () => {
  it('folds runs of steps between messages and keeps their positions', () => {
    const items = groupSteps([user, thinking, tool('a', 'read_file'), reply, tool('b', 'read_file'), tool('c', 'edit_file')]);
    expect(items.map((i) => i.kind)).toEqual(['message', 'steps', 'message', 'steps']);
    expect(items[1]).toMatchObject({ kind: 'steps', steps: [{ index: 1 }, { index: 2 }] });
    expect(items[3]).toMatchObject({ kind: 'steps', steps: [{ index: 4 }, { index: 5 }] });
  });

  it('leaves a lone step as it is', () => {
    const items = groupSteps([user, tool('a', 'read_file'), reply]);
    expect(items).toEqual([
      { kind: 'message', message: user, index: 0 },
      { kind: 'message', message: tool('a', 'read_file'), index: 1 },
      { kind: 'message', message: reply, index: 2 },
    ]);
  });

  it('folds nothing when the minimum cannot be reached', () => {
    expect(groupSteps([user, thinking, tool('a', 'read_file')], Infinity).every((i) => i.kind === 'message')).toBe(true);
  });
});

describe('describeSteps', () => {
  it('counts what the agent did', () => {
    const steps = [tool('a', 'read_file'), tool('b', 'read_file'), tool('c', 'search_files'), tool('d', 'edit_file'), tool('e', 'run_command')];
    expect(describeSteps(steps)).toBe('Read 2 files, 1 search, edited 1 file, ran 1 command');
  });

  it('names sub-agents, MCP calls and anything else', () => {
    expect(describeSteps([tool('a', 'delegate_task'), tool('b', 'mcp__github__get_issue'), tool('c', 'something_new')])).toBe(
      '1 sub-agent, 1 MCP call, 1 other step',
    );
  });

  it('falls back to reasoning and attached files when no tool ran', () => {
    expect(describeSteps([{ role: 'retrieved', files: [] }, thinking])).toBe('Reasoned, attached related files');
  });
});

describe('stepsStatus', () => {
  it('puts waiting first, then running, then failures', () => {
    expect(stepsStatus([tool('a', 'read_file', 'error'), tool('b', 'run_command', 'running'), tool('c', 'edit_file', 'pending')])).toBe('pending');
    expect(stepsStatus([tool('a', 'read_file', 'error'), tool('b', 'run_command', 'running')])).toBe('running');
    expect(stepsStatus([tool('a', 'read_file', 'error'), tool('b', 'read_file')])).toBe('error');
    expect(stepsStatus([thinking, tool('a', 'read_file')])).toBe('ok');
  });

  it("counts a command that exited non-zero as a failure, and a sub-agent's approval as waiting", () => {
    expect(stepsStatus([tool('a', 'run_command', 'ok', 'exit code 1\nboom')])).toBe('error');
    const agent: ToolMessage = { ...tool('p', 'delegate_task', 'running'), steps: [{ id: 'c', name: 'edit_file', summary: 'Edit', status: 'pending' }] };
    expect(stepsStatus([agent])).toBe('pending');
  });
});

describe('commandExit', () => {
  it('reads the exit code of a finished command only', () => {
    expect(commandExit(tool('a', 'run_command', 'ok', 'exit code 2\nx'))).toBe(2);
    expect(commandExit(tool('a', 'run_command', 'ok', 'Timed out after 120s and was killed.\nx'))).toBeNull();
    expect(commandExit(tool('a', 'run_command', 'running', 'exit code 0'))).toBeNull();
    expect(commandExit(tool('a', 'read_file', 'ok', 'exit code 0'))).toBeNull();
  });
});

describe('liveSteps', () => {
  const at = (messages: StepMessage[]) => messages.map((message, index) => ({ message, index }));

  it('shows what runs or waits, plus reasoning still streaming at the end', () => {
    const steps = at([tool('a', 'read_file'), tool('b', 'run_command', 'running'), tool('c', 'edit_file', 'pending'), thinking]);
    expect(liveSteps(steps).map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it('falls back to the latest step', () => {
    expect(liveSteps(at([tool('a', 'read_file'), tool('b', 'read_file')])).map((s) => s.index)).toEqual([1]);
    expect(liveSteps([])).toEqual([]);
  });
});
