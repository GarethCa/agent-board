import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, tempRepo } from './helpers.ts';

describe('tempRepo', () => {
  it('gives each call a repo of its own, with one commit and a clean tree', () => {
    const first = tempRepo();
    const second = tempRepo('other');
    expect(first.endsWith('/monorepo')).toBe(true);
    expect(second.endsWith('/other')).toBe(true);
    expect(existsSync(join(first, 'apps', 'web', 'index.ts'))).toBe(true);
    expect(git(first, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(first, 'status', '--porcelain')).toBe('');

    writeFileSync(join(first, 'new.txt'), 'x\n');
    git(first, 'add', '.');
    git(first, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'second');
    expect(git(first, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(git(second, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(tempRepo(), 'rev-list', '--count', 'HEAD')).toBe('1');
  });
});
