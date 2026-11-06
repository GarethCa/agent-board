import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RECORD_VERSION, writeRecord, type GateRecord, type StepRecord } from '../gate-results/results.ts';
import { findRecord, recheckPlan } from './recheck.ts';
import { stepsFor } from './steps.ts';
import type { Plan } from './select.ts';

const SHA = 'f00dfeed'.padEnd(40, '0');
const passed = { outcome: 'pass' };
const record = (steps: Record<string, StepRecord>, tree = 'a'.repeat(40)): GateRecord => ({
  version: RECORD_VERSION,
  sha: SHA,
  tree,
  at: '2026-11-04T20:00:00Z',
  steps: { preflight: passed, lint: passed, typecheck: passed, test: passed, build: passed, e2e: passed, visual: passed, markdownlint: passed, knip: passed, ...steps },
});
const plan = (more: Partial<Plan> = {}): Plan => ({ full: false, unit: [], e2e: [], visual: false, reasons: [], ...more });
/** As select.ts decides for the visual run: a renderer or shared (desktop core) file needs it, a script does not. */
const selectVisual = (files: string[]): boolean =>
  files.some((file) => ['apps/desktop/src/renderer/', 'apps/desktop/src/shared/', 'apps/desktop/e2e/visual'].some((dir) => file.startsWith(dir)));

describe('recheckPlan', () => {
  it('reruns only what the fix touched when the run passed, and reuses the rest', () => {
    const { plan: next, reused } = recheckPlan(record({}), plan({ unit: ['scripts/x.ts'] }), ['scripts/x.ts'], selectVisual);
    expect(next).toMatchObject({ unit: ['scripts/x.ts'], e2e: [], visual: false });
    expect(next.testAll).toBeUndefined();
    // The unit step runs for the change, so its row is a run, not a reuse.
    expect(reused).toEqual(['e2e', 'visual']);
    expect(recheckPlan(record({}), plan(), [], selectVisual).reused).toEqual(['test', 'e2e', 'visual']);
  });

  it('reruns the unit test files that failed, beside the related tests of what changed', () => {
    const { plan: next, reused } = recheckPlan(record({ test: { outcome: 'FAIL', failed: ['packages/core/src/a.test.ts'] } }), plan({ unit: ['scripts/x.ts'] }), ['scripts/x.ts'], selectVisual);
    expect(next.unit).toEqual(['scripts/x.ts', 'packages/core/src/a.test.ts']);
    // Reused lists only the steps that passed whole; the unit row shows the rerun.
    expect(reused).toEqual(['e2e', 'visual']);
  });

  it('gives the failed files to the processes run too, when the change runs the whole unit project', () => {
    const { plan: next } = recheckPlan(record({ test: { outcome: 'FAIL', failed: ['packages/daemon/test/a.test.ts'] } }), plan({ unitAll: true, processes: [] }), [], selectVisual);
    expect(next.processes).toEqual(['packages/daemon/test/a.test.ts']);
  });

  it.each(['TIMEOUT', 'FAIL', 'not run'])('reruns every unit test when the run ended %s with no failed file', (outcome) => {
    const { plan: next, reused } = recheckPlan(record({ test: { outcome } }), plan(), [], selectVisual);
    expect(next.testAll).toBe(true);
    expect(reused).not.toContain('test');
  });

  it('reruns the e2e specs that failed, once each', () => {
    const { plan: next } = recheckPlan(record({ e2e: { outcome: 'FAIL', failed: ['zones.spec.ts', 'tiles.spec.ts'] } }), plan({ e2e: ['zones.spec.ts'] }), [], selectVisual);
    expect(next.e2e).toEqual(['zones.spec.ts', 'tiles.spec.ts']);
    expect(next.e2eAll).toBeUndefined();
  });

  it('reruns the whole e2e step, perf with it, for a failed perf spec or a failure no spec owns', () => {
    for (const e2e of [{ outcome: 'FAIL', failed: ['board-perf.spec.ts'] }, { outcome: 'TIMEOUT' }]) {
      const { plan: next, reused } = recheckPlan(record({ e2e }), plan({ e2e: ['zones.spec.ts'] }), [], selectVisual);
      expect(next).toMatchObject({ e2eAll: true, perf: true, e2e: [] });
      expect(reused).not.toContain('e2e');
    }
  });

  const failedShots = { outcome: 'FAIL', failed: ['visual/chat.spec.ts'], shots: ['dark-chat-visual-darwin.png'] };

  it('reruns just the failed visual files after a fix that only moves their baselines', () => {
    const baseline = 'apps/desktop/e2e/visual.spec.ts-snapshots/dark-chat-visual-darwin.png';
    const { plan: next } = recheckPlan(record({ visual: failedShots }), plan({ visual: true, reasons: ['visual: baselines changed'] }), [baseline], selectVisual);
    expect(next.visual).toBe(false);
    expect(next.visualFiles).toEqual(['visual/chat.spec.ts']);
    expect(next.reasons.some((reason) => reason.startsWith('visual: '))).toBe(false);
  });

  it('adds a changed visual spec to the files it reruns', () => {
    const { plan: next } = recheckPlan(record({ visual: failedShots }), plan({ visual: true }), ['apps/desktop/e2e/visual/board.spec.ts'], selectVisual);
    expect(next.visualFiles).toEqual(['visual/board.spec.ts', 'visual/chat.spec.ts']);
  });

  it('reruns every shot when the fix moves another baseline, or changes what the shots draw', () => {
    for (const file of ['apps/desktop/e2e/visual.spec.ts-snapshots/board-visual-darwin.png', 'apps/desktop/src/renderer/src/styles.css']) {
      const { plan: next, reused } = recheckPlan(record({ visual: failedShots }), plan({ visual: true }), [file], selectVisual);
      expect(next.visual).toBe(true);
      expect(next.visualFiles).toBeUndefined();
      expect(reused).not.toContain('visual');
    }
  });

  it('reruns every shot when the visual run failed with no file to pin it on', () => {
    expect(recheckPlan(record({ visual: { outcome: 'FAIL' } }), plan(), [], selectVisual).plan.visual).toBe(true);
  });

  it('runs the visual step whole, not reused, when the change alone needs it', () => {
    const { plan: next, reused } = recheckPlan(record({}), plan({ visual: true }), ['apps/desktop/src/renderer/src/styles.css'], selectVisual);
    expect(next.visual).toBe(true);
    expect(reused).toEqual(['test', 'e2e']);
  });
});

