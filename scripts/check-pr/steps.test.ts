import { describe, expect, it } from 'vitest';
import type { Plan } from './select.ts';
import { stepsFor } from './steps.ts';

const plan = (more: Partial<Plan>): Plan => ({ full: false, unit: [], e2e: [], visual: false, reasons: [], ...more });
const context = { leakCheck: false, exists: () => true, headless: false };

describe('stepsFor', () => {
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

  it('gives no other step retries or a report', () => {
    const steps = stepsFor(plan({ unit: ['packages/daemon/src/a.ts', 'gone.ts'] }), { ...context, leakCheck: true, exists: (file) => file !== 'gone.ts' });
    expect(steps.map((step) => step.name)).toEqual(['lint', 'typecheck', 'markdownlint', 'release-leaks', 'unit']);
    expect(steps.some((step) => step.playwright)).toBe(false);
    expect(steps.find((step) => step.name === 'unit')!.argv.at(-1)).toBe('packages/daemon/src/a.ts');
  });
});
