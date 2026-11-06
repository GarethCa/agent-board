import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import { test } from './launch.ts';

test('the run shares a compile cache, which what a spec starts inherits', () => {
  const dir = process.env.NODE_COMPILE_CACHE;
  expect(dir).toBeTruthy();
  const used = execFileSync('node', ['-e', "console.log(require('node:module').getCompileCacheDir())"], { encoding: 'utf8' }).trim();
  expect(used.startsWith(dir!)).toBe(true);
});
