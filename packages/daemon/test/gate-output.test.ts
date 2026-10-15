import { describe, expect, it } from 'vitest';
import { applyGateEvent, finishGateSteps, lineStep, parseGateLine, type GateStep } from '../src/gate-output.ts';

const at = (second: number) => `2026-10-14T14:02:${String(second).padStart(2, '0')}.000Z`;

/** Feeds the lines through the parser, a second apart. */
function run(lines: string[]): GateStep[] {
  return lines.reduce<GateStep[]>((steps, line, i) => applyGateEvent(steps, parseGateLine(line), at(i)), []);
}

describe('gate output', () => {
  it('reads the step markers, and everything else as a line of output', () => {
    expect(parseGateLine('::gate steps lint typecheck  e2e')).toEqual({ type: 'steps', names: ['lint', 'typecheck', 'e2e'] });
    expect(parseGateLine('::gate start test')).toEqual({ type: 'start', name: 'test' });
    expect(parseGateLine('::gate start e2e log=/tmp/check/e2e.log')).toEqual({ type: 'start', name: 'e2e', log: '/tmp/check/e2e.log' });
    expect(parseGateLine('::gate end lint pass')).toEqual({ type: 'end', name: 'lint', passed: true });
    expect(parseGateLine('::gate end e2e fail')).toEqual({ type: 'end', name: 'e2e', passed: false });
    expect(parseGateLine('  ✓ src/cart.test.ts (12 tests)')).toEqual({ type: 'line', text: '  ✓ src/cart.test.ts (12 tests)' });
  });

  it('takes a marker it cannot read as output, not as a step', () => {
    for (const line of ['::gate start', '::gate end lint maybe', '::gate start lint log=relative.log', '::gate start a$b', '::gate frobnicate x']) {
      expect(parseGateLine(line)).toEqual({ type: 'line', text: line });
    }
  });

  it('lists declared steps as waiting, then runs and ends them with their times', () => {
    const steps = run(['::gate steps lint test', '::gate start lint', '::gate start test', '::gate end lint pass', 'noise']);

    expect(steps).toEqual([
      { name: 'lint', status: 'passed', startedAt: at(1), endedAt: at(3) },
      { name: 'test', status: 'running', startedAt: at(2), endedAt: null },
    ]);
  });

  it('adds a step that starts undeclared at the end, and keeps the log it names', () => {
    const steps = run(['::gate steps lint', '::gate start build log=/tmp/b.log', '::gate end build fail']);

    expect(steps.map((step) => [step.name, step.status, step.log])).toEqual([
      ['lint', 'waiting', undefined],
      ['build', 'failed', '/tmp/b.log'],
    ]);
  });

  it('gives a line of output to the one step running, and to no step when none or several are', () => {
    expect(lineStep(run(['::gate steps a b', '::gate start a']))).toBe('a');
    expect(lineStep(run(['::gate start a', '::gate start b']))).toBeUndefined();
    expect(lineStep(run(['::gate steps a']))).toBeUndefined();
  });

  it('ends a gate without markers as one step named after its command', () => {
    expect(finishGateSteps([], { command: 'pnpm check:local', outcome: 'passed', startedAt: at(0), endedAt: at(9) })).toEqual([
      { name: 'pnpm check:local', status: 'passed', startedAt: at(0), endedAt: at(9) },
    ]);
  });

  it('ends the steps still running as failed, and leaves those that never started waiting', () => {
    const steps = run(['::gate steps a b c', '::gate start a', '::gate end a pass', '::gate start b']);

    expect(finishGateSteps(steps, { command: 'x', outcome: 'failed', startedAt: at(0), endedAt: at(9) }).map((step) => [step.name, step.status, step.endedAt])).toEqual([
      ['a', 'passed', at(2)],
      ['b', 'failed', at(9)],
      ['c', 'waiting', null],
    ]);
  });
});
