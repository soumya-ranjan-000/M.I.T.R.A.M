import { describe, expect, it } from 'vitest';
import { ChangeLog } from '../src/webview/changeLog';

const change = (abs: string, before: string | null, after: string) => ({ path: abs.replace('/w/', ''), abs, before, after });

describe('ChangeLog', () => {
  it('returns what a call changed', () => {
    const log = new ChangeLog();
    log.record('t1', change('/w/a.ts', 'old', 'new'));
    expect(log.get('t1')).toEqual([{ path: 'a.ts', abs: '/w/a.ts', before: 'old', after: 'new' }]);
    expect(log.get('missing')).toEqual([]);
  });

  it('keeps null for a created file', () => {
    const log = new ChangeLog();
    log.record('t1', change('/w/a.ts', null, 'x'));
    expect(log.get('t1')[0].before).toBeNull();
  });

  it('spans the first before to the last after when a call writes a file twice', () => {
    const log = new ChangeLog();
    log.record('t1', change('/w/a.ts', 'v0', 'v1'));
    log.record('t1', change('/w/a.ts', 'v1', 'v2'));
    expect(log.get('t1')).toHaveLength(1);
    expect(log.get('t1')[0]).toMatchObject({ before: 'v0', after: 'v2' });
  });

  it('refuses a file too large to keep', () => {
    const log = new ChangeLog();
    expect(log.record('t1', change('/w/big.txt', null, 'x'.repeat(2_000_001)))).toBe(false);
    expect(log.get('t1')).toEqual([]);
  });

  it('forgets the oldest calls first', () => {
    const log = new ChangeLog();
    for (let i = 0; i < 250; i++) log.record(`t${i}`, change('/w/a.ts', 'a', 'b'));
    expect(log.size).toBe(200);
    expect(log.get('t0')).toEqual([]);
    expect(log.get('t249')).toHaveLength(1);
  });

  it('bounds total memory', () => {
    const log = new ChangeLog();
    const big = 'x'.repeat(1_900_000);
    for (let i = 0; i < 30; i++) log.record(`t${i}`, change('/w/a.ts', big, big));
    // 40M characters in all, and each call holds 3.8M.
    expect(log.size).toBeLessThanOrEqual(10);
    expect(log.get('t29')).toHaveLength(1);
  });
});
