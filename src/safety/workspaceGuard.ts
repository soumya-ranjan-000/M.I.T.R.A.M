import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves `relPath` against `root` and returns the absolute path, or null if it
 * escapes the workspace (via `..`, an absolute path, or a symlink pointing outside).
 * Every file tool must go through this.
 */
export async function resolveInWorkspace(root: string, relPath: string): Promise<string | null> {
  const realRoot = await fs.realpath(root);
  const abs = path.resolve(realRoot, relPath);
  if (!isInside(realRoot, abs)) return null;

  // Resolve symlinks on the deepest existing ancestor so new files are checked too.
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      return isInside(realRoot, real) ? abs : null;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}
