import { describe, expect, it } from 'vitest';
import { normalizeDirectory, normalizeServerArgs } from '../../src/mcp/paths';

const win = { platform: 'win32', home: 'C:\\Users\\Ada', env: { USERPROFILE: 'C:\\Users\\Ada', Projects: 'D:\\work' }, base: 'C:\\Users\\Ada\\proj' };
const nix = { platform: 'linux', home: '/home/ada', env: { WORK: '/srv/work' }, base: '/home/ada/proj' };

describe('normalizeDirectory on Windows', () => {
  it.each([
    ['C:\\Users\\Ada\\proj', 'C:\\Users\\Ada\\proj'],
    ['"C:\\Users\\Ada\\proj"', 'C:\\Users\\Ada\\proj'],
    ["'C:\\Users\\Ada\\proj'", 'C:\\Users\\Ada\\proj'],
    ['  C:\\Users\\Ada\\proj\\  ', 'C:\\Users\\Ada\\proj'],
    ['c:/Users/Ada/proj/', 'C:\\Users\\Ada\\proj'],
    ['C:\\Users\\Ada\\..\\Ada\\.\\proj', 'C:\\Users\\Ada\\proj'],
    ['C:\\Users\\Ada\\My Projects', 'C:\\Users\\Ada\\My Projects'],
    ['%USERPROFILE%\\proj', 'C:\\Users\\Ada\\proj'],
    ['%projects%\\app', 'D:\\work\\app'],
    ['~/proj', 'C:\\Users\\Ada\\proj'],
    ['/c/Users/Ada/proj', 'C:\\Users\\Ada\\proj'],
    ['/mnt/d/work', 'D:\\work'],
    ['C:\\', 'C:\\'],
    ['c:', 'C:\\'],
    ['\\\\server\\share\\dir\\', '\\\\server\\share\\dir'],
    ['src', 'C:\\Users\\Ada\\proj\\src'],
    ['.', 'C:\\Users\\Ada\\proj'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDirectory(input, win)).toBe(expected);
  });

  it('rejects empty input and a relative path with no base', () => {
    expect(normalizeDirectory('   ', win)).toBeNull();
    expect(normalizeDirectory('src', { ...win, base: undefined })).toBeNull();
  });
});

describe('normalizeDirectory elsewhere', () => {
  it.each([
    ['/home/ada/proj', '/home/ada/proj'],
    ['/home/ada/proj/', '/home/ada/proj'],
    ['"/home/ada/my proj"', '/home/ada/my proj'],
    ['~/proj', '/home/ada/proj'],
    ['$WORK/app', '/srv/work/app'],
    ['${WORK}/app', '/srv/work/app'],
    ['src', '/home/ada/proj/src'],
    ['/a/b/../c', '/a/c'],
    ['/', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDirectory(input, nix)).toBe(expected);
  });

  it('keeps a Windows-looking path untouched as a relative one', () => {
    expect(normalizeDirectory('C:\\x', nix)).toBe('/home/ada/proj/C:\\x');
  });
});

describe('normalizeServerArgs', () => {
  it('fixes paths and leaves flags and package names alone on Windows', () => {
    const args = ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\Ada\\proj\\', '"d:/data"', '--port=3000', 'https://x.test/a'];
    expect(normalizeServerArgs(args, win)).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      'C:\\Users\\Ada\\proj',
      'D:\\data',
      '--port=3000',
      'https://x.test/a',
    ]);
  });

  it('expands ~ on every platform', () => {
    expect(normalizeServerArgs(['~/proj'], nix)).toEqual(['/home/ada/proj']);
    expect(normalizeServerArgs(['~/proj'], win)).toEqual(['C:\\Users\\Ada\\proj']);
  });

  it('does not rewrite Linux arguments', () => {
    expect(normalizeServerArgs(['/home/ada/proj/', 'C:\\x\\'], nix)).toEqual(['/home/ada/proj/', 'C:\\x\\']);
  });
});
