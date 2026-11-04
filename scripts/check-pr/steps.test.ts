import { describe, expect, it } from 'vitest';
import type { Plan } from './select.ts';
import { STAGES, stepsFor } from './steps.ts';

const plan = (more: Partial<Plan>): Plan => ({ full: false, unit: [], e2e: [], visual: false, reasons: [], ...more });
const context = { leakCheck: false, exists: () => true, headless: false };

describe('stepsFor', () => {
  it('runs the whole unit project, then related tests in the processes project, for a desktop core plan', () => {
    const steps = stepsFor(plan({ unitAll: true, e2eAll: true, visual: true, unit: ['a.ts'], processes: ['a.ts'] }), context);
    expect(steps.find((step) => step.name === 'unit')!.argv).toEqual(['pnpm', 'exec', 'vitest', 'run', '--project', 'unit']);
    expect(steps.find((step) => step.name === 'processes')!.argv).toEqual(['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests', '--project', 'processes', 'a.ts']);
    expect(STAGES.findIndex((stage) => stage.includes('processes'))).toBeGreaterThan(STAGES.findIndex((stage) => stage.includes('unit')));
  });

  it('runs every app spec when the plan says all e2e', () => {
    const e2e = stepsFor(plan({ e2eAll: true }), context).find((step) => step.name === 'e2e')!;
    expect(e2e.argv).toEqual(['pnpm', '--filter', '@agent-board/desktop', 'exec', 'playwright', 'test', '--project=app', '--retries', '2', '--reporter', 'list,json', '--update-snapshots', 'none']);
  });

  it('adds the perf project to the e2e run when the plan says so', () => {
    const e2e = stepsFor(plan({ e2eAll: true, perf: true }), context).find((step) => step.name === 'e2e')!;
    expect(e2e.argv).toContain('--project=perf');
  });

  it('runs the processes step on the plan\'s processes files only, and not at all when there are none', () => {
    const steps = stepsFor(plan({ unitAll: true, unit: ['a.ts', 'b.ts'], processes: ['b.ts'] }), context);
    expect(steps.find((step) => step.name === 'processes')!.argv.at(-1)).toBe('b.ts');
    expect(stepsFor(plan({ unitAll: true, unit: ['a.ts'], processes: [] }), context).some((step) => step.name === 'processes')).toBe(false);
  });

  it('runs no processes step without a whole-unit plan', () => {
    expect(stepsFor(plan({ unit: ['a.ts'] }), context).some((step) => step.name === 'processes')).toBe(false);
  });

  it('runs the e2e specs with two retries, a JSON report for the flaky tests, and no baselines written', () => {
    const [e2e] = stepsFor(plan({ e2e: ['flow-edges.spec.ts'] }), context).filter((step) => step.name === 'e2e');
    expect(e2e).toMatchObject({ needsBuild: true, playwright: true });
    expect(e2e!.argv).toEqual([
      'pnpm', '--filter', '@agent-board/desktop', 'exec', 'playwright', 'test', '--project=app',
      '--retries', '2', '--reporter', 'list,json', '--update-snapshots', 'none',
      'e2e/flow-edges.spec.ts',
    ]);
  });

  it('runs the visual project the same way, in its own output dir', () => {
    const [visual] = stepsFor(plan({ visual: true }), context).filter((step) => step.name === 'visual');
    expect(visual).toMatchObject({ needsBuild: true, playwright: true });
    expect(visual!.argv).toEqual([
      'pnpm', '--filter', '@agent-board/desktop', 'test:visual', '--output', 'test-results-visual',
      '--retries', '2', '--reporter', 'list,json', '--update-snapshots', 'none',
    ]);
  });

  it('puts the Electron runs on a virtual display when there is none, and no other step', () => {
    const steps = stepsFor(plan({ e2e: ['flow-edges.spec.ts'], visual: true, unit: ['a.ts'] }), { ...context, headless: true });
    for (const step of steps) expect(step.argv[0] === 'sh', step.name).toBe(step.playwright === true);
  });

  it('always runs the static checks check-local.sh runs, knip among them', () => {
    const steps = stepsFor(plan({}), context);
    expect(steps.map((step) => step.name)).toEqual(['lint', 'typecheck', 'markdownlint', 'knip']);
    expect(steps.find((step) => step.name === 'knip')!.argv).toEqual(['pnpm', 'knip']);
  });

  it('puts every step in exactly one stage, knip in the first with the other static checks', () => {
    const steps = stepsFor(plan({ unit: ['a.ts'], e2e: ['flow-edges.spec.ts'], visual: true }), { ...context, leakCheck: true });
    for (const step of steps) expect(STAGES.filter((stage) => stage.includes(step.name)).length, step.name).toBe(1);
    expect(STAGES[0]).toEqual(expect.arrayContaining(['build', 'lint', 'typecheck', 'markdownlint', 'knip', 'release-leaks']));
  });

  it('gives no other step retries or a report', () => {
    const steps = stepsFor(plan({ unit: ['packages/daemon/src/a.ts', 'gone.ts'] }), { ...context, leakCheck: true, exists: (file) => file !== 'gone.ts' });
    expect(steps.map((step) => step.name)).toEqual(['lint', 'typecheck', 'markdownlint', 'knip', 'release-leaks', 'unit']);
    expect(steps.some((step) => step.playwright)).toBe(false);
    expect(steps.find((step) => step.name === 'unit')!.argv.at(-1)).toBe('packages/daemon/src/a.ts');
  });
});
