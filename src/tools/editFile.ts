import { resolveInWorkspace } from '../safety/workspaceGuard';
import { ProposedChange, Tool, ToolContext, ToolInputError, optBool, reqString } from './Tool';

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) count++;
  return count;
}

function clip(text: string, maxLines = 30): string {
  const lines = text.split('\n');
  return lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines)` : text;
}

async function safePath(ctx: ToolContext, rel: string): Promise<string> {
  const abs = await resolveInWorkspace(ctx.root, rel);
  if (!abs) throw new ToolInputError(`Path "${rel}" is outside the workspace.`);
  return abs;
}

async function computeEdit(input: unknown, ctx: ToolContext): Promise<ProposedChange & { count: number }> {
  const rel = reqString(input, 'path');
  let oldString = reqString(input, 'old_string');
  let newString = reqString(input, 'new_string');
  const replaceAll = optBool(input, 'replace_all') ?? false;

  if (oldString === '') throw new ToolInputError('old_string must not be empty. Use create_file for new files.');
  if (oldString === newString) throw new ToolInputError('old_string and new_string are identical.');

  const abs = await safePath(ctx, rel);
  if (!(await ctx.files.exists(abs))) throw new ToolInputError(`File not found: ${rel}. Use create_file to make a new file.`);

  const text = await ctx.files.readText(abs);
  // The model writes LF; match files that use CRLF line endings.
  if (text.includes('\r\n') && !oldString.includes('\r\n')) {
    oldString = oldString.replace(/\n/g, '\r\n');
    newString = newString.replace(/\n/g, '\r\n');
  }

  const count = countOccurrences(text, oldString);
  if (count === 0) {
    throw new ToolInputError(
      'old_string was not found. Check whitespace and indentation, and read the file again to see its current content.',
    );
  }
  if (count > 1 && !replaceAll) {
    throw new ToolInputError(
      `old_string was found ${count} times. Add more surrounding context to make it unique, or set replace_all to true.`,
    );
  }
  return { path: rel, abs, before: text, after: text.split(oldString).join(newString), count };
}

async function computeCreate(input: unknown, ctx: ToolContext): Promise<ProposedChange> {
  const rel = reqString(input, 'path');
  const content = reqString(input, 'content');
  const abs = await safePath(ctx, rel);
  if (await ctx.files.exists(abs)) throw new ToolInputError(`${rel} already exists. Use edit_file to change it.`);
  return { path: rel, abs, before: null, after: content };
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact piece of text. old_string must match the file exactly ' +
    '(including whitespace and indentation) and must be unique in the file unless replace_all is true. ' +
    'Include enough surrounding context to make it unique. Read the file first. Prefer small, targeted edits.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      old_string: { type: 'string', description: 'Exact text to replace. Must not be empty.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  requiresApproval: true,
  preview(input) {
    const i = input as { path?: string; old_string?: string; new_string?: string };
    const minus = (i.old_string ?? '').split('\n').map((l) => `- ${l}`).join('\n');
    const plus = (i.new_string ?? '').split('\n').map((l) => `+ ${l}`).join('\n');
    return { summary: `Edit ${i.path ?? ''}`, detail: clip(`${minus}\n${plus}`, 40) };
  },
  propose: computeEdit,
  async run(input, ctx) {
    const change = await computeEdit(input, ctx);
    await ctx.files.writeText(change.abs, change.after);
    return `Edited ${change.path} (${change.count} replacement${change.count === 1 ? '' : 's'}).`;
  },
};

export const createFileTool: Tool = {
  name: 'create_file',
  description:
    'Create a new file with the given content. Parent directories are created as needed. ' +
    'Fails if the file already exists; use edit_file to change an existing file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['path', 'content'],
  },
  requiresApproval: true,
  preview(input) {
    const i = input as { path?: string; content?: string };
    return { summary: `Create ${i.path ?? ''}`, detail: clip(i.content ?? '', 40) };
  },
  propose: computeCreate,
  async run(input, ctx) {
    const change = await computeCreate(input, ctx);
    await ctx.files.writeText(change.abs, change.after);
    return `Created ${change.path} (${change.after.split('\n').length} lines).`;
  },
};
