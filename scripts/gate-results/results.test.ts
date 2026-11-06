import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { playwrightFailures, readRecord, RECORD_VERSION, recordFromLogs, resultsDir, vitestFailures, writeRecord, type GateRecord } from './results.ts';

const ROOT = '/repo';
const TREE = 'a'.repeat(40);
const SHA = 'b'.repeat(40);

describe('vitestFailures', () => {
  it('names the failed test files, repo-relative, once each', () => {
    const report = {
      success: false,
      testResults: [
        { name: '/repo/packages/daemon/test/b.test.ts', status: 'failed' },
        { name: '/repo/apps/desktop/src/a.test.ts', status: 'passed' },
        { name: '/repo/packages/core/src/a.test.ts', status: 'failed' },
      ],
    };
    expect(vitestFailures(report, ROOT)).toEqual(['packages/core/src/a.test.ts', 'packages/daemon/test/b.test.ts']);
  });

  it('pins nothing on a run that failed with every file passing, as an unhandled error does', () => {
    expect(vitestFailures({ success: false, testResults: [{ name: '/repo/a.test.ts', status: 'passed' }] }, ROOT)).toBeUndefined();
    expect(vitestFailures(undefined, ROOT)).toBeUndefined();
  });
});

describe('playwrightFailures', () => {
  const spec = (file: string, status: string, expected?: string) => ({
    file,
    tests: [{ status, results: [{ attachments: expected === undefined ? [] : [{ name: 'shot-expected.png', path: `/repo/apps/desktop/e2e/visual.spec.ts-snapshots/${expected}` }, { name: 'shot-actual.png', path: '/tmp/x/shot-actual.png' }] }] }],
  });

  it("names the failed spec files and the baselines their failed shots used, in nested suites too", () => {
    const report = {
      suites: [
        { specs: [spec('visual/chat.spec.ts', 'unexpected', 'dark-chat-visual-darwin.png'), spec('visual/chat.spec.ts', 'expected')] },
        { suites: [{ specs: [spec('visual/board.spec.ts', 'flaky', 'board-visual-darwin.png'), spec('visual/dock.spec.ts', 'unexpected', 'dock-visual-darwin.png')] }] },
      ],
      errors: [],
    };
    expect(playwrightFailures(report)).toEqual({ failed: ['visual/chat.spec.ts', 'visual/dock.spec.ts'], shots: ['dark-chat-visual-darwin.png', 'dock-visual-darwin.png'] });
  });

  it("pins nothing on a run whose dependent project did not run: the perf benchmark is skipped once an app spec fails", () => {
    const report = {
      suites: [{ specs: [{ file: 'zones.spec.ts', tests: [{ projectName: 'app', status: 'unexpected' }] }, { file: 'board-perf.spec.ts', tests: [{ projectName: 'perf', status: 'skipped' }] }] }],
      errors: [],
    };
    expect(playwrightFailures(report, ['perf'])).toBeUndefined();
    // With the benchmark run, the failed app spec is all there is to rerun.
    report.suites[0]!.specs[1]!.tests[0]!.status = 'expected';
    expect(playwrightFailures(report, ['perf'])).toEqual({ failed: ['zones.spec.ts'], shots: [] });
  });

  it('pins nothing on a run-level error, such as a global setup that threw', () => {
    expect(playwrightFailures({ suites: [], errors: [{ message: 'boom' }] })).toBeUndefined();
    expect(playwrightFailures(undefined)).toBeUndefined();
  });
});

