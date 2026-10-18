import { describe, expect, it } from 'vitest';
import { emptyBoard } from '../src/agent/board';
import { RunTracker, isVerificationCommand } from '../src/agent/runTracker';
import type { Board } from '../src/webview/protocol';

const board = (...tasks: [string, Board['tasks'][number]['status']][]): Board => ({
  tasks: tasks.map(([title, status]) => ({ title, status })),
  notes: '',
});

describe('isVerificationCommand', () => {
  it.each(['npm test', 'node test.js', 'pytest -q', 'npm run build', 'tsc --noEmit', 'go test ./...'])('%s counts as a check', (c) => {
    expect(isVerificationCommand(c)).toBe(true);
  });
  it.each(['ls', 'ls -la src', 'pwd', 'echo hi', 'cat package.json', 'git status', 'git diff', 'git log --oneline', 'head -5 a.txt', 'which node'])(
    '%s does not count as a check',
    (c) => expect(isVerificationCommand(c)).toBe(false),
  );
});

describe('RunTracker: verification', () => {
  it('lets the model finish when nothing was edited', () => {
    expect(new RunTracker().checkFinish(undefined, { verify: true })).toEqual({ action: 'finish' });
  });

  it('asks for a check after edits, and accepts a passing command', () => {
    const t = new RunTracker();
    t.record('edit_file', { path: 'a.ts' }, 'ok', 'Edited a.ts');
    t.record('create_file', { path: 'b.ts' }, 'ok', 'Created b.ts');
    expect(t.unverifiedFiles()).toEqual(['a.ts', 'b.ts']);
    expect(t.noteForModel()).toContain('a.ts, b.ts');

    const check = t.checkFinish(undefined, { verify: true });
    expect(check.action).toBe('nudge');
    if (check.action === 'nudge') {
      expect(check.message).toMatch(/Automatic check, not from the user/);
      expect(check.message).toMatch(/a\.ts, b\.ts/);
    }

    t.record('run_command', { command: 'npm test' }, 'ok', 'exit code 0\n3 passed');
    expect(t.unverifiedFiles()).toEqual([]);
    expect(t.noteForModel()).toBe('');
    expect(t.checkFinish(undefined, { verify: true })).toEqual({ action: 'finish' });
  });

  it('does not accept a failing command, or one that only reads state', () => {
    const t = new RunTracker();
    t.record('edit_file', { path: 'a.ts' }, 'ok', 'Edited');
    t.record('run_command', { command: 'npm test' }, 'ok', 'exit code 1\n1 failed');
    expect(t.unverifiedFiles()).toEqual(['a.ts']);
    expect(t.noteForModel()).toMatch(/last check failed/);
    const c = t.checkFinish(undefined, { verify: true });
    expect(c.action === 'nudge' && /last check failed/.test(c.message)).toBe(true);

    const t2 = new RunTracker();
    t2.record('edit_file', { path: 'a.ts' }, 'ok', 'Edited');
    t2.record('run_command', { command: 'ls' }, 'ok', 'exit code 0\na.ts');
    t2.record('run_command', { command: 'git status' }, 'ok', 'exit code 0');
    expect(t2.unverifiedFiles()).toEqual(['a.ts']);
  });

  it('accepts clean diagnostics as a check, and not unavailable or failing ones', () => {
    const t = new RunTracker();
    t.record('edit_file', { path: 'a.ts' }, 'ok', 'Edited');
    t.record('get_diagnostics', {}, 'ok', 'Diagnostics are not available in this environment.');
    expect(t.unverifiedFiles()).toEqual(['a.ts']);
    t.record('get_diagnostics', {}, 'ok', 'a.ts:1:1 error: bad');
    expect(t.unverifiedFiles()).toEqual(['a.ts']);
    t.record('get_diagnostics', {}, 'ok', 'No errors or warnings.');
    expect(t.unverifiedFiles()).toEqual([]);
  });

  it('ignores failed or rejected edits, since nothing changed', () => {
    const t = new RunTracker();
    t.record('edit_file', { path: 'a.ts' }, 'error', 'old_string not found');
    t.record('edit_file', { path: 'b.ts' }, 'rejected', '');
    expect(t.unverifiedFiles()).toEqual([]);
  });

  it('can be switched off', () => {
    const t = new RunTracker();
    t.record('edit_file', { path: 'a.ts' }, 'ok', 'Edited');
    expect(t.checkFinish(undefined, { verify: false })).toEqual({ action: 'finish' });
  });
});

