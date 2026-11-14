// How the board shows who started whom. An orchestrator's crew is framed beside it, but the frame shows only while the
// orchestrator is focused: hovered, or selected (so one being dragged keeps it). While a crew is focused its tiles are
// lit and the board's other agent and shell tiles dim. A crew tile outside its orchestrator's frames carries a "from"
// chip instead, and hovering the chip focuses the crew too.
import { createContext, useEffect, useSyncExternalStore } from 'react';
import type { CrewFrame } from './crews';

export interface CrewView {
  /** The agents (by session id) drawn in a crew frame: a crew tile that isn't carries a "from" chip. */
  framed: ReadonlySet<string>;
}

export const CrewViewContext = createContext<CrewView>({ framed: new Set() });

/** The crew frames to draw, for the zones they are in. */
export const CrewFramesContext = createContext<readonly CrewFrame[]>([]);

/**
 * A tile's `data-crew`: the crews it is in, as space-separated orchestrator session ids. An orchestrator is in its own
 * crew, and in the crew of the orchestrator that started it, if one did. Undefined for a tile in no crew.
 */
export function crewsOf(sessionId: string, isOrchestrator: boolean, fromId: string | undefined): string | undefined {
  const crews = [...(isOrchestrator ? [sessionId] : []), ...(fromId !== undefined && fromId !== sessionId ? [fromId] : [])];
  return crews.length === 0 ? undefined : crews.join(' ');
}

let hovered: string | undefined;
let selected: ReadonlySet<string> = new Set();
let focused: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

function refocus(): void {
  const next = new Set(selected);
  if (hovered !== undefined) next.add(hovered);
  if (sameSet(next, focused)) return;
  focused = next;
  markCrewFocus();
  for (const listener of listeners) listener();
}

/** Focuses the crew of the orchestrator `orchestratorId` while the pointer is over it, or over a chip naming it. */
export function hoverCrew(orchestratorId: string): void {
  hovered = orchestratorId;
  refocus();
}

/** The pointer has left `orchestratorId` (or its tile has gone): its crew stays focused only if it is selected. */
export function leaveCrew(orchestratorId: string): void {
  if (hovered !== orchestratorId) return;
  hovered = undefined;
  refocus();
}

/** An orchestrator's tile: its crew is no longer focused for a hover once the tile goes, mid-hover or not. */
export function useCrewHover(orchestratorId: string | undefined): void {
  useEffect(() => (orchestratorId === undefined ? undefined : () => leaveCrew(orchestratorId)), [orchestratorId]);
}

/** The orchestrators selected on the board, by session id: their crews stay focused until they are unselected. */
export function selectCrews(orchestratorIds: Iterable<string>): void {
  const next = new Set(orchestratorIds);
  if (sameSet(next, selected)) return;
  selected = next;
  refocus();
}

/** The orchestrators whose crews are focused. */
export function focusedCrews(): ReadonlySet<string> {
  return focused;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The orchestrators whose crews are focused, redrawing the caller as they change. */
export function useFocusedCrews(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, focusedCrews, focusedCrews);
}

/** Whether a tile in the crews `crews` (its `data-crew`) is lit: one of them is focused. */
export function crewLit(crews: string | undefined): boolean {
  return crews?.split(' ').some((id) => focused.has(id)) ?? false;
}

/**
 * Whether a tile in the crews `crews` is lit, redrawing the tile only when that changes. Each tile reads its own, so a
 * tile the board mounts while its crew is focused (scrolled into view, or moved aside by an expanded tile) comes lit.
 */
export function useCrewLit(crews: string | undefined): boolean {
  const lit = () => crewLit(crews);
  return useSyncExternalStore(subscribe, lit, lit);
}

/** Marks the window's root `data-crew-focus` while any crew is focused, so the board's tiles outside it dim. */
function markCrewFocus(root: Pick<Element, 'toggleAttribute'> | undefined = globalThis.document?.documentElement): void {
  root?.toggleAttribute('data-crew-focus', focused.size > 0);
}
