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
    { name: 'lint', argv: ['pnpm', 'lint'] },
    { name: 'typecheck', argv: ['pnpm', 'typecheck'] },
    { name: 'markdownlint', argv: ['pnpm', 'dlx', 'markdownlint-cli2@0.23.2'] },
  ];
  if (leakCheck) steps.push(leakCheckStep);
  const related = plan.unit.filter(exists);
  if (related.length > 0) {
    steps.push({ name: 'unit', argv: ['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests', ...related] });
  }
  if (plan.e2e.length > 0 || plan.visual) steps.unshift({ name: 'build', argv: ['pnpm', 'build'] });
  if (plan.e2e.length > 0) {
    const specs = plan.e2e.map((spec) => `e2e/${spec}`);
    steps.push({
      name: 'e2e',
      needsBuild: true,
      playwright: true,
      argv: [...headless, 'pnpm', '--filter', '@agent-board/desktop', 'exec', 'playwright', 'test', '--project=app', ...PLAYWRIGHT_ARGS, ...specs],
    });
  }
  if (plan.visual) {
    steps.push({
      name: 'visual',
      needsBuild: true,
      playwright: true,
      // Its own output dir, beside the e2e one: Playwright empties its output dir at the start of a run.
      argv: [...headless, 'pnpm', '--filter', '@agent-board/desktop', 'test:visual', '--output', 'test-results-visual', ...PLAYWRIGHT_ARGS],
    });
  }
  return steps;
}
