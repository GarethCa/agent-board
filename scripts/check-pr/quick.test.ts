import { describe, expect, it } from 'vitest';
import { failureLines, quickReport } from './quick.ts';
import { stepsFor } from './steps.ts';
import type { Plan } from './select.ts';

const plan = (more: Partial<Plan>): Plan => ({ full: false, unit: [], e2e: [], visual: false, reasons: [], ...more });
const context = { leakCheck: true, exists: () => true, headless: false };

describe('stepsFor with quick', () => {
  const heavy = plan({ unit: ['a.ts', 'apps/desktop/src/renderer/src/tokens.test.ts'], e2e: ['x.spec.ts'], visual: true, e2eAll: true });
  it('drops the build, e2e and visual steps the full selection chooses', () => {
    const full = stepsFor(heavy, context).map((s) => s.name);
    expect(full).toEqual(expect.arrayContaining(['build', 'e2e', 'visual']));
    const quick = stepsFor(heavy, { ...context, quick: true }).map((s) => s.name);
    expect(quick).not.toEqual(expect.arrayContaining(['build']));
    for (const name of ['build', 'e2e', 'visual']) expect(quick).not.toContain(name);
    expect(quick).toEqual(expect.arrayContaining(['preflight', 'lint', 'typecheck', 'knip', 'unit', 'release-leaks']));
  });
  it('keeps the file-scanning tests the plan lists', () => {
    const unit = stepsFor(heavy, { ...context, quick: true }).find((s) => s.name === 'unit')!;
    expect(unit.argv).toContain('apps/desktop/src/renderer/src/tokens.test.ts');
  });
});

describe('failureLines', () => {
  it('keeps failure lines, strips colour, and caps with a pointer to the log', () => {
    const log = ['ok line', '\u001b[31m FAIL \u001b[0m a.test.ts > does x', 'AssertionError: expected 1 to be 2', ' ❯ a.test.ts:12:5', ...Array.from({ length: 60 }, (_, i) => `src/f${i}.ts:${i + 1} error`)].join('\n');
    const lines = failureLines(log);
    expect(lines[0]).toBe(' FAIL  a.test.ts > does x');
    expect(lines).not.toContain('ok line');
    expect(lines).toHaveLength(41);
    expect(lines.at(-1)).toMatch(/more line\(s\) in the full log/);
  });
});

describe('quickReport', () => {
  const row = (name: string, outcome = 'pass') => ({ name, outcome, seconds: 1, logPath: `/l/${name}.log` });
  it('is under 20 lines when green', () => {
    const out = quickReport(['preflight', 'lint', 'typecheck', 'markdownlint', 'knip', 'unit', 'processes'].map((n) => row(n)), 30);
    expect(out.length).toBeLessThan(20);
    expect(out.at(-1)).toMatch(/passed/);
  });
  it('shows a failing step its failures and its log path', () => {
    const out = quickReport([row('lint'), { ...row('unit', 'FAIL'), log: 'FAIL a.test.ts\nsrc/a.ts:3 error' }], 5);
    expect(out.join('\n')).toContain('unit failed (full log: /l/unit.log)');
    expect(out.join('\n')).toContain('src/a.ts:3 error');
    expect(out.at(-1)).toBe('quick checks FAILED: unit');
  });
});
