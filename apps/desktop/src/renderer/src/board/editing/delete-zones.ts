import type { Zone } from '@agent-board/daemon/protocol';
import { keyText } from '../../keys/registry';

/** A zone to delete, with what is on it. */
export interface ZoneToDelete {
  zone: Pick<Zone, 'name' | 'repoRoot' | 'managedClone'>;
  /** The session tiles in it, which stay on the board, loose. */
  tiles: number;
  /** The connectors on the zone itself, which go with it. */
  connectors: number;
}

/** `path` with the home folder written `~`. */
function shown(path: string, home: string | undefined): string {
  return home !== undefined && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** Spells out `names` as "A, B and C". */
function listed(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * What the one confirmation of deleting zones says: the title naming them, the lines under it, and, if any is a
 * clone the app made, the label of the unticked box that deletes the clone too (which ⌘Z can't bring back).
 */
export function zoneDeleteText(zones: ZoneToDelete[], home?: string): { title: string; lines: string[]; cloneLabel?: string } {
  const many = zones.length > 1;
  const names = zones.map(({ zone }) => zone.name);
  const tiles = zones.reduce((sum, each) => sum + each.tiles, 0);
  const connectors = zones.some((each) => each.connectors > 0);
  const bound = zones.some(({ zone }) => zone.repoRoot !== null);
  const clones = zones.filter(({ zone }) => zone.managedClone && zone.repoRoot !== null);
  const stay =
    tiles === 0
      ? ''
      : many
        ? ` ${tiles === 1 ? 'Their tile stays where it is' : `Their ${tiles} tiles stay where they are`}.`
        : ` ${tiles === 1 ? 'Its tile stays on the board where it is' : `Its ${tiles} tiles stay on the board where they are`}.`;
  const lines = [`${listed(names)} come${many ? '' : 's'} off the board.${stay}`];
  if (connectors) lines.push(`The connectors on ${many ? 'them go with them' : 'it go with it'}.`);
  if (bound || tiles > 0) lines.push(`No session, worktree or branch is deleted, and ${bound ? "the repo's folder isn't touched" : 'nothing else is touched'}.`);
  lines[lines.length - 1] += ` ${keyText('edit.undo')} brings ${many ? 'them' : 'it'} back.`;
  const where = clones.map(({ zone }) => `${clones.length > 1 ? `${zone.name}: ` : ''}${shown(zone.repoRoot!, home)}`);
  const cloneLabel =
    clones.length === 0 ? undefined : `Also delete the clone${clones.length > 1 ? 's' : ''} in ${where.join(', ')} (${keyText('edit.undo')} can't bring it back)`;
  return { title: many ? `Delete ${zones.length} zones?` : `Delete zone ${names[0]}?`, lines, cloneLabel };
}
