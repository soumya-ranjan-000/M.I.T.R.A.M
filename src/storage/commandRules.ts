import type * as vscode from 'vscode';
import type { CommandRule } from '../safety/commandPolicy';

const KEY = 'mitram.allowedCommands';

const isRule = (value: unknown): value is CommandRule =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CommandRule).command === 'string' &&
  (value as CommandRule).command.trim() !== '' &&
  typeof (value as CommandRule).anyArgs === 'boolean';

const same = (a: CommandRule, b: CommandRule) => a.command === b.command && a.anyArgs === b.anyArgs;

/**
 * Command rules the user chose to "always allow" from an approval card, such as "npm test *".
 * Kept in this workspace's extension state rather than .vscode/settings.json, so a cloned
 * repository can never ship rules of its own.
 */
export class CommandRuleStore {
  constructor(private readonly state: Pick<vscode.Memento, 'get' | 'update'>) {}

  list(): CommandRule[] {
    const saved = this.state.get<unknown>(KEY, []);
    return Array.isArray(saved) ? saved.filter(isRule).map(({ command, anyArgs }) => ({ command, anyArgs })) : [];
  }

  async add(rule: CommandRule): Promise<void> {
    const rules = this.list();
    if (!rules.some((r) => same(r, rule))) await this.state.update(KEY, [...rules, rule]);
  }

  async remove(rule: CommandRule): Promise<void> {
    await this.state.update(KEY, this.list().filter((r) => !same(r, rule)));
  }
}
