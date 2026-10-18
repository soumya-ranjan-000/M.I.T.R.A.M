import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveInWorkspace } from '../safety/workspaceGuard';
import { Tool, ToolInputError, optBool, optInt, optString, reqString } from './Tool';
import { globToRegExp, toPosix, walkFiles } from './walk';

const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 300;
const DEFAULT_MAX_RESULTS = 100;
const MAX_FIND_RESULTS = 200;

async function resolveDir(ctx: { root: string }, rel: string | undefined): Promise<string> {
  const abs = await resolveInWorkspace(ctx.root, rel || '.');
  if (!abs) throw new ToolInputError(`Path "${rel}" is outside the workspace.`);
  return abs;
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Search file contents with a regular expression (JavaScript syntax). Returns "path:line: text" matches. ' +
    'Skips node_modules, .git, build output and binary files. Use glob to restrict which files are searched.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Workspace-relative directory to search in. Defaults to the root.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.tsx".' },
      case_insensitive: { type: 'boolean', description: 'Ignore case. Defaults to false.' },
      max_results: { type: 'integer', description: `Maximum matches to return. Defaults to ${DEFAULT_MAX_RESULTS}.` },
    },
    required: ['pattern'],
  },
  requiresApproval: false,
  preview: (input) => ({ summary: `Search for /${(input as { pattern?: string })?.pattern ?? ''}/` }),
  async run(input, ctx) {
    const pattern = reqString(input, 'pattern');
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, optBool(input, 'case_insensitive') ? 'i' : '');
    } catch (e) {
      throw new ToolInputError(`Invalid regular expression: ${(e as Error).message}`);
    }
    const dir = await resolveDir(ctx, optString(input, 'path'));
    const glob = optString(input, 'glob');
    const globRe = glob ? globToRegExp(glob) : null;
    const max = Math.max(1, optInt(input, 'max_results') ?? DEFAULT_MAX_RESULTS);

    const root = await fs.realpath(ctx.root);
    const results: string[] = [];
    let capped = false;

    for await (const file of walkFiles(dir, ctx.signal)) {
      const rel = toPosix(path.relative(root, file));
      if (globRe && !globRe.test(rel)) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text === null || text.slice(0, 8000).includes('\0')) continue;

      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;
        const line = lines[i].length > MAX_LINE_CHARS ? lines[i].slice(0, MAX_LINE_CHARS) + '…' : lines[i];
        results.push(`${rel}:${i + 1}: ${line.trim()}`);
        if (results.length >= max) {
          capped = true;
          break;
        }
      }
      if (capped) break;
    }

    if (results.length === 0) return 'No matches.';
    return capped ? `${results.join('\n')}\n[stopped at ${max} matches; narrow the search]` : results.join('\n');
  },
};

export const findFilesTool: Tool = {
  name: 'find_files',
  description:
    'Find files by name using a glob, e.g. "*.test.ts", "package.json" or "src/**/*.tsx". ' +
    'Returns workspace-relative paths.',
  inputSchema: {
    type: 'object',
    properties: {
      glob: { type: 'string', description: 'Glob to match. Without a "/" it matches file names anywhere.' },
      path: { type: 'string', description: 'Workspace-relative directory to search in. Defaults to the root.' },
    },
    required: ['glob'],
  },
  requiresApproval: false,
  preview: (input) => ({ summary: `Find ${(input as { glob?: string })?.glob ?? ''}` }),
  async run(input, ctx) {
    const glob = globToRegExp(reqString(input, 'glob'));
    const dir = await resolveDir(ctx, optString(input, 'path'));
    const root = await fs.realpath(ctx.root);
    const found: string[] = [];
    for await (const file of walkFiles(dir, ctx.signal)) {
      const rel = toPosix(path.relative(root, file));
      if (glob.test(rel)) found.push(rel);
      if (found.length >= MAX_FIND_RESULTS) break;
    }
    if (found.length === 0) return 'No files found.';
    return found.length >= MAX_FIND_RESULTS
      ? `${found.join('\n')}\n[stopped at ${MAX_FIND_RESULTS} files; narrow the glob]`
      : found.join('\n');
  },
};
