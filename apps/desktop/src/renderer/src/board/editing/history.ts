// The board's undo history: pure, so the board decides what a step's states mean and how to apply them.

/** What some board objects were, or became, by key: null for one that wasn't there. */
export type States<T> = ReadonlyMap<string, T | null>;

/** One undoable change: the objects it touched, as they were before it and after it. */
export interface Step<T> {
  before: States<T>;
  after: States<T>;
  /** Steps with the same key, recorded close together, undo as one, such as the saves made while typing a note. */
  coalesce?: string;
  /** When it was recorded, ms. */
  at: number;
}

export interface History<T> {
  /** Done steps, oldest first. */
  done: readonly Step<T>[];
  /** Undone steps, the next one to redo last. */
  undone: readonly Step<T>[];
}

/** How many steps the history keeps: the oldest go past it. */
export const HISTORY_LIMIT = 200;
/** How soon after the last a step with its coalescing key must come to be merged into it, ms. */
const COALESCE_MS = 2_000;

export const emptyHistory = <T>(): History<T> => ({ done: [], undone: [] });
export const canUndo = (history: History<unknown>) => history.done.length > 0;
export const canRedo = (history: History<unknown>) => history.undone.length > 0;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether `step` leaves every object it touched as it found it. */
const changesNothing = <T>(step: Step<T>) => [...step.after].every(([key, value]) => same(step.before.get(key) ?? null, value));

/** `first` and then `second` as one step: what each object was before the first touched it, and after the last did. */
export function merged<T>(first: Step<T>, second: Step<T>): Step<T> {
  return {
    before: new Map([...second.before, ...first.before]),
    after: new Map([...first.after, ...second.after]),
    coalesce: second.coalesce,
    at: second.at,
  };
}

/** `history` with `step` done: merged into the last step if it coalesces with it, and nothing left to redo. */
export function record<T>(history: History<T>, step: Step<T>): History<T> {
  const last = history.done.at(-1);
  const coalesces = last !== undefined && step.coalesce !== undefined && last.coalesce === step.coalesce && step.at - last.at <= COALESCE_MS;
  const next = coalesces ? merged(last, step) : step;
  const kept = coalesces ? history.done.slice(0, -1) : history.done;
  const done = changesNothing(next) ? kept : [...kept, next].slice(-HISTORY_LIMIT);
  return { done, undone: [] };
}

/** The last step undone: the states to put back, and the history after. Undefined with nothing to undo. */
export function undo<T>(history: History<T>): { apply: States<T>; history: History<T> } | undefined {
  const step = history.done.at(-1);
  if (step === undefined) return undefined;
  return { apply: step.before, history: { done: history.done.slice(0, -1), undone: [...history.undone, step] } };
}

/** The last undone step done again: the states to put back, and the history after. Undefined with nothing to redo. */
export function redo<T>(history: History<T>): { apply: States<T>; history: History<T> } | undefined {
  const step = history.undone.at(-1);
  if (step === undefined) return undefined;
  return { apply: step.after, history: { done: [...history.done, step], undone: history.undone.slice(0, -1) } };
}

/**
 * `history` without its last step if all that did was make the object `key`: for one made and at once taken away
 * again, such as a text item left empty, which leaves nothing to undo.
 */
export function withoutLastCreation<T>(history: History<T>, key: string): History<T> {
  const last = history.done.at(-1);
  if (last === undefined || last.after.size !== 1 || last.before.get(key) !== null || !last.after.has(key)) return history;
  return { ...history, done: history.done.slice(0, -1) };
}
