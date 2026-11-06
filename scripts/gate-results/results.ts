/**
 * The gate's result records: what one full `check:local` run found, per tree. A failed run is mostly passes, and a fix
 * changes a few files, so `check:pr --recheck` reruns only what failed and what the fix touches, and reuses the rest of
 * the record (recheck.ts). One JSON file per tree hash, beside the green stamps, kept as long as they are.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { STAMP_KEEP_DAYS, stampDir } from '../gate-stamp/stamp.ts';

/** Bumped when the record's shape changes; a reader ignores records of another version. */
export const RECORD_VERSION = 1;

export interface StepRecord {
  /** `pass`, `FAIL`, `TIMEOUT` or `not run`, as check-local.sh's `.result` files say. */
  outcome: string;
  /**
   * For a failed test step, the files whose tests failed: repo-relative for `test`, under apps/desktop/e2e for `e2e`
   * and `visual`. Absent when the failure can't be pinned on files (a crash, a timeout, a run-level error): the whole
   * step reruns then.
   */
  failed?: string[];
  /** For a failed `visual` step, the baselines its failed shots compared against (file names in the snapshot dir). */
  shots?: string[];
}

export interface GateRecord {
  version: number;
  sha: string;
  tree: string;
  /** When the run ended, ISO 8601. */
  at: string;
  steps: Record<string, StepRecord>;
  /**
   * Set on the record of a recheck that passed (check:pr --recheck): the commit whose full run it builds on. Such a
   * record serves later rechecks only; no green stamp comes of it.
   */
  rechecks?: string;
}

const TREE = /^[0-9a-f]{40}$/;
/** Playwright projects in the e2e step that run only once the app project passes. */
const E2E_DEPENDENTS = ['perf'];

/** The records' dir: `results` inside the stamps' dir (`CHECK_STAMP_DIR` moves both). */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stampDir(env), 'results');
}

interface VitestReport {
  success?: boolean;
  testResults?: { name: string; status: string }[];
}

/** The test files a Vitest JSON report failed, repo-relative; undefined when it failed on something no file owns. */
export function vitestFailures(report: unknown, root: string): string[] | undefined {
  const { success, testResults } = (report ?? {}) as VitestReport;
  if (!Array.isArray(testResults)) return undefined;
  const failed = testResults.filter((file) => file.status !== 'passed' && file.status !== 'skipped' && file.status !== 'pending').map((file) => relative(root, file.name));
  // A run can fail with every file passing: an unhandled error, or no tests found.
  if (failed.length === 0) return success === false ? undefined : [];
  return [...new Set(failed)].toSorted();
}

interface PlaywrightSpec {
  file: string;
  tests?: { projectName?: string; status?: string; results?: { attachments?: { name: string; path?: string }[] }[] }[];
}
interface PlaywrightSuite {
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

/**
 * The spec files a Playwright JSON report failed (relative to its testDir, apps/desktop/e2e), with the baselines its
 * failed shots used; undefined when the run itself errored (a global setup, a crash), which no file owns. Also
 * undefined when a test of a `dependents` project did not run: Playwright skips a project whose dependency failed, and
 * rerunning the failed specs alone would never run it.
 */
export function playwrightFailures(report: unknown, dependents: readonly string[] = []): { failed: string[]; shots: string[] } | undefined {
  const { suites, errors } = (report ?? {}) as { suites?: PlaywrightSuite[]; errors?: unknown[] };
  if (!Array.isArray(suites) || (errors?.length ?? 0) > 0) return undefined;
  const failed = new Set<string>();
  const shots = new Set<string>();
  let unrun = false;
  const visit = (suite: PlaywrightSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.projectName !== undefined && dependents.includes(test.projectName) && test.status !== 'expected' && test.status !== 'flaky') unrun = true;
        if (test.status !== 'unexpected') continue;
        failed.add(spec.file);
        for (const result of test.results ?? []) {
          for (const { name, path } of result.attachments ?? []) {
            if (name.endsWith('-expected.png') && path !== undefined) shots.add(basename(path));
          }
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  suites.forEach(visit);
  if (unrun) return undefined;
  return { failed: [...failed].toSorted(), shots: [...shots].toSorted() };
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Whether a unit run's log shows a failure its JSON report hides: Vitest reports the file of a fork the watchdog killed,
 * or one that crashed, as passed, and an unhandled error belongs to no file.
 */
function crashed(log: string): boolean {
  try {
    return /Worker exited unexpectedly|test watchdog: |Unhandled (Error|Rejection)/.test(readFileSync(log, 'utf8'));
  } catch {
    // No log to read: nothing shows the report is whole.
    return true;
  }
}

/**
 * The record of a check-local.sh run from its log dir: each step's `.result`, and for a failed test step the files its
 * report names. A step with no `.result` did not run.
 */
export function recordFromLogs({ logDir, steps, sha, tree, root, at }: { logDir: string; steps: string[]; sha: string; tree: string; root: string; at: Date }): GateRecord {
  const record: GateRecord = { version: RECORD_VERSION, sha, tree, at: at.toISOString(), steps: {} };
  for (const name of steps) {
    let outcome = 'not run';
    try {
      outcome = readFileSync(join(logDir, `${name}.result`), 'utf8').trim().split(' ')[0]!;
    } catch {
      // No result: the gate skipped the step.
    }
    const step: StepRecord = { outcome };
    if (outcome === 'FAIL') {
      if (name === 'test') {
        const failed = vitestFailures(readJson(join(logDir, 'test.json')), root);
        if (failed !== undefined && failed.length > 0 && !crashed(join(logDir, 'test.log'))) step.failed = failed;
      } else if (name === 'e2e' || name === 'visual') {
        // The e2e step's perf project depends on the app project (playwright.config.ts).
        const found = playwrightFailures(readJson(join(logDir, `${name}.json`)), name === 'e2e' ? E2E_DEPENDENTS : []);
        if (found !== undefined && found.failed.length > 0) {
          step.failed = found.failed;
          if (name === 'visual') step.shots = found.shots;
        }
      }
    }
    record.steps[name] = step;
  }
  return record;
}

/** Writes `record` under its tree, replacing an earlier one, and forgets records past the stamps' age. */
export function writeRecord(dir: string, record: GateRecord, now: Date = new Date()): void {
  if (!TREE.test(record.tree)) throw new Error(`"${record.tree}" is not a full tree hash.`);
  mkdirSync(dir, { recursive: true });
  // Written aside and renamed, so a reader never sees half a record.
  const temp = join(dir, `.${record.tree}.${process.pid}`);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, join(dir, `${record.tree}.json`));
  const oldest = now.getTime() - STAMP_KEEP_DAYS * 86_400_000;
  for (const name of readdirSync(dir)) {
    const kept = name.endsWith('.json') ? readRecord(dir, name.slice(0, -'.json'.length)) : undefined;
    if (kept !== undefined && new Date(kept.at).getTime() < oldest) rmSync(join(dir, name), { force: true });
  }
}

/** The record of `tree`, or undefined if there is none of this version. */
export function readRecord(dir: string, tree: string): GateRecord | undefined {
  if (!TREE.test(tree)) return undefined;
  const record = readJson(join(dir, `${tree}.json`)) as GateRecord | undefined;
  if (record?.version !== RECORD_VERSION || record.tree !== tree || typeof record.steps !== 'object') return undefined;
  return record;
}
