/**
 * The gates run Playwright with retries and a JSON report, and name the tests that passed only on a retry. Here a real
 * Playwright run, on throwaway specs that need no app, makes the report.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { flakyTests } from './flaky.ts';

const desktop = join(import.meta.dirname, '..', '..', 'apps', 'desktop');
const playwright = join(desktop, 'node_modules', '.bin', 'playwright');
const playwrightTest = join(desktop, 'node_modules', '@playwright', 'test', 'index.mjs');

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Runs `spec` with two retries, as the gates do, and returns the exit status and the JSON report. */
function runWithRetries(spec: string): { status: number | null; report: unknown } {
  dir = mkdtempSync(join(tmpdir(), 'ab-flaky-'));
  writeFileSync(join(dir, 'board.spec.mjs'), `import { test, expect } from ${JSON.stringify(playwrightTest)};\n${spec}`);
  const report = join(dir, 'report.json');
  const { status } = spawnSync(playwright, ['test', '--retries', '2', '--reporter', 'list,json', '--workers', '1'], {
    cwd: dir,
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
    encoding: 'utf8',
  });
  return { status, report: JSON.parse(readFileSync(report, 'utf8')) };
}

it('a test that fails once then passes passes the run, and is named as flaky', () => {
  const { status, report } = runWithRetries(`
test('steady', () => {});
test.describe('the board', () => {
  test('fails once', ({}, info) => { expect(info.retry).toBeGreaterThan(0); });
});
`);
  expect(status).toBe(0);
  expect(flakyTests(report)).toEqual(['board.spec.mjs:5 › the board › fails once']);
});

it('a test that fails every retry still fails the run, and is not flaky', () => {
  const { status, report } = runWithRetries(`test('always fails', () => { expect(1).toBe(2); });\n`);
  expect(status).not.toBe(0);
  expect(flakyTests(report)).toEqual([]);
});

it('names the project the flaky test ran in', () => {
  const report = {
    suites: [
      {
        title: 'visual.spec.ts',
        file: 'visual.spec.ts',
        specs: [{ title: 'board', file: 'visual.spec.ts', line: 7, tests: [{ projectName: 'visual', status: 'flaky' }, { projectName: 'app', status: 'expected' }] }],
      },
    ],
  };
  expect(flakyTests(report)).toEqual(['[visual] visual.spec.ts:7 › board']);
});

it('reads no flaky tests from a run that wrote no report', () => {
  expect(flakyTests(undefined)).toEqual([]);
  expect(flakyTests({ errors: ['config failed'] })).toEqual([]);
});
