import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeIndex, forEachTerm, hashTerm, listWorkspaceFiles, stem, terms, walkWorkspaceFiles } from '../src/agent/codeIndex';
import { Retriever, bestWindow, formatRetrieved, isConfident, retrieve } from '../src/agent/retrieve';

const exec = promisify(execFile);

let base: string;
beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-retrieval-test-'));
});
afterAll(() => fs.rm(base, { recursive: true, force: true }));

async function workspace(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(base, 'ws-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

async function indexOf(files: Record<string, string | Buffer>): Promise<CodeIndex> {
  const index = new CodeIndex(await workspace(files), walkWorkspaceFiles);
  await index.refresh();
  return index;
}

/**
 * Unrelated files, so that term statistics look like a real project's. In a workspace of two or three
 * files every term is common, scores stay low, and the gate (rightly) attaches nothing.
 */
const FILLER = Object.fromEntries(
  Array.from({ length: 30 }, (_, i) => [`lib/util${i}.ts`, `export function format${i}(value: number) {\n  return value.toFixed(${i % 4});\n}\n`]),
);

const lines = (...l: string[]) => l.join('\n') + '\n';

const TRACKER = lines(
  'export class RunTracker {',
  '  private readonly recent: Call[] = [];',
  '  /** Stop when the same tool call keeps giving the same result. */',
  '  record(name: string, input: unknown): RepeatVerdict {',
  '    const same = this.recent.filter((r) => r.signature === signature).length;',
  "    if (same >= STOP_AT) return 'stop';",
  "    return 'ok';",
  '  }',
  '}',
);

describe('terms', () => {
  it('stems word forms onto one term', () => {
    const pairs = [
      ['summarised', 'summarize'],
      ['cached', 'cache'],
      ['caching', 'cache'],
      ['dropped', 'drop'],
      ['logs', 'logging'],
      ['sessions', 'session'],
      ['highlighted', 'highlight'],
      ['entries', 'entry'],
      ['statuses', 'status'],
      ['verified', 'verify'],
    ];
    for (const [a, b] of pairs) expect(stem(a), `${a} vs ${b}`).toBe(stem(b));
    expect(stem('run')).toBe('run');
  });

  it('keeps identifiers whole and splits them into parts', () => {
    expect(terms('autoApproveEdits')).toEqual([stem('autoapproveedits'), 'auto', stem('approve'), stem('edits')]);
    expect(terms('MAX_RESULT_CHARS')).toEqual([stem('max_result_chars'), 'max', 'result', stem('chars')]);
    expect(terms('XMLHttpRequest')).toEqual(['xmlhttprequest', 'xml', 'http', 'request']);
  });

  it('drops stopwords, short words and numbers', () => {
    expect(terms('Please fix the bug in it, thanks! 404')).toEqual(['bug']);
  });

  it('reports the identifier a part came from', () => {
    const words: string[] = [];
    forEachTerm('cache_control', (_term, word) => words.push(word));
    expect(new Set(words)).toEqual(new Set(['cache_control']));
  });
});

describe('CodeIndex', () => {
  it('ranks the file whose name and contents match first', async () => {
    const index = await indexOf({
      'src/runTracker.ts': TRACKER,
      'src/board.ts': 'export function emptyBoard() { return { tasks: [] }; }\n',
      'src/agentLoop.ts': 'import { RunTracker } from "./runTracker";\nconst tracker = new RunTracker();\n',
    });
    const { hits } = index.search('the agent repeats the same tool call; make the tracker stop sooner');
    expect(hits[0].path).toBe('src/runTracker.ts');
    expect(hits[0].matched).toEqual(expect.arrayContaining(['tool', 'call', 'tracker', 'stop']));
    expect(hits.map((h) => h.path)).not.toContain('src/board.ts');
  });

  it('prefers code over its tests and docs unless the message asks for them', async () => {
    const index = await indexOf({
      'src/tracker.ts': TRACKER,
      'test/tracker.test.ts': TRACKER,
      'README.md': TRACKER,
    });
    expect(index.search('same tool call stop').hits[0].path).toBe('src/tracker.ts');
    expect(index.search('tests for same tool call stop').hits[0].path).toBe('test/tracker.test.ts');
    expect(index.search('readme section on same tool call stop').hits[0].path).toBe('README.md');
  });

  it('keeps code above its tests when a message only mentions running them', async () => {
    const index = await indexOf({
      ...FILLER,
      'src/tracker.ts': TRACKER,
      'test/tracker.test.ts': TRACKER + TRACKER,
    });
    expect(index.search('the stop call fires even though I ran the tests').hits[0].path).toBe('src/tracker.ts');
    expect(index.search('add a test for the stop call').hits[0].path).toBe('test/tracker.test.ts');
  });

  it('finds code that uses a shorter form or a synonym of the message\'s word', async () => {
    const index = await indexOf({
      ...FILLER,
      'src/models.ts': 'export async function pickModel(names: string[]) {\n  return names[0];\n}\n',
      'src/checkpoint.ts': 'export function restoreFiles(saved: Map<string, string>) {\n  return saved;\n}\n',
    });
    expect(index.search('the model picker').hits[0].path).toBe('src/models.ts');
    const revert = index.search('revert the files');
    expect(revert.hits[0]).toMatchObject({ path: 'src/checkpoint.ts', matched: expect.arrayContaining(['revert']) });
  });

  it('returns nothing for a message with no search terms', async () => {
    const index = await indexOf({ 'a.ts': TRACKER });
    expect(index.search('yes, go ahead').hits).toEqual([]);
  });

  it('skips lockfiles, maps, minified and binary files, large files, ignored dirs and symlinks', async () => {
    const word = 'zebrafish ';
    const dir = await workspace({
      'src/keep.ts': word,
      'package-lock.json': word,
      'dist2/app.min.js': word,
      'src/app.js.map': word,
      'media/logo.svg': word,
      'src/blob.bin': Buffer.from([0x7a, 0x00, 0x7a]),
      'src/huge.ts': word.repeat(60_000),
      'node_modules/pkg/index.js': word,
    });
    await fs.symlink(path.join(dir, 'src/keep.ts'), path.join(dir, 'src/link.ts'));
    const index = new CodeIndex(dir, walkWorkspaceFiles);
    await index.refresh();
    expect(index.search('zebrafish').hits.map((h) => h.path)).toEqual(['src/keep.ts']);
  });

  it('refreshes changed, new and deleted files', async () => {
    const dir = await workspace({ 'a.ts': 'const alpha = 1;\n', 'b.ts': 'const beta = 2;\n' });
    const index = new CodeIndex(dir, walkWorkspaceFiles);
    expect(await index.refresh()).toMatchObject({ files: 2, added: 2 });
    expect(await index.refresh()).toMatchObject({ added: 0, updated: 0, removed: 0 });

    await fs.writeFile(path.join(dir, 'a.ts'), 'const gamma = 1; // longer now\n');
    await fs.writeFile(path.join(dir, 'c.ts'), 'const alpha = 3;\n');
    await fs.rm(path.join(dir, 'b.ts'));
    expect(await index.refresh()).toMatchObject({ files: 2, added: 1, updated: 1, removed: 1 });
    expect(index.search('alpha').hits.map((h) => h.path)).toEqual(['c.ts']);
    expect(index.search('gamma').hits.map((h) => h.path)).toEqual(['a.ts']);
    expect(index.search('beta').hits).toEqual([]);
  });

  it('respects .gitignore in a git repository and includes untracked files', async () => {
    const dir = await workspace({
      '.gitignore': 'generated/\n',
      'src/tracked.ts': 'x',
      'src/untracked.ts': 'x',
      'generated/out.ts': 'x',
    });
    try {
      await exec('git', ['init', '-q'], { cwd: dir });
      await exec('git', ['add', '.gitignore', 'src/tracked.ts'], { cwd: dir });
    } catch {
      return; // no git here: the walk fallback is covered by the other tests
    }
    expect((await listWorkspaceFiles(dir)).sort()).toEqual(['.gitignore', 'src/tracked.ts', 'src/untracked.ts']);
  });
});

describe('retrieve', () => {
  it('attaches nothing for chatter, and something for a request', async () => {
    const index = await indexOf({ ...FILLER, 'src/runTracker.ts': TRACKER, 'src/thinking.ts': 'export function think() {}\n' });
    for (const message of ['what do you think?', 'thanks, looks good', 'yes, go ahead']) {
      expect((await retrieve(index, message)).block, message).toBe('');
    }
    const result = await retrieve(index, 'the tool call repeats without stopping');
    expect(result.files.map((f) => f.path)).toEqual(['src/runTracker.ts']);
    expect(result.block).toMatch(/^<retrieved>\nsrc\/runTracker\.ts:1-9 \(.*\)\n<snippet path="src\/runTracker\.ts" lines="1-9">\n/);
    expect(result.block.endsWith('</snippet>\n</retrieved>')).toBe(true);
  });

  it('accepts a single match when the message names an identifier', () => {
    const hit = { path: 'a.ts', score: 10, matched: ['runTracker'] };
    const qs = terms('runTracker').map((t) => ({ term: t, word: 'runTracker', hash: 0, idf: 1 }));
    expect(isConfident('runTracker', qs, [hit])).toBe(true);
    expect(isConfident('tracker', qs, [hit])).toBe(false);
    expect(isConfident('runTracker', qs, [{ ...hit, score: 1 }])).toBe(false);
  });

  it('accepts two matched words in any of the top three files', () => {
    const qs = ['model', 'picker'].map((w) => ({ term: w, word: w, hash: 0, idf: 1 }));
    const one = (path: string, matched: string[]) => ({ path, score: 10, matched });
    expect(isConfident('model picker', qs, [one('a', ['model']), one('b', ['model']), one('c', ['model', 'picker'])])).toBe(true);
    expect(isConfident('model picker', qs, [one('a', ['model']), one('b', ['model']), one('c', ['model']), one('d', ['model', 'picker'])])).toBe(false);
  });

  it('leaves out files that are already attached', async () => {
    const index = await indexOf({ ...FILLER, 'src/runTracker.ts': TRACKER, 'src/loop.ts': TRACKER.replace('RunTracker', 'Loop') });
    const result = await retrieve(index, 'tool call stop', { exclude: ['src/runTracker.ts'] });
    expect(result.files.map((f) => f.path)).toEqual(['src/loop.ts']);
  });

  it('gives excerpts for the top two files only, within the budget', async () => {
    const files = Object.fromEntries(['a', 'b', 'c'].map((n) => [`src/${n}.ts`, TRACKER]));
    const result = await retrieve(await indexOf({ ...FILLER, ...files }), 'tool call stop');
    expect(result.files).toHaveLength(3);
    expect(result.files.filter((f) => f.snippet)).toHaveLength(2);
    expect(result.block.length).toBeLessThan(5_100);
  });

  it('picks the window with the most matching terms', () => {
    const text = ['tool', ...Array(48).fill('filler'), 'const x = stop;', 'tool call here', ...Array(50).fill('filler')];
    const qs = ['stop', 'tool', 'call'].map((t) => ({ term: t, word: t, hash: hashTerm(t), idf: 1 }));
    // Lines 50-51 cover all three terms; three lines of lead-in come before them.
    expect(bestWindow(text, qs)).toEqual({ start: 46, end: 66 });
  });

  it('formats paths safely and keeps snippets that fit', () => {
    const files = [
      { path: 'a "b".ts', startLine: 1, endLine: 2, matched: ['x'], snippet: 'one\ntwo' },
      { path: 'c.ts', startLine: 5, endLine: 6, matched: ['x', 'y'], snippet: 'z'.repeat(400) },
    ];
    const block = formatRetrieved(files, 300);
    expect(block).toContain('<snippet path="a &quot;b&quot;.ts" lines="1-2">\none\ntwo\n</snippet>');
    expect(block).toContain('c.ts:5-6 (x, y)');
    expect(block).not.toContain('zzz'); // didn't fit
    expect(formatRetrieved([])).toBe('');
  });
});

describe('Retriever', () => {
  it('skips a message while the first build is still running, then serves later ones', async () => {
    const root = await workspace({ ...FILLER, 'src/runTracker.ts': TRACKER });
    const log: string[] = [];
    const retriever = new Retriever((m) => log.push(m), { firstBuildMs: 0, refreshMs: 0 });
    expect(await retriever.retrieve(root, 'tool call stop')).toEqual({ files: [], block: '' });
    expect(log.some((m) => m.startsWith('retrieval skipped'))).toBe(true);
    await retriever.warm(root);
    const result = await retriever.retrieve(root, 'tool call stop');
    expect(result.files.map((f) => f.path)).toEqual(['src/runTracker.ts']);
    expect(result.block).toContain('src/runTracker.ts');
    retriever.dispose();
  });

  it('starts a new index when the workspace changes', async () => {
    const a = await workspace({ ...FILLER, 'alpha.ts': TRACKER });
    const b = await workspace({ ...FILLER, 'beta.ts': TRACKER });
    const retriever = new Retriever(() => {});
    expect((await retriever.retrieve(a, 'tool call stop')).block).toContain('alpha.ts');
    const fromB = (await retriever.retrieve(b, 'tool call stop')).block;
    expect(fromB).toContain('beta.ts');
    expect(fromB).not.toContain('alpha.ts');
    retriever.dispose();
  });
});
