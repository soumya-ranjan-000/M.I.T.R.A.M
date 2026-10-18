/**
 * Local diagnostics only: nothing here leaves the machine. Logs never contain prompts,
 * file contents or command output, and anything that looks like a credential is redacted.
 */

export interface LogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***'],
  [/((?:x-)?api[-_ ]?key|authorization)(["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2***'],
  [/\b[0-9a-f]{32,}\b/gi, '***'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}/g, '***'],
];

export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join('***');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export class Logger {
  private readonly secrets = new Set<string>();

  constructor(private readonly sink: LogSink) {}

  /** Register an exact value (such as the API key) that must never be logged. */
  addSecret(secret: string | undefined): void {
    if (secret) this.secrets.add(secret);
  }

  info(message: string): void {
    this.sink.info(redact(message, this.secrets));
  }
  warn(message: string): void {
    this.sink.warn(redact(message, this.secrets));
  }
  error(message: string): void {
    this.sink.error(redact(message, this.secrets));
  }
}

export interface DiagnosticsInfo {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  model: string;
  endpoint: string;
  workspaceOpen: boolean;
  settings: Record<string, string | number | boolean>;
}

/** Text to paste into a bug report. Contains no key, and only the host part of the endpoint. */
export function buildDiagnostics(info: DiagnosticsInfo): string {
  let endpointHost = '(not set)';
  if (info.endpoint) {
    try {
      endpointHost = new URL(info.endpoint).host;
    } catch {
      endpointHost = '(invalid URL)';
    }
  }
  const settings = Object.entries(info.settings).map(([k, v]) => `  ${k}: ${v}`);
  return [
    'M.I.T.R.A.M diagnostics',
    `Extension: ${info.extensionVersion}`,
    `VS Code: ${info.vscodeVersion}`,
    `Platform: ${info.platform}`,
    `Model: ${info.model}`,
    `Endpoint host: ${endpointHost}`,
    `Folder open: ${info.workspaceOpen ? 'yes' : 'no'}`,
    'Settings:',
    ...settings,
  ].join('\n');
}
