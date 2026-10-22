import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/tools';
import { nodeFilePort } from '../src/tools/NodeFilePort';
import { ToolContext } from '../src/tools/Tool';
import { globToRegExp } from '../src/tools/walk';

let tmp: string;
let root: string;
const registry = createDefaultRegistry();

function ctx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return { root, signal, files: nodeFilePort };
}
const run = (name: string, input: unknown, c = ctx()) => registry.get(name)!.run(input, c);

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-tools-'));
  root = path.join(tmp, 'ws');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/a.ts'), 'const a = 1;\nconst b = 2;\nconst a2 = 3;\n');
  await fs.writeFile(path.join(root, 'src/b.tsx'), 'export const Hello = () => null;\n');
  await fs.writeFile(path.join(root, 'node_modules/pkg/x.js'), 'const a = 1;\n');
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  await fs.writeFile(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\n');
  await fs.writeFile(path.join(tmp, 'secret.txt'), 'secret');
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

describe('globToRegExp', () => {
  it('matches names, paths and braces', () => {
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.tsx')).toBe(false);
    expect(globToRegExp('src/**/*.tsx').test('src/deep/er/b.tsx')).toBe(true);
    expect(globToRegExp('src/**/*.tsx').test('src/b.tsx')).toBe(true);
    expect(globToRegExp('*.{ts,tsx}').test('b.tsx')).toBe(true);
    expect(globToRegExp('package.json').test('a/package.json')).toBe(true);
  });
});

describe('read_file', () => {
  it('returns numbered lines and supports ranges', async () => {
    expect(await run('read_file', { path: 'src/a.ts', start_line: 2, end_line: 2 })).toBe(
      '2\tconst b = 2;\n[showing lines 2-2 of 4]',
    );
    expect(await run('read_file', { path: 'src/a.ts' })).toContain('1\tconst a = 1;');
  });

  it('rejects escapes, binaries, directories and missing files', async () => {
    await expect(run('read_file', { path: '../secret.txt' })).rejects.toThrow(/outside the workspace/);
    await expect(run('read_file', { path: 'bin.dat' })).rejects.toThrow(/binary/);
    await expect(run('read_file', { path: 'src' })).rejects.toThrow(/directory/);
    await expect(run('read_file', { path: 'nope.ts' })).rejects.toThrow(/not found/);
    await expect(run('read_file', {})).rejects.toThrow(/"path" is required/);
  });
});

describe('list_dir / find_files / search_files', () => {
  it('lists directories first', async () => {
    const out = await run('list_dir', {});
    expect(out.split('\n')[0]).toBe('node_modules/');
    expect(out).toContain('src/');
  });

  it('finds files and skips node_modules', async () => {
    expect(await run('find_files', { glob: '*.ts' })).toBe('src/a.ts');
    expect(await run('find_files', { glob: '*.js' })).toBe('No files found.');
  });

  it('searches contents with glob filtering, skipping node_modules and binaries', async () => {
    const out = await run('search_files', { pattern: 'const a\\b' });
    expect(out).toBe('src/a.ts:1: const a = 1;');
    expect(await run('search_files', { pattern: 'hello', case_insensitive: true, glob: '*.tsx' })).toContain('src/b.tsx:1');
    expect(await run('search_files', { pattern: 'zzz' })).toBe('No matches.');
    await expect(run('search_files', { pattern: '(' })).rejects.toThrow(/Invalid regular expression/);
  });
});

describe('edit_file / create_file', () => {
  it('edits a unique string and reports the count', async () => {
    await fs.writeFile(path.join(root, 'e1.txt'), 'alpha beta gamma');
    expect(await run('edit_file', { path: 'e1.txt', old_string: 'beta', new_string: 'BETA' })).toMatch(/1 replacement/);
    expect(await fs.readFile(path.join(root, 'e1.txt'), 'utf8')).toBe('alpha BETA gamma');
  });

  it('refuses ambiguous or missing matches, unless replace_all', async () => {
    await fs.writeFile(path.join(root, 'e2.txt'), 'x x x');
    await expect(run('edit_file', { path: 'e2.txt', old_string: 'x', new_string: 'y' })).rejects.toThrow(/3 times/);
    await expect(run('edit_file', { path: 'e2.txt', old_string: 'q', new_string: 'y' })).rejects.toThrow(/not found/);
    await run('edit_file', { path: 'e2.txt', old_string: 'x', new_string: 'y', replace_all: true });
    expect(await fs.readFile(path.join(root, 'e2.txt'), 'utf8')).toBe('y y y');
  });

  it('does not interpret $ patterns in the replacement', async () => {
    await fs.writeFile(path.join(root, 'e3.txt'), 'price');
    await run('edit_file', { path: 'e3.txt', old_string: 'price', new_string: '$& $1' });
    expect(await fs.readFile(path.join(root, 'e3.txt'), 'utf8')).toBe('$& $1');
  });

  it('matches CRLF files when the model sends LF', async () => {
    await run('edit_file', { path: 'crlf.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' });
    expect(await fs.readFile(path.join(root, 'crlf.txt'), 'utf8')).toBe('uno\r\ndos\r\n');
  });

  it('blocks writes outside the workspace and edits to missing files', async () => {
    await expect(run('edit_file', { path: '../secret.txt', old_string: 's', new_string: 't' })).rejects.toThrow(/outside/);
    await expect(run('create_file', { path: '../evil.txt', content: 'x' })).rejects.toThrow(/outside/);
    await expect(run('edit_file', { path: 'missing.txt', old_string: 'a', new_string: 'b' })).rejects.toThrow(/not found/);
    expect(await fs.readFile(path.join(tmp, 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('creates files (with parent dirs) but never overwrites', async () => {
    await run('create_file', { path: 'new/dir/f.txt', content: 'hi\n' });
    expect(await fs.readFile(path.join(root, 'new/dir/f.txt'), 'utf8')).toBe('hi\n');
    await expect(run('create_file', { path: 'new/dir/f.txt', content: 'again' })).rejects.toThrow(/already exists/);
  });
});

describe('run_command', () => {
  const preview = (command: unknown) => registry.get('run_command')!.preview({ command });

  it('shows a short command on one line only', () => {
    expect(preview('npm test')).toEqual({ summary: 'Run: npm test', detail: undefined });
  });

  it('shows the whole of a long or multi-line command, so it can be read before approving', () => {
    const long = 'npx vitest run test/tools.test.ts --reporter=verbose';
    expect(preview(long)).toEqual({ summary: `Run: ${long}`, detail: long });

    const script = "cat > /tmp/t.js <<'EOF'\nconst fs = require('fs');\nEOF\nnode /tmp/t.js";
    expect(preview(script)).toEqual({ summary: "Run: cat > /tmp/t.js <<'EOF' …", detail: script });
  });

  it('previews malformed input without throwing', () => {
    expect(registry.get('run_command')!.preview(null).summary).toBe('Run: ');
  });

  it('captures output and exit code in the workspace root', async () => {
    const out = await run('run_command', { command: 'echo hi && pwd' });
    expect(out).toContain('exit code 0');
    expect(out).toContain('hi');
    expect(out).toContain(await fs.realpath(root));
  });

  it('reports non-zero exit codes and stderr', async () => {
    const out = await run('run_command', { command: 'echo oops 1>&2; exit 3' });
    expect(out).toContain('exit code 3');
    expect(out).toContain('oops');
  });

  it('kills commands that exceed the timeout', async () => {
    const started = Date.now();
    const out = await run('run_command', { command: 'sleep 30', timeout_seconds: 1 });
    expect(out).toMatch(/Timed out after 1s/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('is cancelled by the abort signal', async () => {
    const ac = new AbortController();
    const p = run('run_command', { command: 'sleep 30' }, ctx(ac.signal));
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toThrow(/Cancelled/);
  });

  it('reports output while the command is still running', async () => {
    const seen: string[] = [];
    const out = await run('run_command', { command: 'echo first; sleep 1; echo second' }, { ...ctx(), progress: (o) => seen.push(o) });
    expect(seen[0]).toBe('first\n');
    expect(out).toMatch(/first\nsecond/);
  });
});

describe('registry', () => {
  it('exposes every tool definition and marks mutating tools for approval', () => {
    const names = registry.definitions().map((d) => d.name).sort();
    expect(names).toEqual(
      ['create_file', 'edit_file', 'find_files', 'get_diagnostics', 'list_dir', 'read_file', 'run_command', 'search_files', 'update_board'],
    );
    for (const n of ['edit_file', 'create_file', 'run_command']) expect(registry.get(n)!.requiresApproval).toBe(true);
    for (const n of ['read_file', 'list_dir', 'search_files', 'find_files', 'get_diagnostics', 'update_board']) {
      expect(registry.get(n)!.requiresApproval).toBe(false);
    }
  });
});

describe('registry.readOnly (plan mode)', () => {
  it('keeps only tools that never change anything', () => {
    const ro = registry.readOnly();
    expect(ro.definitions().map((d) => d.name).sort()).toEqual(['find_files', 'get_diagnostics', 'list_dir', 'read_file', 'search_files', 'update_board']);
    expect(ro.get('edit_file')).toBeUndefined();
    expect(ro.get('create_file')).toBeUndefined();
    expect(ro.get('run_command')).toBeUndefined();
    expect(registry.size).toBe(9); // the original is untouched
  });
});

describe('error paths and limits', () => {
  it('get_diagnostics reports unavailability, and passes the path through when it can', async () => {
    expect(await run('get_diagnostics', {})).toMatch(/not available/);
    const seen: (string | undefined)[] = [];
    const c = { ...ctx(), diagnostics: async (p?: string) => (seen.push(p), 'a.ts:1:1 error: bad') };
    expect(await run('get_diagnostics', { path: 'a.ts' }, c)).toBe('a.ts:1:1 error: bad');
    expect(await run('get_diagnostics', {}, c)).toBe('a.ts:1:1 error: bad');
    expect(seen).toEqual(['a.ts', undefined]);
  });

  it('read_file rejects impossible ranges', async () => {
    await expect(run('read_file', { path: 'src/a.ts', start_line: 99 })).rejects.toThrow(/past the end/);
    await expect(run('read_file', { path: 'src/a.ts', start_line: 3, end_line: 1 })).rejects.toThrow(/end_line/);
    await expect(run('read_file', { path: 'src/a.ts', start_line: 1.5 })).rejects.toThrow(/integer/);
  });

  it('edit_file rejects empty and no-op replacements', async () => {
    await fs.writeFile(path.join(root, 'p.txt'), 'abc');
    await expect(run('edit_file', { path: 'p.txt', old_string: '', new_string: 'x' })).rejects.toThrow(/must not be empty/);
    await expect(run('edit_file', { path: 'p.txt', old_string: 'a', new_string: 'a' })).rejects.toThrow(/identical/);
  });

  it('rejects wrongly typed input instead of crashing', async () => {
    await expect(run('read_file', { path: 42 })).rejects.toThrow(/must be a string/);
    await expect(run('search_files', { pattern: 'a', case_insensitive: 'yes' })).rejects.toThrow(/boolean/);
    await expect(run('read_file', 'not an object')).rejects.toThrow(/JSON object/);
    await expect(run('read_file', null)).rejects.toThrow(/JSON object/);
  });

  it('list_dir handles empty and missing directories', async () => {
    await fs.mkdir(path.join(root, 'emptydir'));
    expect(await run('list_dir', { path: 'emptydir' })).toBe('(empty directory)');
    await expect(run('list_dir', { path: 'nope' })).rejects.toThrow(/not found/);
    await expect(run('list_dir', { path: '../' })).rejects.toThrow(/outside/);
  });

  it('search_files stops at max_results and says so', async () => {
    await fs.writeFile(path.join(root, 'many.txt'), Array.from({ length: 10 }, (_, i) => `hit ${i}`).join('\n'));
    const out = await run('search_files', { pattern: 'hit', max_results: 3, path: '.', glob: 'many.txt' });
    expect(out.split('\n').filter((l) => l.startsWith('many.txt:'))).toHaveLength(3);
    expect(out).toMatch(/stopped at 3 matches/);
  });

  it('run_command rejects an empty command', async () => {
    await expect(run('run_command', { command: '   ' })).rejects.toThrow(/must not be empty/);
  });
});

describe('update_board', () => {
  const withBoard = () => {
    let board = { tasks: [] as any[], notes: '' };
    const access = { get: () => board, set: (b: typeof board) => { board = b; } };
    return { c: { ...ctx(), board: access }, current: () => board };
  };

  it('stores the plan and confirms briefly', async () => {
    const { c, current } = withBoard();
    const out = await run('update_board', { tasks: [{ title: 'a', status: 'done' }, { title: 'b', status: 'pending' }], notes: 'n' }, c);
    expect(out).toBe('Board updated: 1 of 2 done, 1 pending.');
    expect(current().tasks).toHaveLength(2);
    expect(current().notes).toBe('n');
  });

  it('turns bad input into a model-readable error and leaves the board unchanged', async () => {
    const { c, current } = withBoard();
    await run('update_board', { tasks: [{ title: 'keep', status: 'pending' }] }, c);
    await expect(run('update_board', { tasks: [{ title: 'x', status: 'finished' }] }, c)).rejects.toThrow(/status must be one of/);
    expect(current().tasks.map((t: any) => t.title)).toEqual(['keep']);
  });

  it('does not need approval and says so when no board is available', async () => {
    expect(registry.get('update_board')!.requiresApproval).toBe(false);
    await expect(run('update_board', { notes: 'x' })).rejects.toThrow(/not available/);
  });
});
