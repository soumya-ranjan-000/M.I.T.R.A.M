export interface EnvironmentInfo {
  openTabs: string[];
  branch?: string;
  diffStat?: string;
  diagnostics?: string;
}

const MAX_TABS = 15;
const MAX_STAT_LINES = 15;
const MAX_DIAG_LINES = 10;

function clipLines(text: string, max: number): string {
  const lines = text.trim().split('\n');
  return lines.length > max ? [...lines.slice(0, max), `… (${lines.length - max} more)`].join('\n') : lines.join('\n');
}

/** Small summary of the editor and repo state, added to each user message. Empty if there is nothing to say. */
export function formatEnvironment(info: EnvironmentInfo): string {
  const sections: string[] = [];
  if (info.openTabs.length) {
    const shown = info.openTabs.slice(0, MAX_TABS).join('\n');
    const more = info.openTabs.length > MAX_TABS ? `\n… (${info.openTabs.length - MAX_TABS} more)` : '';
    sections.push(`Open editor tabs:\n${shown}${more}`);
  }
  if (info.branch) sections.push(`Git branch: ${info.branch}`);
  if (info.diffStat?.trim()) sections.push(`Uncommitted changes (git diff --stat):\n${clipLines(info.diffStat, MAX_STAT_LINES)}`);
  if (info.diagnostics?.trim()) sections.push(`Current errors and warnings:\n${clipLines(info.diagnostics, MAX_DIAG_LINES)}`);
  return sections.length ? `<environment>\n${sections.join('\n\n')}\n</environment>` : '';
}
