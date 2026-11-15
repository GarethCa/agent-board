// The callbacks and state a zone's drawing reads from the board, as React contexts, and why a zone can start no agent.
// Their own module, so the zone and the parts of it drawn in their own files (its folded form, its project well) can
// all read them without importing one another.
import { createContext } from 'react';
import type { Zone, ZoneBinding, ZoneLayout } from '@agent-board/daemon/protocol';
import type { ZoneBindingActions } from './menu-model';

/** Persists a zone's layout once the user has finished moving or resizing it. */
export const SaveZoneLayoutContext = createContext<(id: string, layout: ZoneLayout) => void>(() => {});

/** What the board does as a zone is resized: its tiles are packed inward as it shrinks past them. */
export interface ZoneResize {
  /** A resize of the zone begins. */
  start(id: string): void;
  /** Whether the zone can take the layout `next`: false once its tiles can be packed no tighter, keeping those that fit. */
  resize(id: string, next: ZoneLayout): boolean;
}
export const ZoneResizeContext = createContext<ZoneResize>({ start: () => {}, resize: () => true });

/** Why a group with no default repo can't start an agent from an issue: there is no repo to ask for one in. */
const BIND_FIRST = 'Bind this zone to a repo, or give it a default repo, first';
/** Why a cloning zone's New agent button does nothing (S2). */
const AFTER_CLONE = 'Available after clone finishes';

/**
 * Why no agent can start in the zone with no repo picked for it: it is cloning, or a group with no default repo.
 * Undefined when one can.
 */
export function whyNoAgents(zone: Pick<Zone, 'clone' | 'repoRoot' | 'defaultRepo'>): string | undefined {
  if (zone.clone !== null) return AFTER_CLONE;
  return zone.repoRoot === null && zone.defaultRepo === null ? BIND_FIRST : undefined;
}

/** Stops a zone's clone; the zone goes with it. */
export const CancelCloneContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user for an issue from the zone's tracker, to put its card in the zone or start an agent from it. */
export const AddIssueContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user for a new agent's task, to start it in the zone. */
export const NewAgentContext = createContext<(zone: Zone) => void>(() => {});

/** Starts a shell tile in the zone: in its folder, or at home if it is unbound. */
export const NewShellContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user which tracker team or repo the zone's issues come from. */
export const ZoneTrackerContext = createContext<(zone: Zone) => void>(() => {});

/** The zone a dragged tile or note would move into if dropped now, which shows it is the drop target. */
export const DropTargetContext = createContext<string | undefined>(undefined);

/** Asks the user for a folder to bind an unbound zone to, as a repo or as a new project. */
export const BindZoneContext = createContext<(zone: Zone, as: ZoneBinding) => void>(() => {});

export const ZoneBindingContext = createContext<ZoneBindingActions>({
  unbind: () => {},
  initRepo: () => {},
  pickDefaultRepo: () => {},
  tidy: () => {},
  setSpacing: () => {},
  openSettings: () => {},
  setLayoutMode: () => {},
  fold: () => {},
  unfold: () => {},
  rename: () => Promise.resolve(),
  recolor: () => {},
  previewFill: () => {},
  setFill: () => {},
  cancelFill: () => {},
  deleteZone: () => {},
  setTrustsFolder: () => {},
  setBoardMcp: () => {},
  editGateCommand: () => {},
  editRoleTemplates: () => {},
  startCrew: () => {},
  crewLibrary: () => {},
  newTicket: () => {},
  addStageBoard: () => {},
});
