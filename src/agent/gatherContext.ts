import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { resolveInWorkspace } from '../safety/workspaceGuard';
import { ContextPart, truncate } from './ContextBuilder';

const MAX_FILE_CHARS = 60_000;

export async function gatherContext(options: {
  includeActive: boolean;
  editor: vscode.TextEditor | undefined;
  mentions: string[];
}): Promise<ContextPart[]> {
  const parts: ContextPart[] = [];
  const seen = new Set<string>();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const { editor } = options;
  if (options.includeActive && editor) {
    const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
    if (!editor.selection.isEmpty) {
      parts.push({
        kind: 'selection',
        path: relPath,
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text: editor.document.getText(editor.selection),
      });
    } else {
      const { text, truncated } = truncate(editor.document.getText(), MAX_FILE_CHARS);
      parts.push({ kind: 'file', path: relPath, text, truncated });
    }
    seen.add(relPath);
  }

  if (root) {
    for (const mention of options.mentions) {
      if (seen.has(mention)) continue;
      const abs = await resolveInWorkspace(root, mention);
      if (!abs) continue;
      try {
        const { text, truncated } = truncate(await fs.readFile(abs, 'utf8'), MAX_FILE_CHARS);
        parts.push({ kind: 'file', path: mention, text, truncated });
        seen.add(mention);
      } catch {
        // Unreadable or missing file: skip silently, the model just won't see it.
      }
    }
  }
  return parts;
}