describe('RunTracker: the board', () => {
  it('sends the model back while tasks are pending or in progress', () => {
    const t = new RunTracker();
    const c = t.checkFinish(board(['Write code', 'done'], ['Add tests', 'pending'], ['Docs', 'in_progress']), { verify: true });
    expect(c.action).toBe('nudge');
    if (c.action === 'nudge') {
      expect(c.message).toContain('"Add tests"');
      expect(c.message).toContain('"Docs"');
      expect(c.message).not.toContain('"Write code"');
    }
  });

  it('lets it finish when everything is done or blocked, or there is no board', () => {
    expect(new RunTracker().checkFinish(board(['a', 'done'], ['b', 'blocked']), { verify: true })).toEqual({ action: 'finish' });
    expect(new RunTracker().checkFinish(emptyBoard(), { verify: true })).toEqual({ action: 'finish' });
    expect(new RunTracker().checkFinish(undefined, { verify: true })).toEqual({ action: 'finish' });
  });

  it('reports both problems in one nudge', () => {
    const t = new RunTracker();
    t.record('edit_file', { path: 'a.ts' }, 'ok', 'Edited');
    const c = t.checkFinish(board(['b', 'pending']), { verify: true });
    expect(c.action === 'nudge' && /a\.ts/.test(c.message) && /unfinished tasks/.test(c.message)).toBe(true);
  });

  it('gives up after two nudges, so a stubborn model cannot loop forever', () => {
    const t = new RunTracker();
    const b = board(['never done', 'pending']);
    expect(t.checkFinish(b, { verify: true }).action).toBe('nudge');
    expect(t.checkFinish(b, { verify: true }).action).toBe('nudge');
    const third = t.checkFinish(b, { verify: true });
    expect(third.action).toBe('finish-with-warning');
    if (third.action === 'finish-with-warning') expect(third.warning).toContain('never done');
  });
});

describe('RunTracker: repeated actions', () => {
  const call = (t: RunTracker, output = 'old_string not found') => t.record('edit_file', { path: 'a.ts', old_string: 'x', new_string: 'y' }, 'error', output);

  it('warns on the third identical call with the same result, and stops on the fifth', () => {
    const t = new RunTracker();
    expect([call(t), call(t), call(t), call(t), call(t)]).toEqual(['ok', 'ok', 'warn', 'warn', 'stop']);
  });

  it('does not count repeats whose result keeps changing (that is progress)', () => {
    const t = new RunTracker();
    const verdicts = [1, 2, 3, 4, 5, 6].map((i) => t.record('run_command', { command: 'npm test' }, 'ok', `exit code 1\n${7 - i} failing`));
    expect(verdicts.every((v) => v === 'ok')).toBe(true);
  });

  it('does not mix up different calls, and ignores the board tool', () => {
    const t = new RunTracker();
    for (let i = 0; i < 6; i++) {
      expect(t.record('read_file', { path: `f${i}.ts` }, 'ok', 'same output')).toBe('ok');
    }
    const t2 = new RunTracker();
    for (let i = 0; i < 6; i++) expect(t2.record('update_board', { notes: 'x' }, 'ok', 'Board updated')).toBe('ok');
  });

  it('treats the same input with keys in a different order as the same call', () => {
    const t = new RunTracker();
    t.record('edit_file', { path: 'a', old_string: 'x' }, 'error', 'nope');
    t.record('edit_file', { old_string: 'x', path: 'a' }, 'error', 'nope');
    expect(t.record('edit_file', { path: 'a', old_string: 'x' }, 'error', 'nope')).toBe('warn');
  });
});
