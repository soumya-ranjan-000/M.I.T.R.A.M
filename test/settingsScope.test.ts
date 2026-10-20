import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const properties: Record<string, { scope?: string }> = manifest.contributes.configuration.properties;

describe('security-sensitive settings', () => {
  // A cloned repository's .vscode/settings.json must not be able to redirect the API key, skip
  // approvals, or make M.I.T.R.A.M start a process of its choosing.
  it.each([
    'mitram.endpoint',
    'mitram.skipApprovalPrompts',
    'mitram.autoApproveEdits',
    'mitram.autoApproveSafeCommands',
    'mitram.autoApproveCommands',
    'mitram.mcpServers',
    'mitram.autoApproveMcpReads',
    // Audio from the microphone must not be redirected by a cloned repository.
    'mitram.voice.endpoint',
  ])('%s is read from user settings only', (key) => expect(properties[key]?.scope).toBe('application'));

  // The key itself belongs in SecretStorage, so the schema must not invite one into settings.json.
  it('mitram.mcpServers has no field for an API key', () => {
    const schema = JSON.stringify(properties['mitram.mcpServers']);
    expect(schema).not.toMatch(/"(apiKey|key|token|secret|password)"\s*:/i);
  });
});
