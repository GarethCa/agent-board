import { describe, expect, it } from 'vitest';
import { twoStep, TWO_STEP_SETTLE_MS, type TwoStep, type TwoStepEvent } from './two-step';

/** The step after each event in turn, and how many of them acted. */
function run(events: TwoStepEvent[]): { step: TwoStep; acted: number } {
  let step: TwoStep = 'idle';
  let acted = 0;
  for (const event of events) {
    const next = twoStep(step, event);
    step = next.step;
    if (next.act) acted += 1;
  }
  return { step, acted };
}

const press = (now: number): TwoStepEvent => ({ kind: 'press', now });

describe('a two-step button', () => {
  it('never acts on one press: it arms', () => {
    expect(run([press(0)])).toEqual({ step: { armedAt: 0 }, acted: 0 });
  });

  it('acts on a second, separate press, then is idle again', () => {
    expect(run([press(0), press(1_000)])).toEqual({ step: 'idle', acted: 1 });
    expect(run([press(0), press(1_000), press(2_000)])).toEqual({ step: { armedAt: 2_000 }, acted: 1 });
  });

  it("ignores a double-click's second press: it stays armed, and only a later press acts", () => {
    expect(run([press(0), press(200)])).toEqual({ step: { armedAt: 0 }, acted: 0 });
    expect(run([press(0), press(200), press(TWO_STEP_SETTLE_MS)])).toEqual({ step: 'idle', acted: 1 });
  });

  it('disarms when its wait runs out, or the pointer or focus leaves it, so the next press only arms it again', () => {
    expect(run([press(0), { kind: 'timeout' }, press(1_000)])).toEqual({ step: { armedAt: 1_000 }, acted: 0 });
    expect(run([press(0), { kind: 'leave' }, press(1_000)])).toEqual({ step: { armedAt: 1_000 }, acted: 0 });
  });
});
