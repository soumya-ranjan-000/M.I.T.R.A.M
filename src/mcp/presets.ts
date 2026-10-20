// The catalogue behind "Add MCP server". Pure data plus small helpers, so tests can use it
// without vscode. Keep it free of vscode/node imports.

import type { McpServerEntry } from './McpConfigStore';

/** A value the user must supply before a preset can be used. */
export interface PresetField {
  /** Where the answer goes: an argument placeholder, or an env/header value. */
  id: string;
  label: string;
  placeholder?: string;
  /** Shown under the prompt, e.g. where to create the token. */
  hint?: string;
  /** A folder: the wizard suggests the workspace and writes it in this platform's form. */
  kind?: 'directory';
}

export interface McpPreset {
  /** Suggested server id; the store makes it unique if taken. */
  id: string;
  label: string;
  description: string;
  /** The settings entry, with `{field}` placeholders filled in from the answers. */
  entry: McpServerEntry;
  /** Plain values the user is asked for, e.g. a directory or a site URL. */
  fields?: PresetField[];
  /** Set when the server needs an API key, which is stored as a secret. Not used for OAuth, which signs in through the browser. */
  secret?: {
    label: string;
    hint: string;
  };
}

/**
 * Servers offered in the picker. Each is a published MCP server; the commands are the ones from
 * their own documentation. Nothing here contains a credential.
 */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'playwright',
    label: 'Playwright',
    description: 'Drive a real browser: navigate, click, type, read pages and take screenshots.',
    entry: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Issues, pull requests, code search and file contents on GitHub.',
    entry: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      auth: { kind: 'env', name: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
    },
    secret: {
      label: 'GitHub personal access token',
      hint: 'Create one at github.com/settings/tokens. Stored in VS Code secret storage, never in settings.json.',
    },
  },
  {
    id: 'filesystem',
    label: 'Filesystem',
    description: 'Read and write files in one directory you choose, through the server.',
    entry: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{directory}'] },
    fields: [
      {
        id: 'directory',
        label: 'Directory the server may access',
        placeholder: '/home/you/projects',
        hint: 'The server can read and write anything under this path.',
        kind: 'directory',
      },
    ],
  },
  {
    id: 'atlassian',
    label: 'Atlassian (Jira and Confluence)',
    description: 'Search and update Jira issues and Confluence pages. You sign in with your Atlassian account in the browser.',
    // Atlassian's hosted server uses OAuth 2.1 with dynamic client registration: nothing to paste.
    entry: { url: 'https://mcp.atlassian.com/v1/mcp', transport: 'http', auth: { kind: 'oauth' } },
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    description: 'Inspect schemas and run read-only queries against a database.',
    entry: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '{connection}'] },
    fields: [
      {
        id: 'connection',
        label: 'Connection string',
        placeholder: 'postgresql://user@localhost:5432/mydb',
        hint: 'Prefer a read-only user. It is stored in settings.json, so leave the password out if you can.',
      },
    ],
  },
  {
    id: 'sentry',
    label: 'Sentry',
    description: 'Look up issues and stack traces from your Sentry projects.',
    entry: {
      url: 'https://mcp.sentry.dev/mcp',
      auth: { kind: 'header', name: 'Authorization', format: 'Bearer {key}' },
    },
    secret: {
      label: 'Sentry auth token',
      hint: 'Create one under Settings → Auth Tokens in Sentry. Stored in VS Code secret storage.',
    },
  },
];

/** The preset with this id, if any. */
export function findPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id);
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** Replaces `{field}` placeholders in a string with the user's answers. */
function fill(value: string, answers: Record<string, string>): string {
  // `{key}` belongs to auth.format and is filled in at connect time from the secret store.
  return value.replace(PLACEHOLDER, (match, name: string) => (name === 'key' ? match : (answers[name] ?? match)));
}

/** The settings entry for a preset, with the user's answers filled in. */
export function buildEntry(preset: McpPreset, answers: Record<string, string>): McpServerEntry {
  const entry = preset.entry;
  const out: McpServerEntry = {};
  if (entry.command) out.command = entry.command;
  if (entry.args) out.args = entry.args.map((a) => fill(a, answers));
  if (entry.url) out.url = fill(entry.url, answers);
  if (entry.transport) out.transport = entry.transport;
  if (entry.env) {
    out.env = Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, fill(v, answers)]));
  }
  if (entry.headers) {
    out.headers = Object.fromEntries(Object.entries(entry.headers).map(([k, v]) => [k, fill(v, answers)]));
  }
  if (entry.auth) out.auth = { ...entry.auth };
  return out;
}
