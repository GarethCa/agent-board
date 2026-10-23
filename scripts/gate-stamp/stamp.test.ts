import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readStamp, STAMP_KEEP_DAYS, stampDir, writeStamp } from './stamp.ts';

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const SHA = 'a'.repeat(40);

it('reads back when a commit passed the full gate', () => {
  dir = join(mkdtempSync(join(tmpdir(), 'ab-stamp-')), 'stamps');
  writeStamp(dir, SHA, new Date('2026-10-23T17:02:00Z'));
  expect(readStamp(dir, SHA)).toEqual(new Date('2026-10-23T17:02:00Z'));
});

it('has no stamp for a commit that never passed', () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
  writeStamp(dir, SHA, new Date('2026-10-23T17:02:00Z'));
  expect(readStamp(dir, 'b'.repeat(40))).toBeUndefined();
  expect(readStamp(join(dir, 'missing'), SHA)).toBeUndefined();
});

it('a later pass of the same commit replaces the earlier one', () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
  writeStamp(dir, SHA, new Date('2026-10-23T10:00:00Z'));
  writeStamp(dir, SHA, new Date('2026-10-23T17:02:00Z'));
  expect(readStamp(dir, SHA)).toEqual(new Date('2026-10-23T17:02:00Z'));
});

it(`forgets stamps more than ${STAMP_KEEP_DAYS} days old when it writes one, so the directory does not grow for ever`, () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
  const day = 86_400_000;
  const now = new Date('2026-10-23T17:00:00Z');
  const old = 'b'.repeat(40);
  const recent = 'c'.repeat(40);
  writeStamp(dir, old, new Date(now.getTime() - (STAMP_KEEP_DAYS + 1) * day));
  writeStamp(dir, recent, new Date(now.getTime() - (STAMP_KEEP_DAYS - 1) * day));
  writeStamp(dir, SHA, now);
  expect(readStamp(dir, old)).toBeUndefined();
  expect(readStamp(dir, recent)).toBeInstanceOf(Date);
  expect(readStamp(dir, SHA)).toEqual(now);
});

it('refuses anything but a full commit SHA, so a short or symbolic ref never matches', () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
  expect(() => writeStamp(dir!, 'abc1234', new Date())).toThrow(/full commit SHA/);
  expect(() => writeStamp(dir!, '../../etc/x', new Date())).toThrow(/full commit SHA/);
  expect(readStamp(dir, 'HEAD')).toBeUndefined();
});

it('lives beside the e2e lock unless CHECK_STAMP_DIR says otherwise', () => {
  expect(stampDir({ HOME: '/Users/dev' })).toBe('/Users/dev/.cache/agent-board-gate/stamps');
  expect(stampDir({ HOME: '/Users/dev', CHECK_STAMP_DIR: '/tmp/s' })).toBe('/tmp/s');
});
