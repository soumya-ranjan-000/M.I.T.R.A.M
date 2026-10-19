import { describe, expect, it } from 'vitest';
import { MAX_TOOL_NAME, decodeToolName, describeToolName, encodeToolName, isMcpToolName } from '../../src/mcp/naming';

/** What the model API accepts for a tool name. */
const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

describe('encodeToolName', () => {
  it('builds mcp__<server>__<tool>', () => {
    expect(encodeToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
  });

  it('replaces characters the API would reject', () => {
    expect(encodeToolName('my server', 'do.it!')).toBe('mcp__my_server__do_it_');
    expect(encodeToolName('a/b', 'c:d')).toBe('mcp__a_b__c_d');
  });

  // Degenerate input still has to produce a name the API accepts: empty parts become "_".
  // parseServers rejects empty server ids, so this only guards against a malformed tool name.
  it('never produces an empty part', () => {
    expect(encodeToolName('', '')).toBe('mcp______');
    expect(VALID.test(encodeToolName('', ''))).toBe(true);
    expect(VALID.test(encodeToolName('srv', ''))).toBe(true);
  });

  it('stays within the API limit however long the names are', () => {
    const cases = [
      ['s', 't'],
      ['github', 'create_issue'],
      ['a'.repeat(100), 'b'.repeat(100)],
      ['a'.repeat(60), 'short'],
      ['srv', 'c'.repeat(200)],
    ];
    for (const [server, tool] of cases) {
      const name = encodeToolName(server, tool);
      expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
      expect(VALID.test(name)).toBe(true);
    }
  });

  // Truncation must not merge two different tools into one name.
  it('keeps long tool names distinct', () => {
    const a = encodeToolName('srv', `${'x'.repeat(80)}_alpha`);
    const b = encodeToolName('srv', `${'x'.repeat(80)}_beta`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
  });

  it('keeps long server ids distinct', () => {
    const a = encodeToolName(`${'y'.repeat(70)}_one`, 'run');
    const b = encodeToolName(`${'y'.repeat(70)}_two`, 'run');
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
  });

  // A very long server id must not squeeze the tool name down to nothing.
  it('always leaves room for the tool name', () => {
    const name = encodeToolName('z'.repeat(200), 'create_issue');
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
    expect(name.endsWith('create_issue')).toBe(true);
  });

  it('is deterministic', () => {
    expect(encodeToolName('srv', 'q'.repeat(90))).toBe(encodeToolName('srv', 'q'.repeat(90)));
  });
});

describe('isMcpToolName', () => {
  it('recognises encoded names', () => {
    expect(isMcpToolName('mcp__github__create_issue')).toBe(true);
  });

  // Built-in tools must never be mistaken for MCP ones: that is what gates approval.
  it('rejects built-in and lookalike names', () => {
    for (const name of ['read_file', 'edit_file', 'run_command', 'delegate_task', 'mcp__github', 'mcpx__a__b', 'mcp_github__x']) {
      expect(isMcpToolName(name)).toBe(false);
    }
  });
});

describe('decodeToolName', () => {
  it('splits a plain name', () => {
    expect(decodeToolName('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' });
  });

  it('returns null for a name that is not ours', () => {
    expect(decodeToolName('read_file')).toBeNull();
    expect(decodeToolName('mcp__nothing')).toBeNull();
  });

  it('keeps underscores inside the tool name', () => {
    expect(decodeToolName('mcp__srv__a__b')).toEqual({ server: 'srv', tool: 'a__b' });
  });

  // A server id may itself contain "__", so the configured ids disambiguate.
  it('prefers a known server id over the first separator', () => {
    expect(decodeToolName('mcp__my__srv__do_it', ['my__srv'])).toEqual({ server: 'my__srv', tool: 'do_it' });
    expect(decodeToolName('mcp__my__srv__do_it')).toEqual({ server: 'my', tool: 'srv__do_it' });
  });

  it('picks the longest matching server id', () => {
    expect(decodeToolName('mcp__a__b__run', ['a', 'a__b'])).toEqual({ server: 'a__b', tool: 'run' });
  });

  it('maps back to the id as configured, before sanitising', () => {
    const encoded = encodeToolName('my server', 'run');
    expect(decodeToolName(encoded, ['my server'])).toEqual({ server: 'my server', tool: 'run' });
  });

  it('round-trips names that fit', () => {
    for (const [server, tool] of [
      ['github', 'create_issue'],
      ['playwright', 'browser_navigate'],
      ['atlassian', 'jira_search'],
    ]) {
      expect(decodeToolName(encodeToolName(server, tool), [server])).toEqual({ server, tool });
    }
  });
});

describe('describeToolName', () => {
  it('reads as "server: tool"', () => {
    expect(describeToolName('mcp__github__create_issue')).toBe('github: create_issue');
  });

  it('leaves a non-MCP name alone', () => {
    expect(describeToolName('read_file')).toBe('read_file');
  });
});
