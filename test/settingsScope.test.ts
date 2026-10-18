import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const properties: Record<string, { scope?: string }> = manifest.contributes.configuration.properties;

describe('security-sensitive settings', () => {
  // A cloned repository's .vscode/settings.json must not be able to redirect the API key or skip approvals.
  it.each(['mitram.endpoint', 'mitram.skipApprovalPrompts', 'mitram.autoApproveEdits', 'mitram.autoApproveSafeCommands', 'mitram.autoApproveCommands'])(
    '%s is read from user settings only',
    (key) => expect(properties[key]?.scope).toBe('application'),
  );
});
