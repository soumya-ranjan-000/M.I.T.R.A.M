import * as fs from 'node:fs/promises';
import { resolveInWorkspace } from '../safety/workspaceGuard';
import { Tool, ToolInputError, optString } from './Tool';

const MAX_ENTRIES = 300;

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List the files and subdirectories of a workspace directory. Directories end with "/".',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative directory. Defaults to the workspace root.' },
    },
  },
  requiresApproval: false,
  preview: (input) => ({ summary: `List ${(input as { path?: string })?.path || '.'}` }),
  async run(input, ctx) {
    const rel = optString(input, 'path') || '.';
    const abs = await resolveInWorkspace(ctx.root, rel);
    if (!abs) throw new ToolInputError(`Path "${rel}" is outside the workspace.`);

    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      throw new ToolInputError(`Directory not found: ${rel}`);
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    const shown = names.slice(0, MAX_ENTRIES).join('\n');
    if (names.length === 0) return '(empty directory)';
    return names.length > MAX_ENTRIES ? `${shown}\n[showing ${MAX_ENTRIES} of ${names.length} entries]` : shown;
  },
};