describe('records', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads each step of a run from its log dir, with the files a failed test step names', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-results-'));
    writeFileSync(join(dir, 'lint.result'), 'pass 30\n');
    writeFileSync(join(dir, 'test.result'), 'FAIL 600\n');
    writeFileSync(join(dir, 'test.json'), JSON.stringify({ success: false, testResults: [{ name: '/repo/a.test.ts', status: 'failed' }] }));
    writeFileSync(join(dir, 'test.log'), ' FAIL  a.test.ts > adds\n');
    writeFileSync(join(dir, 'e2e.result'), 'TIMEOUT 1800\n');
    writeFileSync(join(dir, 'visual.result'), 'FAIL 400\n');
    writeFileSync(join(dir, 'visual.json'), JSON.stringify({ suites: [{ specs: [{ file: 'visual/chat.spec.ts', tests: [{ status: 'unexpected', results: [{ attachments: [{ name: 'c-expected.png', path: '/s/c-visual-darwin.png' }] }] }] }] }] }));
    const at = new Date('2026-11-04T20:00:00Z');
    expect(recordFromLogs({ logDir: dir, steps: ['lint', 'test', 'build', 'e2e', 'visual'], sha: SHA, tree: TREE, root: ROOT, at })).toEqual({
      version: RECORD_VERSION,
      sha: SHA,
      tree: TREE,
      at: at.toISOString(),
      steps: {
        lint: { outcome: 'pass' },
        test: { outcome: 'FAIL', failed: ['a.test.ts'] },
        // No result: the gate skipped it.
        build: { outcome: 'not run' },
        e2e: { outcome: 'TIMEOUT' },
        visual: { outcome: 'FAIL', failed: ['visual/chat.spec.ts'], shots: ['c-visual-darwin.png'] },
      },
    });
  });

  it.each([
    'test watchdog: a.test.ts > loops has run for 60 s, past its 60 s limit',
    'Error: Worker exited unexpectedly with signal SIGKILL during started state while running test file /repo/b.test.ts',
    '⎯⎯⎯ Unhandled Errors ⎯⎯⎯',
  ])('reruns the whole unit step when its log shows a failure the report hides: %s', (line) => {
    dir = mkdtempSync(join(tmpdir(), 'ab-results-'));
    writeFileSync(join(dir, 'test.result'), 'FAIL 600\n');
    // Vitest reports a killed fork's file as passed: only the real failure is in the report.
    writeFileSync(join(dir, 'test.json'), JSON.stringify({ success: false, testResults: [{ name: '/repo/a.test.ts', status: 'failed' }, { name: '/repo/b.test.ts', status: 'passed' }] }));
    writeFileSync(join(dir, 'test.log'), `${line}\n`);
    expect(recordFromLogs({ logDir: dir, steps: ['test'], sha: SHA, tree: TREE, root: ROOT, at: new Date() }).steps.test).toEqual({ outcome: 'FAIL' });
  });

  const record = (at: string, tree = TREE): GateRecord => ({ version: RECORD_VERSION, sha: SHA, tree, at, steps: { lint: { outcome: 'pass' } } });

  it('keeps one record per tree, reads it back, and forgets records past a week', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-results-'));
    const old = record('2026-10-20T00:00:00Z', 'c'.repeat(40));
    writeRecord(dir, old, new Date('2026-10-20T00:00:00Z'));
    const now = new Date('2026-11-04T20:00:00Z');
    writeRecord(dir, record(now.toISOString()), now);
    expect(readRecord(dir, TREE)).toEqual(record(now.toISOString()));
    expect(readRecord(dir, 'c'.repeat(40))).toBeUndefined();
    expect(readdirSync(dir)).toEqual([`${TREE}.json`]);
  });

  it('ignores a record of another version, or none', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-results-'));
    writeFileSync(join(dir, `${TREE}.json`), JSON.stringify({ ...record('2026-11-04T20:00:00Z'), version: RECORD_VERSION + 1 }));
    expect(readRecord(dir, TREE)).toBeUndefined();
    expect(readRecord(dir, 'd'.repeat(40))).toBeUndefined();
  });

  it('lives in the stamps dir, which CHECK_STAMP_DIR moves', () => {
    expect(resultsDir({ CHECK_STAMP_DIR: '/x/stamps' })).toBe('/x/stamps/results');
  });
});
