import { describe, expect, it } from 'vitest';
import { describeError } from '../src/providers/ModelProvider';

describe('describeError', () => {
  it('maps common statuses to actionable messages', () => {
    expect(describeError({ status: 401 })).toMatch(/API key/);
    expect(describeError({ status: 404 })).toMatch(/endpoint/);
    expect(describeError({ status: 429 })).toMatch(/Rate limited/);
    expect(describeError({ status: 503 })).toMatch(/503/);
  });

  it('reports aborts as stopped', () => {
    expect(describeError({ name: 'APIUserAbortError' })).toBe('Stopped.');
  });

  it('falls back to the error message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(null)).toBe('Unknown error.');
  });
});
