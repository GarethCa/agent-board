// The one Esc ladder: every Esc the board and its windows answer to, in the order it is undone. An input method's
// composition, a field, a menu, popover or dialog take their own Esc first (they are the innermost things); then, one
// step a press: a hand-off being dragged, Connect to…, the armed tool, the open shelves, the expanded tile or session
// window with the focus (collapsed or minimised, the focus back on its tile), and last the expanded tile in front. Each handler adds its
// step here with `useEscStep`, rather than listening on its own and holding its place by the phase it listens in.
import { useEffect, useRef } from 'react';

/** A step's place on the ladder. */
export type EscRung = 'handOff' | 'connect' | 'tool' | 'shelves' | 'surface' | 'frontTile';

interface Rung {
  rung: EscRung;
  /**
   * `capture`: before anything inside has the press, as a gesture under way holds the keyboard wherever the focus is.
   * `bubble`: once the focused thing has had it.
   */
  phase: 'capture' | 'bubble';
  /** Whether it is left out once something inside took the press (prevented it): a field, a menu, a dialog. */
  yields: boolean;
}

/** The ladder, innermost first. */
export const ESC_LADDER: readonly Rung[] = [
  { rung: 'handOff', phase: 'capture', yields: false },
  { rung: 'connect', phase: 'capture', yields: false },
  // As before the ladder, the armed tool goes down even with a menu or field taking the same press.
  { rung: 'tool', phase: 'bubble', yields: false },
  { rung: 'shelves', phase: 'bubble', yields: true },
  { rung: 'surface', phase: 'bubble', yields: true },
  { rung: 'frontTile', phase: 'bubble', yields: true },
];

const PLACE = new Map(ESC_LADDER.map((rung, at) => [rung.rung, { ...rung, at }]));

export interface EscStep {
  rung: EscRung;
  /** Whether it is there to undo for this press: the tool armed, the focus in its window. */
  takes(event: EscPress): boolean;
  run(event: EscPress): void;
}

export type EscPress = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented' | 'target'>;

/**
 * Esc, with no input method composing. A gesture under way (the capture rungs) takes it whatever is held, as ⌥ is held
 * to draw a hand-off; the rest take it with no modifier but Shift (⌘Esc is the way out of a terminal).
 */
const isEsc = (event: EscPress, phase: Rung['phase']) => event.key === 'Escape' && !event.isComposing && (phase === 'capture' || (!event.metaKey && !event.ctrlKey && !event.altKey));

/** The step a press takes in this phase: the innermost one there to undo, or none. */
export function escStep(steps: Iterable<EscStep>, event: EscPress, phase: Rung['phase']): EscStep | undefined {
  if (!isEsc(event, phase)) return undefined;
  const ordered = [...steps].sort((a, b) => PLACE.get(a.rung)!.at - PLACE.get(b.rung)!.at);
  return ordered.find((step) => {
    const rung = PLACE.get(step.rung)!;
    return rung.phase === phase && !(rung.yields && event.defaultPrevented) && step.takes(event);
  });
}

const steps = new Set<EscStep>();

function dispatch(phase: Rung['phase']) {
  return (event: KeyboardEvent) => {
    const step = escStep(steps, event, phase);
    if (step === undefined) return;
    event.preventDefault();
    // A gesture's Esc is its alone: nothing inside (a terminal, the board's own keys) has it as well.
    if (phase === 'capture') event.stopPropagation();
    step.run(event);
  };
}
const onCapture = dispatch('capture');
const onBubble = dispatch('bubble');

/** Puts a step on the ladder, listening while any step is on it; returns how to take it off. */
function addEscStep(step: EscStep): () => void {
  if (steps.size === 0) {
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onBubble);
  }
  steps.add(step);
  return () => {
    steps.delete(step);
    if (steps.size > 0) return;
    window.removeEventListener('keydown', onCapture, true);
    window.removeEventListener('keydown', onBubble);
  };
}

/** A component's step on the ladder, for as long as it is mounted. `takes` and `run` are read at each press. */
export function useEscStep(rung: EscRung, takes: (event: EscPress) => boolean, run: (event: EscPress) => void): void {
  const latest = useRef({ takes, run });
  latest.current = { takes, run };
  useEffect(() => addEscStep({ rung, takes: (event) => latest.current.takes(event), run: (event) => latest.current.run(event) }), [rung]);
}
