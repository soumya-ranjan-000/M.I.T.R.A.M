import * as fs from 'node:fs/promises';
import { resolveInWorkspace } from '../safety/workspaceGuard';
import { Tool, ToolInputError, optInt, reqString } from './Tool';

const DEFAULT_MAX_LINES = 2000;

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns lines prefixed with their line number and a tab. ' +
    'Use start_line/end_line (1-based, inclusive) to read part of a large file. ' +
    'Do not include the line-number prefix when you later pass text to edit_file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      start_line: { type: 'integer', description: 'First line to read (1-based).' },
      end_line: { type: 'integer', description: 'Last line to read (inclusive).' },
    },
    required: ['path'],
  },
  requiresApproval: false,
  preview: (input) => ({ summary: `Read ${(input as { path?: string })?.path ?? ''}` }),
  async run(input, ctx) {
    const rel = reqString(input, 'path');
    const abs = await resolveInWorkspace(ctx.root, rel);
    if (!abs) throw new ToolInputError(`Path "${rel}" is outside the workspace.`);

    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new ToolInputError(`File not found: ${rel}`);
    if (stat.isDirectory()) throw new ToolInputError(`"${rel}" is a directory. Use list_dir.`);

    const text = await ctx.files.readText(abs);
    if (text.includes('\0')) throw new ToolInputError(`"${rel}" looks like a binary file.`);

    const lines = text.split('\n');
    const start = Math.max(1, optInt(input, 'start_line') ?? 1);
    const requestedEnd = optInt(input, 'end_line');
    const end = Math.min(lines.length, requestedEnd ?? start + DEFAULT_MAX_LINES - 1);
    if (start > lines.length) {
      throw new ToolInputError(`start_line ${start} is past the end of the file (${lines.length} lines).`);
    }
    if (end < start) throw new ToolInputError('end_line must be >= start_line.');

    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}\t${line}`)
      .join('\n');
    const partial = start > 1 || end < lines.length;
    return partial ? `${body}\n[showing lines ${start}-${end} of ${lines.length}]` : body;
  },
};
