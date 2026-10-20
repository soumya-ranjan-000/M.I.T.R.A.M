// Path handling for MCP server arguments that must work the same on Linux, macOS and Windows.
// Pure (no vscode or node imports) so tests can run it for every platform from any machine.

export interface PathEnv {
  platform: string;
  /** The user's home directory, for a leading `~`. */
  home?: string;
  /** Environment variables, for `%NAME%` (Windows) and `$NAME` (elsewhere). */
  env?: Record<string, string | undefined>;
  /** Base for a relative path, normally the workspace root. */
  base?: string;
}

const isWindows = (env: PathEnv) => env.platform === 'win32';
const DRIVE = /^[a-zA-Z]:([\\/]|$)/;
const UNC = /^[\\/]{2}[^\\/]/;

/** Removes one pair of matching quotes, which people keep when they paste "Copy as path". */
function unquote(text: string): string {
  const t = text.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1).trim() : t;
}

function expandVariables(text: string, env: PathEnv): string {
  const vars = env.env ?? {};
  const lookup = (name: string) => {
    if (vars[name] !== undefined) return vars[name];
    // Windows variable names are case-insensitive.
    if (isWindows(env)) {
      const key = Object.keys(vars).find((k) => k.toLowerCase() === name.toLowerCase());
      if (key) return vars[key];
    }
    return undefined;
  };
  let out = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => (isWindows(env) ? (lookup(name) ?? m) : m));
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => lookup(name) ?? m);
  return out;
}

function expandHome(text: string, env: PathEnv): string {
  if (!env.home) return text;
  if (text === '~') return env.home;
  if (text.startsWith('~/') || text.startsWith('~\\')) return env.home.replace(/[\\/]+$/, '') + text.slice(1);
  return text;
}

/** Splits on the platform's separators and folds `.`, `..` and repeats. A backslash is a filename character on POSIX. */
function fold(rest: string, win: boolean): string[] {
  const out: string[] = [];
  for (const part of rest.split(win ? /[\\/]+/ : /\/+/)) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

/**
 * Turns what a person typed or pasted into one absolute directory path in the form this platform's
 * programs expect, or null if it is empty or cannot be made absolute.
 *
 * On Windows that means: quotes removed, `%USERPROFILE%` and `~` expanded, `/` turned into `\`, a
 * capital drive letter (a server that compares `c:\x` with `C:\x` as strings would otherwise
 * refuse the folder), and no trailing backslash, which breaks argument quoting when the command
 * is launched through `npx.cmd`. A drive root keeps its separator, since `C:` alone means "the
 * current directory on C".
 */
export function normalizeDirectory(input: string, env: PathEnv): string | null {
  let text = unquote(input);
  if (!text) return null;
  text = expandHome(expandVariables(text, env), env);
  const win = isWindows(env);

  if (win) {
    // Git Bash and MSYS write C:\x as /c/x; WSL as /mnt/c/x.
    const posixDrive = /^\/(?:mnt\/)?([a-zA-Z])(?:\/|$)/.exec(text);
    if (posixDrive) text = `${posixDrive[1]}:/${text.slice(posixDrive[0].length)}`;

    if (DRIVE.test(text)) {
      const drive = text[0].toUpperCase();
      const parts = fold(text.slice(2), true);
      return parts.length ? `${drive}:\\${parts.join('\\')}` : `${drive}:\\`;
    }
    if (UNC.test(text)) {
      const [server, share, ...rest] = fold(text, true);
      if (!server || !share) return null;
      return `\\\\${[server, share, ...rest].join('\\')}`;
    }
    if (!env.base) return null;
    const base = normalizeDirectory(env.base, { ...env, base: undefined });
    if (!base) return null;
    return normalizeDirectory(`${base}\\${text}`, { ...env, base: undefined });
  }

  if (!text.startsWith('/')) {
    if (!env.base) return null;
    text = `${env.base.replace(/\/+$/, '')}/${text}`;
  }
  const parts = fold(text, false);
  return `/${parts.join('/')}`;
}

/**
 * Fixes one argument of a saved server command for this platform. Only arguments that are clearly
 * paths are touched, so flags and package names pass through unchanged.
 */
export function normalizePathArg(arg: string, env: PathEnv): string {
  const looksLikePath = arg.startsWith('~') || (isWindows(env) && DRIVE.test(unquote(arg)));
  if (!looksLikePath) return arg;
  return normalizeDirectory(arg, env) ?? arg;
}

/** Applies {@link normalizePathArg} to every argument. */
export function normalizeServerArgs(args: string[], env: PathEnv): string[] {
  return args.map((arg) => normalizePathArg(arg, env));
}
