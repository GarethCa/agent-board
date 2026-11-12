/**
 * A button that acts only on a second, separate press: the first arms it (it asks "Restart?"), and a press while armed
 * acts. A press too soon after arming is a double-click's second click, not an answer, and is ignored. It disarms by
 * itself after `TWO_STEP_MS`, or when the pointer or focus leaves it. So no one click, nor a double-click meant for
 * the tile under it, ever acts.
 */
export type TwoStep = { armedAt: number } | 'idle';

/** How long an armed button waits for its second press. */
export const TWO_STEP_MS = 3_000;

/** A press within this of arming is the same double-click's: it neither acts nor disarms. */
export const TWO_STEP_SETTLE_MS = 500;

/** What happened to the button at `now`: pressed, or its wait ran out, or the pointer or focus left it. */
export type TwoStepEvent = { kind: 'press'; now: number } | { kind: 'timeout' | 'leave' };

/** The button's next step, and whether this event is the one that acts. */
export function twoStep(step: TwoStep, event: TwoStepEvent): { step: TwoStep; act: boolean } {
  if (event.kind !== 'press') return { step: 'idle', act: false };
  if (step === 'idle') return { step: { armedAt: event.now }, act: false };
  if (event.now - step.armedAt < TWO_STEP_SETTLE_MS) return { step, act: false };
  return { step: 'idle', act: true };
}
