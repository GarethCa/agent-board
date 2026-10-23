// How the board shows who started whom: a crew frame beside each orchestrator (the default), a "from"
// chip on each agent it started, its crew lit while the chip or the orchestrator is hovered, or neither.
// Kept in the daemon's view state.
import { createContext } from 'react';
import type { CrewFrame } from './crews';

export type CrewLook = 'frames' | 'chips' | 'off';

/** The setting as saved (view state, read back untyped): crew frames unless another was saved. */
export function crewLookFrom(saved: unknown): CrewLook {
  return saved === 'chips' || saved === 'off' ? saved : 'frames';
}

/** The look ⇧C picks next: frames, chips, off, and round again. */
export function nextCrewLook(look: CrewLook): CrewLook {
  return look === 'frames' ? 'chips' : look === 'chips' ? 'off' : 'frames';
}

export interface CrewView {
  look: CrewLook;
  /** The agents (by session id) drawn in a crew frame: with chips, the whole crew carry one; with Off, none do. */
  framed: ReadonlySet<string>;
}

export const CrewViewContext = createContext<CrewView>({ look: 'frames', framed: new Set() });

/** The crew frames to draw, for the zones they are in; none with chips or off. */
export const CrewFramesContext = createContext<readonly CrewFrame[]>([]);

/**
 * Lights the crew of the orchestrator `orchestratorId` (it and the agents it started, each tile marked `data-crew`
 * with it), or puts the light out with undefined. Straight on the tiles, so a hover redraws nothing.
 */
export function lightCrew(orchestratorId: string | undefined): void {
  for (const lit of document.querySelectorAll('[data-crew-lit]')) lit.removeAttribute('data-crew-lit');
  if (orchestratorId === undefined) return;
  for (const tile of document.querySelectorAll(`[data-crew="${CSS.escape(orchestratorId)}"]`)) tile.setAttribute('data-crew-lit', '');
}