describe('recheckPlan, for a change that runs everything (desktop core)', () => {
  const widened = (): Plan => plan({ unitAll: true, processes: ['apps/desktop/src/shared/x.ts'], e2eAll: true, visual: true, reasons: ['desktop core changed'] });
  const context = { leakCheck: false, exists: () => true, headless: false };
  const argvOf = (next: Plan, name: string) => stepsFor(next, context).find((step) => step.name === name)?.argv;

  it('runs every app spec, not just the ones that failed, when the change needs them all', () => {
    const { plan: next, reused } = recheckPlan(record({ e2e: { outcome: 'FAIL', failed: ['chat.spec.ts'] } }), widened(), ['apps/desktop/src/shared/x.ts'], selectVisual);
    expect(next).toMatchObject({ e2eAll: true, e2e: [] });
    expect(argvOf(next, 'e2e')!.some((arg) => arg.endsWith('.spec.ts'))).toBe(false);
    expect(next.reasons).toContain('desktop core changed');
    expect(reused).toEqual([]);
  });

  it('keeps the whole unit project and the related processes run for a passed unit step, rather than every test', () => {
    const { plan: next } = recheckPlan(record({}), widened(), ['apps/desktop/src/shared/x.ts'], selectVisual);
    expect(next.testAll).toBeUndefined();
    expect(argvOf(next, 'unit')).toEqual(['pnpm', 'exec', 'vitest', 'run', '--project', 'unit']);
    expect(argvOf(next, 'processes')!.at(-1)).toBe('apps/desktop/src/shared/x.ts');
    expect(next.reasons.some((reason) => reason.includes('ended pass'))).toBe(false);
  });

  it('adds the failed processes-project files to the related run', () => {
    const { plan: next } = recheckPlan(record({ test: { outcome: 'FAIL', failed: ['packages/daemon/test/a.test.ts'] } }), widened(), [], selectVisual);
    expect(argvOf(next, 'processes')!.slice(-2)).toEqual(['apps/desktop/src/shared/x.ts', 'packages/daemon/test/a.test.ts']);
  });

  it.each<[string, StepRecord]>([
    ['test', { outcome: 'TIMEOUT' }],
    ['e2e', { outcome: 'TIMEOUT' }],
    ['visual', { outcome: 'FAIL', failed: ['visual/chat.spec.ts'], shots: ['c-visual-darwin.png'] }],
  ])('never narrows a widened run for a %s step that ended %o', (name, outcome) => {
    const { plan: next, reused } = recheckPlan(record({ [name]: outcome }), widened(), ['apps/desktop/src/shared/x.ts'], selectVisual);
    expect(next.e2eAll).toBe(true);
    expect(next.visual).toBe(true);
    expect(next.visualFiles).toBeUndefined();
    expect(reused).toEqual([]);
  });

  it('says a recheck of a failed run is one, and of a passed run is not', () => {
    expect(recheckPlan(record({ visual: { outcome: 'FAIL' } }), plan(), [], selectVisual).failedRun).toBe(true);
    expect(recheckPlan(record({}), plan(), [], selectVisual).failedRun).toBe(false);
  });
});

describe('findRecord', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds the nearest record on HEAD's line, HEAD's own tree first", () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-recheck-'));
    const repo = join(dir, 'repo');
    const results = join(dir, 'results');
    const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const commit = (text: string): string => {
      writeFileSync(join(repo, 'a.txt'), text);
      git('add', '-A');
      git('commit', '-q', '-m', text);
      return git('rev-parse', 'HEAD^{tree}');
    };
    const first = commit('one');
    commit('two');
    expect(findRecord(repo, results)).toBeUndefined();
    writeRecord(results, record({}, first), new Date('2026-11-04T20:00:00Z'));
    expect(findRecord(repo, results)).toMatchObject({ behind: 1, record: { tree: first } });
    const third = commit('three');
    writeRecord(results, record({}, third), new Date('2026-11-04T20:00:00Z'));
    expect(findRecord(repo, results)).toMatchObject({ behind: 0, record: { tree: third } });
  });
});
