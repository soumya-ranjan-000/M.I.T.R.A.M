import { describe, expect, it } from 'vitest';
import { parseServers } from '../../src/mcp/config';
import { MCP_PRESETS, buildEntry, findPreset } from '../../src/mcp/presets';

describe('the preset catalogue', () => {
  it('offers the servers the user asked for', () => {
    const ids = MCP_PRESETS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['playwright', 'github', 'filesystem', 'atlassian', 'postgres']));
  });

  it('has unique ids and a label and description each', () => {
    expect(new Set(MCP_PRESETS.map((p) => p.id)).size).toBe(MCP_PRESETS.length);
    for (const p of MCP_PRESETS) {
      expect(p.label.trim()).not.toBe('');
      expect(p.description.trim()).not.toBe('');
    }
  });

  it('finds a preset by id', () => {
    expect(findPreset('playwright')?.label).toBe('Playwright');
    expect(findPreset('nope')).toBeUndefined();
  });

  // A preset must never ship a credential, and must not invite one into settings.json.
  it('contains no secrets', () => {
    const text = JSON.stringify(MCP_PRESETS.map((p) => p.entry));
    expect(text).not.toMatch(/sk-|ghp_|Bearer [A-Za-z0-9]/);
  });

  it('declares a secret prompt exactly when the entry needs a key', () => {
    for (const p of MCP_PRESETS) {
      // OAuth signs in through the browser, so it has no key to ask for.
      expect(!!p.secret).toBe(!!p.entry.auth && p.entry.auth.kind !== 'oauth');
    }
  });

  it('asks for every placeholder it uses, and uses every field it asks for', () => {
    for (const p of MCP_PRESETS) {
      const text = JSON.stringify(p.entry);
      const used = new Set([...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).filter((n) => n !== 'key'));
      const asked = new Set((p.fields ?? []).map((f) => f.id));
      expect([...used].sort()).toEqual([...asked].sort());
    }
  });
});

describe('buildEntry', () => {
  it('fills placeholders in args', () => {
    const entry = buildEntry(findPreset('filesystem')!, { directory: '/home/me/code' });
    expect(entry.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/home/me/code']);
  });

  it('fills a placeholder in a url', () => {
    const entry = buildEntry({ ...findPreset('atlassian')!, entry: { url: 'https://{host}/mcp' } }, { host: 'example.com' });
    expect(entry.url).toBe('https://example.com/mcp');
  });

  // {key} is substituted at connect time from secret storage, so it must survive this step.
  it('leaves {key} in auth.format alone', () => {
    const entry = buildEntry(findPreset('sentry')!, {});
    expect(entry.auth).toEqual({ kind: 'header', name: 'Authorization', format: 'Bearer {key}' });
  });

  it('keeps the preset itself unchanged', () => {
    const preset = findPreset('filesystem')!;
    const before = JSON.stringify(preset.entry);
    buildEntry(preset, { directory: '/tmp' });
    expect(JSON.stringify(preset.entry)).toBe(before);
  });

  it('leaves an unanswered placeholder in place rather than emptying it', () => {
    const entry = buildEntry(findPreset('filesystem')!, {});
    expect(entry.args).toContain('{directory}');
  });
});

describe('every preset produces a valid server', () => {
  // Sample answers good enough to validate the shape of each preset.
  const answers: Record<string, string> = {
    directory: '/home/me/code',
    connection: 'postgresql://me@localhost:5432/db',
    url: 'https://mcp.atlassian.com/v1/sse',
  };

  it.each(MCP_PRESETS.map((p) => [p.id, p] as const))('%s passes parseServers', (id, preset) => {
    const { servers, problems } = parseServers({ [id]: buildEntry(preset, answers) }, {});
    expect(problems).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(servers[0].enabled).toBe(true);
  });

  it('signs Atlassian in through the browser: streamable HTTP, OAuth, nothing to paste', () => {
    const preset = findPreset('atlassian')!;
    expect(preset.secret).toBeUndefined();
    expect(preset.fields).toBeUndefined();
    const { servers, problems } = parseServers({ atlassian: buildEntry(preset, answers) }, {});
    expect(problems).toEqual([]);
    expect(servers[0].url).toBe('https://mcp.atlassian.com/v1/mcp');
    expect(servers[0].transport).toBe('http');
    expect(servers[0].auth?.kind).toBe('oauth');
  });

  it('gives GitHub an env-var token on a stdio server', () => {
    const { servers } = parseServers({ github: buildEntry(findPreset('github')!, answers) }, {});
    expect(servers[0].transport).toBe('stdio');
    expect(servers[0].auth).toEqual({ kind: 'env', name: 'GITHUB_PERSONAL_ACCESS_TOKEN', format: '{key}' });
  });
});
