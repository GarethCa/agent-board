/**
 * `check:pr --recheck`: after a full `check:local` run that failed, check a fix in minutes. It finds the result record
 * of the nearest commit the full gate ran on (scripts/gate-results), and reruns only:
 *
 *  - the static checks, always (the pre-flight, lint, typecheck, Markdown lint, knip);
 *  - what the record says failed: the failed test files and specs, or the whole step when a failure names no file;
 *  - what changed since that commit, chosen as check:pr chooses for a PR (select.ts).
 *
 * Every other pass in the record is reused. A recheck is check:pr's subset, not the full gate, so it never writes the
 * green stamp, which the release trusts as a full pass (a fix that falls back to the full check:local is a full run, and
 * stamps like any other). A recheck of a failed run that passes on a clean tree writes a record of its own (marked
 * `rechecks`), so a second fix can recheck on top.
 */
import { execFileSync } from 'node:child_process';
import { readRecord, type GateRecord } from '../gate-results/results.ts';
import type { Plan } from './select.ts';

/** How many first-parent commits back from HEAD to look for a record. */
const MAX_RECORD_DISTANCE = 50;

/** The baselines' dir, apps/desktop/e2e/visual.spec.ts-snapshots/. */
const SNAPSHOTS = 'apps/desktop/e2e/visual.spec.ts-snapshots/';
const VISUAL_SPEC = /^apps\/desktop\/e2e\/visual\/[^/]+\.spec\.ts$/;
/** The specs `playwright test --project app` runs; another project's spec (the perf benchmark) reruns the whole e2e step. */
const APP_SPEC = /^[^/]+\.spec\.ts$/;
const PERF_SPECS = ['board-perf.spec.ts'];

/** The nearest record on HEAD's first-parent line, HEAD's own tree first, with how many commits back it is. */
export function findRecord(root: string, dir: string): { record: GateRecord; behind: number } | undefined {
  const log = execFileSync('git', ['-C', root, 'log', '--first-parent', `-n${MAX_RECORD_DISTANCE + 1}`, '--format=%T'], { encoding: 'utf8' });
  const trees = log.split('\n').filter(Boolean);
  for (const [behind, tree] of trees.entries()) {
    const record = readRecord(dir, tree);
    if (record !== undefined) return { record, behind };
  }
  return undefined;
}

export interface Recheck {
  plan: Plan;
  /** The record's steps that passed and run no part again: their passes stand. */
  reused: string[];
  /** Whether the record's run failed a step: only then is the recheck a fix to a failed run, worth a record of its own. */
  failedRun: boolean;
}

/**
 * The plan for a recheck: `changed`, the plan select.ts makes for the files changed since the record, with what the
 * record failed added. `selectVisual` says whether a set of changed files needs the visual run, as select.ts decides.
 */
export function recheckPlan(record: GateRecord, changed: Plan, changedFiles: readonly string[], selectVisual: (files: string[]) => boolean): Recheck {
  const plan: Plan = { ...changed, unit: [...changed.unit], e2e: [...changed.e2e], reasons: [...changed.reasons] };
  const short = record.sha.slice(0, 7);
  const reused: string[] = [];
  const step = (name: string) => record.steps[name] ?? { outcome: 'not run' };

  // A step whose pass stands is reused only when nothing of it runs again; the change's own selection still runs.
  const test = step('test');
  if (test.outcome === 'pass') {
    if (plan.unit.length === 0 && !plan.unitAll) reused.push('test');
  } else if (test.failed !== undefined) {
    plan.unit.push(...test.failed.filter((file) => !plan.unit.includes(file)));
    // The whole unit project runs for the change already; the failed processes-project files need the related run.
    if (plan.unitAll) plan.processes = [...new Set([...(plan.processes ?? []), ...test.failed])];
    plan.reasons.push(`recheck: unit tests, the ${test.failed.length} file(s) that failed on ${short}`);
  } else {
    plan.testAll = true;
    plan.reasons.push(`recheck: every unit test, as the run on ${short} ended ${test.outcome} with no failed file to rerun`);
  }

  const e2e = step('e2e');
  if (e2e.outcome === 'pass') {
    if (plan.e2e.length === 0 && !plan.e2eAll) reused.push('e2e');
  } else if (plan.e2eAll && e2e.failed !== undefined && e2e.failed.every((spec) => APP_SPEC.test(spec) && !PERF_SPECS.includes(spec))) {
    // The change runs every app spec, the failed ones among them.
    plan.reasons.push(`recheck: e2e, every app spec as the change needs, the ${e2e.failed.length} that failed on ${short} among them`);
  } else if (e2e.failed !== undefined && e2e.failed.every((spec) => APP_SPEC.test(spec) && !PERF_SPECS.includes(spec))) {
    plan.e2e.push(...e2e.failed.filter((spec) => !plan.e2e.includes(spec)));
    plan.reasons.push(`recheck: e2e, the ${e2e.failed.length} spec(s) that failed on ${short}`);
  } else {
    plan.e2eAll = true;
    plan.perf = true;
    plan.e2e = [];
    plan.reasons.push(`recheck: every e2e spec, as the run on ${short} ended ${e2e.outcome} with no app spec to rerun alone`);
  }

  const visual = step('visual');
  if (visual.outcome === 'pass') {
    if (!plan.visual) reused.push('visual');
  } else if (visual.failed !== undefined) {
    // A fix that only moves the failed shots' baselines, or edits visual specs, needs just those files; anything else
    // that the visual run checks (styles, markup) needs the whole run.
    const shots = new Set(visual.shots ?? []);
    const rest = changedFiles.filter((file) => !(file.startsWith(SNAPSHOTS) && shots.has(file.slice(SNAPSHOTS.length))) && !VISUAL_SPEC.test(file));
    if (!selectVisual(rest)) {
      const specs = changedFiles.filter((file) => VISUAL_SPEC.test(file)).map((file) => file.slice('apps/desktop/e2e/'.length));
      plan.visual = false;
      plan.visualFiles = [...new Set([...visual.failed, ...specs])].toSorted();
      plan.reasons = plan.reasons.filter((reason) => !reason.startsWith('visual: '));
      plan.reasons.push(`recheck: visual, the ${visual.failed.length} file(s) that failed on ${short}${specs.length > 0 ? ` and ${specs.length} changed visual spec(s)` : ''}; the fix changes no other shot`);
    } else {
      plan.visual = true;
      plan.reasons.push(`recheck: every visual shot, as the fix changes more than the failed shots' baselines`);
    }
  } else {
    plan.visual = true;
    plan.reasons.push(`recheck: every visual shot, as the run on ${short} ended ${visual.outcome} with no failed file to rerun`);
  }
  if (plan.visual) delete plan.visualFiles;
  return { plan, reused, failedRun: Object.values(record.steps).some((recorded) => recorded.outcome !== 'pass') };
}
