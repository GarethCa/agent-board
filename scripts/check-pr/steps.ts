/**
 * The steps `check:pr` runs for a plan (select.ts), and the commands they run.
 */
import type { Plan } from './select.ts';

export interface Step {
  name: string;
  argv: string[];
  /** Steps that start only once the build has passed. */
  needsBuild?: boolean;
  /** A Playwright run, given retries and a JSON report (`<name>.json` beside its log) to read its flaky tests from. */
  playwright?: boolean;
}

/**
 * As in check-local.sh: a test that passes on a retry passes, and the table names it as flaky. No run writes a
 * screenshot baseline: Playwright's default writes a missing one, and the retry would then pass against it.
 */
const PLAYWRIGHT_ARGS = ['--retries', '2', '--reporter', 'list,json', '--update-snapshots', 'none'];

/** The release's leak check on this branch (no pnpm install, no gate): a bare ticket ID in a changed file would stop the next release. */
export const leakCheckStep: Step = { name: 'release-leaks', argv: ['pnpm', 'release:public', '0.0.0', '--dry-run', '--skip-verify', '--ref', 'HEAD'] };

/** The static steps: when one fails, the gate stops before the unit tests, as it can no longer pass. */
export const QUICK_STEPS = ['preflight', 'lint', 'typecheck', 'markdownlint', 'knip', 'release-leaks'];

/**
 * The stages `check:pr` runs the steps in, as in check-local.sh: the heavy runs never overlap, because the unit tests
 * (5-second timeouts) and the e2e fail when starved. A step in none of them would never run.
 */
export const STAGES: string[][] = [
  // The pre-flight alone, about a second: on its failure nothing else runs.
  ['preflight'],
  ['build', 'lint', 'typecheck', 'markdownlint', 'knip', 'release-leaks'],
  ['unit'],
  // Related tests of the processes project, after a whole-unit run; the unit step's timeouts need the machine to themselves.
  ['processes'],
  // The Electron runs hold the e2e lock; the native visual run goes first, then the e2e.
  ['visual'],
  ['e2e'],
];

export interface StepContext {
  /** Whether a changed file names a ticket ID, so the release leak check runs. */
  leakCheck: boolean;
  /** Whether a repo-relative path exists: a deleted file has no related tests to run. */
  exists: (file: string) => boolean;
  /** Linux with no display: the Electron runs go on a virtual one (scripts/e2e-headless.sh). */
  headless: boolean;
}

export function stepsFor(plan: Plan, { leakCheck, exists, headless: onVirtualDisplay }: StepContext): Step[] {
  const headless = onVirtualDisplay ? ['sh', 'scripts/e2e-headless.sh'] : [];
  const steps: Step[] = [
    // A merge conflict with main, a left conflict marker or a clashing migration number (scripts/preflight).
    { name: 'preflight', argv: ['pnpm', 'preflight'] },
    { name: 'lint', argv: ['pnpm', 'lint'] },
    { name: 'typecheck', argv: ['pnpm', 'typecheck'] },
    { name: 'markdownlint', argv: ['pnpm', 'dlx', 'markdownlint-cli2@0.23.2'] },
    // Unused files, exports and dependencies (about 5 s); check-local.sh runs it too, so a PR that leaves one fails here, not on main.
    { name: 'knip', argv: ['pnpm', 'knip'] },
  ];
  if (leakCheck) steps.push(leakCheckStep);
  const related = plan.unit.filter(exists);
  const visualFiles = (plan.visualFiles ?? []).filter((file) => exists(`apps/desktop/e2e/${file}`));
  if (plan.testAll) {
    steps.push({ name: 'unit', argv: ['pnpm', 'test'] });
  } else if (plan.unitAll) {
    steps.push({ name: 'unit', argv: ['pnpm', 'exec', 'vitest', 'run', '--project', 'unit'] });
    // The whole unit project covers the related tests that live in it; the processes project (scanners, scripts) still gets its own.
    const processesRelated = (plan.processes ?? []).filter(exists);
    if (processesRelated.length > 0) steps.push({ name: 'processes', argv: ['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests', '--project', 'processes', ...processesRelated] });
  } else if (related.length > 0) {
    steps.push({ name: 'unit', argv: ['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests', ...related] });
  }
  if (plan.e2e.length > 0 || plan.e2eAll || plan.visual || visualFiles.length > 0) steps.unshift({ name: 'build', argv: ['pnpm', 'build'] });
  if (plan.e2e.length > 0 || plan.e2eAll) {
    // Every app spec, or the listed ones: a list beside `e2eAll` would narrow the run to it.
    const specs = plan.e2eAll ? [] : plan.e2e.map((spec) => `e2e/${spec}`);
    steps.push({
      name: 'e2e',
      needsBuild: true,
      playwright: true,
      argv: [...headless, 'pnpm', '--filter', '@agent-board/desktop', 'exec', 'playwright', 'test', '--project=app', ...(plan.perf ? ['--project=perf'] : []), ...PLAYWRIGHT_ARGS, ...specs],
    });
  }
  if (plan.visual || visualFiles.length > 0) {
    steps.push({
      name: 'visual',
      needsBuild: true,
      playwright: true,
      // Its own output dir, beside the e2e one: Playwright empties its output dir at the start of a run.
      argv: [...headless, 'pnpm', '--filter', '@agent-board/desktop', 'test:visual', '--output', 'test-results-visual', ...PLAYWRIGHT_ARGS, ...(plan.visual ? [] : visualFiles)],
    });
  }
  return steps;
}

export interface StageHooks {
  /** Runs one step and records its outcome. */
  settle: (step: Step) => Promise<void>;
  /** A step's recorded outcome (`pass`, or a failure), undefined while it has not run. */
  outcomeOf: (name: string) => string | undefined;
  /** Runs the Electron stages, in order, each stage's steps together; the caller holds the e2e lock around them. */
  runElectron: (stages: Step[][]) => Promise<void>;
}

/**
 * Runs `steps` in their STAGES. A failed pre-flight stops the run there, and a failed quick step stops it before the
 * unit tests, as the gate can no longer pass; a failed build stops only the Electron runs. Returns why the steps that
 * did not run were skipped, for their rows in the table.
 */
export async function runStages(steps: Step[], { settle, outcomeOf, runElectron }: StageHooks): Promise<{ notRun: string }> {
  const named = (names: string[]): Step[] => steps.filter((step) => names.includes(step.name));
  const runStage = async (names: string[]): Promise<void> => void (await Promise.all(named(names).map(settle)));
  const failedQuick = (): string | undefined => QUICK_STEPS.find((name) => (outcomeOf(name) ?? 'pass') !== 'pass');
  const [preflightStage, staticStage, unitStage, processesStage, ...electronStages] = STAGES as [string[], string[], string[], string[], ...string[][]];
  await runStage(preflightStage);
  if (failedQuick() === undefined) await runStage(staticStage);
  const quickFailure = failedQuick();
  if (quickFailure !== undefined) return { notRun: quickFailure === 'preflight' ? 'the pre-flight failed' : 'a quick check failed' };
  await runStage(unitStage);
  await runStage(processesStage);
  const electron = electronStages.map(named).filter((stage) => stage.length > 0);
  if ((outcomeOf('build') ?? 'pass') === 'pass' && electron.length > 0) await runElectron(electron);
  return { notRun: 'the build failed' };
}
