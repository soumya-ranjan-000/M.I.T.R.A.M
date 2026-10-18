import { describe, expect, it } from 'vitest';
import { formatUserMessage, truncate } from '../src/agent/ContextBuilder';

describe('formatUserMessage', () => {
  it('returns the text unchanged with no context', () => {
    expect(formatUserMessage('hi', [])).toBe('hi');
  });

  it('wraps selection and file parts before the user text', () => {
    const out = formatUserMessage('explain', [
      { kind: 'selection', path: 'a.ts', startLine: 2, endLine: 4, text: 'code' },
      { kind: 'file', path: 'b.ts', text: 'more', truncated: true },
    ]);
    expect(out).toContain('<selection path="a.ts" lines="2-4">\ncode\n</selection>');
    expect(out).toContain('[file truncated]');
    expect(out.endsWith('\n\nexplain')).toBe(true);
  });
});

describe('truncate', () => {
  it('truncates only past the limit', () => {
    expect(truncate('abc', 5)).toEqual({ text: 'abc', truncated: false });
    expect(truncate('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
  });
});

import { formatEnvironment } from '../src/agent/environment';
import { INSTRUCTIONS_FILE, loadProjectInstructions } from '../src/agent/projectInstructions';
import { buildSystemPrompt } from '../src/agent/SystemPrompt';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('formatEnvironment', () => {
  it('is empty when there is nothing to report', () => {
    expect(formatEnvironment({ openTabs: [] })).toBe('');
  });

  it('lists tabs, branch, diff stat and diagnostics, capped', () => {
    const out = formatEnvironment({
      openTabs: Array.from({ length: 20 }, (_, i) => `f${i}.ts`),
      branch: 'main',
      diffStat: ' a.ts | 2 +-',
      diagnostics: 'a.ts:1:1 error: bad',
    });
    expect(out.startsWith('<environment>')).toBe(true);
    expect(out).toContain('f14.ts');
    expect(out).not.toContain('f15.ts');
    expect(out).toContain('(5 more)');
    expect(out).toContain('Git branch: main');
    expect(out).toContain('a.ts | 2 +-');
    expect(out).toContain('error: bad');
  });
});

describe('formatUserMessage with environment', () => {
  it('puts the environment before context and text', () => {
    const env = formatEnvironment({ openTabs: ['a.ts'] });
    const out = formatUserMessage('hi', [{ kind: 'file', path: 'a.ts', text: 'x', truncated: false }], env);
    expect(out.indexOf('<environment>')).toBeLessThan(out.indexOf('<context>'));
    expect(out.endsWith('\n\nhi')).toBe(true);
    expect(formatUserMessage('hi', [], env)).toBe(`${env}\n\nhi`);
    expect(formatUserMessage('hi', [])).toBe('hi');
  });
});

describe('project instructions', () => {
  it('loads MITRAM.md, ignores empty or missing files, and truncates huge ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-instr-'));
    try {
      expect(await loadProjectInstructions(dir)).toBeNull();
      await fs.writeFile(path.join(dir, INSTRUCTIONS_FILE), '   \n');
      expect(await loadProjectInstructions(dir)).toBeNull();
      await fs.writeFile(path.join(dir, INSTRUCTIONS_FILE), 'Use tabs.');
      expect(await loadProjectInstructions(dir)).toBe('Use tabs.');
      await fs.writeFile(path.join(dir, INSTRUCTIONS_FILE), 'x'.repeat(30_000));
      expect(await loadProjectInstructions(dir)).toMatch(/\[MITRAM.md truncated\]$/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('adds instructions to the system prompt without letting them override safety rules', () => {
    const base = { root: '/ws', platform: 'linux', date: '2026-10-18' };
    expect(buildSystemPrompt(base)).not.toContain('project_instructions');
    const withIt = buildSystemPrompt({ ...base, projectInstructions: 'Use tabs.' });
    expect(withIt).toContain('<project_instructions>\nUse tabs.\n</project_instructions>');
    expect(withIt).toMatch(/never override the safety rules/);
  });

  it('adds plan-mode instructions only when asked', () => {
    const base = { root: '/ws', platform: 'linux', date: '2026-10-18' };
    expect(buildSystemPrompt(base)).not.toContain('PLAN MODE');
    expect(buildSystemPrompt({ ...base, planMode: true })).toMatch(/PLAN MODE is on[\s\S]*read-only tools/);
  });
});
