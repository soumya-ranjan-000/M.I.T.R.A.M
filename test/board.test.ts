import { describe, expect, it } from 'vitest';
import { BoardInputError, MAX_TASKS, applyBoardUpdate, boardProgress, describeBoard, emptyBoard, renderBoardForModel } from '../src/agent/board';

const task = (title: string, status = 'pending') => ({ title, status });

describe('applyBoardUpdate', () => {
  it('replaces the whole task list and keeps existing notes', () => {
    const b0 = { tasks: [{ title: 'old', status: 'done' as const }], notes: 'keep me' };
    const b1 = applyBoardUpdate(b0, { tasks: [task('a'), task('b', 'in_progress')] });
    expect(b1.tasks.map((t) => t.title)).toEqual(['a', 'b']);
    expect(b1.notes).toBe('keep me');
    expect(b0.tasks).toHaveLength(1); // input board is not mutated
  });

  it('replaces notes without touching tasks, and trims text', () => {
    const b0 = { tasks: [{ title: 'a', status: 'pending' as const }], notes: 'x' };
    const b1 = applyBoardUpdate(b0, { notes: '  new notes  ' });
    expect(b1).toEqual({ tasks: b0.tasks, notes: 'new notes' });
    expect(applyBoardUpdate(b0, { notes: '' }).notes).toBe('');
  });

  it('keeps task notes only when given', () => {
    const b = applyBoardUpdate(emptyBoard(), { tasks: [{ title: 'a', status: 'blocked', note: ' needs API key ' }, task('b')] });
    expect(b.tasks[0]).toEqual({ title: 'a', status: 'blocked', note: 'needs API key' });
    expect(b.tasks[1]).toEqual({ title: 'b', status: 'pending' });
  });

  it.each([
    [null, /object/],
    ['tasks', /object/],
    [[], /object/],
    [{}, /Provide/],
    [{ tasks: 'a' }, /array/],
    [{ tasks: ['do a thing'] }, /must be an object/],
    [{ tasks: [{ status: 'pending' }] }, /title is required/],
    [{ tasks: [{ title: '  ', status: 'pending' }] }, /must not be empty/],
    [{ tasks: [{ title: 'a' }] }, /status must be one of/],
    [{ tasks: [{ title: 'a', status: 'finished' }] }, /status must be one of/],
    [{ tasks: [{ title: 'x'.repeat(201), status: 'pending' }] }, /too long/],
    [{ tasks: [{ title: 'a', status: 'done', note: 5 }] }, /note must be a string/],
    [{ notes: 5 }, /must be a string/],
    [{ notes: 'x'.repeat(4001) }, /too long/],
  ])('rejects bad input %j', (input, message) => {
    expect(() => applyBoardUpdate(emptyBoard(), input)).toThrow(BoardInputError);
    expect(() => applyBoardUpdate(emptyBoard(), input)).toThrow(message);
  });

  it('caps the number of tasks', () => {
    const many = Array.from({ length: MAX_TASKS + 1 }, (_, i) => task(`t${i}`));
    expect(() => applyBoardUpdate(emptyBoard(), { tasks: many })).toThrow(/Too many tasks/);
    expect(applyBoardUpdate(emptyBoard(), { tasks: many.slice(0, MAX_TASKS) }).tasks).toHaveLength(MAX_TASKS);
  });
});

describe('boardProgress', () => {
  it('counts done tasks, and treats blocked tasks as not needing more work', () => {
    const b = applyBoardUpdate(emptyBoard(), { tasks: [task('a', 'done'), task('b', 'in_progress'), task('c'), task('d', 'blocked')] });
    const p = boardProgress(b);
    expect(p.total).toBe(4);
    expect(p.done).toBe(1);
    expect(p.unfinished.map((t) => t.title)).toEqual(['b', 'c']);
  });
});

describe('renderBoardForModel', () => {
  it('is empty for an empty board', () => {
    expect(renderBoardForModel(emptyBoard())).toBe('');
  });

  it('numbers tasks, shows status, task notes, progress and notes, and says it is not user instructions', () => {
    const b = applyBoardUpdate(emptyBoard(), {
      tasks: [task('Read utils', 'done'), task('Add slugify', 'in_progress'), { title: 'Deploy', status: 'blocked', note: 'needs creds' }],
      notes: 'tests: npm test',
    });
    const out = renderBoardForModel(b);
    expect(out.startsWith('<board>')).toBe(true);
    expect(out.endsWith('</board>')).toBe(true);
    expect(out).toContain('Progress: 1 of 3 done');
    expect(out).toContain('1. [done] Read utils');
    expect(out).toContain('2. [in progress] Add slugify');
    expect(out).toContain('3. [blocked] Deploy (needs creds)');
    expect(out).toContain('Notes:\ntests: npm test');
    expect(out).toMatch(/not instructions from the user/);
  });

  it('can show notes alone', () => {
    const out = renderBoardForModel({ tasks: [], notes: 'just a note' });
    expect(out).toContain('just a note');
    expect(out).not.toContain('Progress');
  });
});

describe('describeBoard', () => {
  it('summarises counts', () => {
    expect(describeBoard(emptyBoard())).toBe('Board updated (no tasks).');
    const b = applyBoardUpdate(emptyBoard(), { tasks: [task('a', 'done'), task('b', 'in_progress'), task('c'), task('d', 'blocked')] });
    expect(describeBoard(b)).toBe('Board updated: 1 of 4 done, 1 in progress, 1 pending, 1 blocked.');
  });
});
