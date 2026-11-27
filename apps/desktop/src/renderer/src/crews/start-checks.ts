import type { LibraryPrefab, Zone } from '@agent-board/daemon/protocol';

/** A box in a start dialog that can hold Start back. */
export type StartBox = 'zone' | 'repo' | 'work' | 'helpers';

/** Why Start is greyed: the box that is missing or wrong, and what to say next to it. */
export interface StartBlock {
  box: StartBox;
  reason: string;
}

/** A zone that needs a repo named for the crew: a group with no default of its own. */
export const needsRepo = (zone: Zone | undefined): boolean => zone !== undefined && zone.repoRoot === null && zone.defaultRepo === null;

/** A prefab whose graph takes a ticket as its work, as a drafted one can. (One that starts inside a ticket tile opens New ticket instead.) */
export const takesTicket = (prefab: Pick<LibraryPrefab, 'inputs'>): boolean => (prefab.inputs ?? []).some((input) => input.kind === 'ticket');

/**
 * Said under a typed ticket when no zone on the board reads issues. A tracker connected with no zone bound may still read
 * it; if none can, the start goes ahead with the ticket as typed, and its agent looks it up with its own tools.
 */
export const ticketLookupHint = (zones: readonly Zone[], ticket: string): string | undefined =>
  ticket.trim() !== '' && zones.every((zone) => zone.tracker === null)
    ? 'If no linked tracker can read it, the agent gets the ticket as typed and looks it up itself.'
    : undefined;

interface StartFields {
  zones: readonly Zone[];
  zone: Zone | undefined;
  repo: string | undefined;
  prompt: string;
  /** The ticket box, or undefined when the dialog shows none. */
  ticket: string | undefined;
}

const placeBlock = ({ zones, zone, repo }: StartFields, starts: string): StartBlock | undefined => {
  if (zones.length === 0) return { box: 'zone', reason: `${starts} starts in a zone: add one first.` };
  if (zone === undefined) return { box: 'zone', reason: 'Pick its zone.' };
  if (needsRepo(zone) && repo === undefined) return { box: 'repo', reason: `${zone.name} has no repo: choose the one it works in.` };
  return undefined;
};

/** Why the crew prompt's Start is greyed, or undefined when it can start. */
export function crewStartBlock(fields: StartFields): StartBlock | undefined {
  const place = placeBlock(fields, 'A crew');
  if (place !== undefined) return place;
  if (fields.prompt.trim() !== '' || (fields.ticket ?? '').trim() !== '') return undefined;
  return { box: 'work', reason: fields.ticket === undefined ? 'Say what it should do.' : 'Give it its ticket, or say what it should do.' };
}

/** Why the New ticket sheet's Start ticket is greyed, or undefined when it can start. */
export function ticketStartBlock(fields: StartFields & { preset: boolean }): StartBlock | undefined {
  const place = placeBlock(fields, 'A ticket');
  if (place !== undefined) return place;
  if (!fields.preset) return { box: 'helpers', reason: 'Pick its helpers.' };
  if (fields.prompt.trim() !== '' || (fields.ticket ?? '').trim() !== '') return undefined;
  return { box: 'work', reason: 'Give it its ticket, or say what it should do.' };
}
