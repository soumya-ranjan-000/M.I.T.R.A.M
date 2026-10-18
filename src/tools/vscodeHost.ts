import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FilePort } from './Tool';

/**
 * File access that cooperates with the editor: reads see unsaved changes,
 * and writes go through WorkspaceEdit so they can be undone from the editor.
 */
export function createVscodeFilePort(): FilePort {
  const exists = async (abs: string): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(abs));
      return true;
    } catch {
      return false;
    }
  };

  return {
    exists,
    async remove(abs) {
      await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: false });
    },
    async readText(abs) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
      if (open) return open.getText();
      return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(abs))).toString('utf8');
    },
    async writeText(abs, content) {
      const uri = vscode.Uri.file(abs);
      if (!(await exists(abs))) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(abs)));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const whole = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, whole, content);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`The editor refused the edit to ${abs}.`);
      await doc.save();
    },
  };
}

const SEVERITY: Record<number, string> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
};
const MAX_DIAGNOSTICS = 100;

export function createDiagnosticsReader(root: string): (relPath?: string) => Promise<string> {
  return async (relPath) => {
    const lines: string[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file') continue;
      const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
      if (rel.startsWith('..')) continue;
      if (relPath && rel !== relPath.replace(/^\.\//, '')) continue;
      for (const d of diagnostics) {
        const severity = SEVERITY[d.severity];
        if (!severity) continue;
        lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severity}: ${d.message}`);
      }
    }
    if (lines.length === 0) return 'No errors or warnings.';
    const shown = lines.slice(0, MAX_DIAGNOSTICS).join('\n');
    return lines.length > MAX_DIAGNOSTICS ? `${shown}\n[showing ${MAX_DIAGNOSTICS} of ${lines.length}]` : shown;
  };
}
