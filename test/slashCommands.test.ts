import { describe, expect, it } from 'vitest';
import { parseSlash, suggestSlash } from '../src/webview/slashCommands';

describe('suggestSlash', () => {
  it('lists every command for a bare slash', () => {
    expect(suggestSlash('/').map((c) => c.name)).toEqual(['new', 'undo', 'plan', 'model']);
  });
  it('filters by prefix, including aliases and case', () => {
    expect(suggestSlash('/pl').map((c) => c.name)).toEqual(['plan']);
    expect(suggestSlash('/cl').map((c) => c.name)).toEqual(['new']);
    expect(suggestSlash('/MO').map((c) => c.name)).toEqual(['model']);
  });
  it('shows nothing once the text is not just a command word', () => {
    expect(suggestSlash('hello')).toEqual([]);
    expect(suggestSlash('/plan something')).toEqual([]);
    expect(suggestSlash('/zzz')).toEqual([]);
    expect(suggestSlash('')).toEqual([]);
  });
});

describe('parseSlash', () => {
  it('matches exact commands and aliases', () => {
    expect(parseSlash('/new')?.name).toBe('new');
    expect(parseSlash('/clear')?.name).toBe('new');
    expect(parseSlash('  /undo  ')?.name).toBe('undo');
    expect(parseSlash('/PLAN')?.name).toBe('plan');
  });
  it('does not treat other text as a command, so it is sent to the model', () => {
    expect(parseSlash('/new chat please')).toBeNull();
    expect(parseSlash('/unknown')).toBeNull();
    expect(parseSlash('see /new')).toBeNull();
    expect(parseSlash('/etc/passwd')).toBeNull();
  });
});
