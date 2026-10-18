import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { createDiagnosticsReader } from '../tools/vscodeHost';
import { EnvironmentInfo } from './environment';

const run = promisify(execFile);

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd: root, timeout: 3000, maxBuffer: 256 * 1024 });
    return stdout.trim() || undefined;
  } catch {
    return undefined; // not a repo, git missing, or too slow: just leave it out
  }
}

export async function gatherEnvironment(root: string): Promise<EnvironmentInfo> {
  const openTabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) => (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file' ? [tab.input.uri] : []))
    .map((uri) => vscode.workspace.asRelativePath(uri, false));

  const [branch, diffStat, diagnostics] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['diff', '--stat']),
    createDiagnosticsReader(root)().catch(() => undefined),
  ]);

  return {
    openTabs: [...new Set(openTabs)],
    branch,
    diffStat,
    diagnostics: diagnostics === 'No errors or warnings.' ? undefined : diagnostics,
  };
}
