import { describe, expect, it } from 'vitest';
import { CommandRuleStore } from '../src/storage/commandRules';

function fakeState(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    get: <T>(key: string, fallback?: T) => (key in data ? data[key] : fallback) as T,
    update: async (key: string, value: unknown) => {
      data[key] = value;
    },
  };
}

const npmTest = { command: 'npm test', anyArgs: true };
const exactScript = { command: 'npm test | tail -5', anyArgs: false };

describe('CommandRuleStore', () => {
  it('starts empty, adds rules once each, and removes them', async () => {
    const store = new CommandRuleStore(fakeState());
    expect(store.list()).toEqual([]);
    await store.add(npmTest);
    await store.add(exactScript);
    await store.add({ ...npmTest });
    expect(store.list()).toEqual([npmTest, exactScript]);
    await store.remove(npmTest);
    expect(store.list()).toEqual([exactScript]);
  });

  it('keeps an exact rule and a prefix rule for the same words apart', async () => {
    const store = new CommandRuleStore(fakeState());
    await store.add({ command: 'npm test', anyArgs: false });
    await store.add(npmTest);
    expect(store.list()).toHaveLength(2);
  });

  it('ignores corrupt saved state instead of failing', () => {
    const load = (saved: unknown) => new CommandRuleStore(fakeState({ 'mitram.allowedCommands': saved })).list();
    expect(load('npm test')).toEqual([]);
    expect(load(['npm test *', null, 5, { command: '  ', anyArgs: false }, { command: 'ls' }, npmTest])).toEqual([npmTest]);
  });
});
