import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode-test',
  'coverage', '__pycache__', '.venv', 'venv', 'target',
]);

/** Yields absolute paths of regular files under `start`, skipping ignored dirs and symlinks. */
export async function* walkFiles(start: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stack = [start];
  while (stack.length > 0) {
    if (signal?.aborted) return;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) subdirs.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
    // Reverse so the stack pops subdirectories in alphabetical order.
    for (const d of subdirs.reverse()) stack.push(d);
  }
}

/**
 * Converts a glob to a RegExp. Supports *, **, ? and {a,b}.
 * Globs without a "/" match the file name only; others match the relative path.
 */
export function globToRegExp(glob: string): RegExp {
  const matchesName = !glob.includes('/');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
        i = end;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(matchesName ? `(?:^|/)${re}$` : `^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
