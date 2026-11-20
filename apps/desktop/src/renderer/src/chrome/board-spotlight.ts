import type { SpotlightPlace } from './Spotlight';

/**
 * Where ⌘K was pressed in the board's window: the board, the session window shown over it, or an expanded tile with the
 * focus, by its node id (`agent:<session id>` or `shell:<id>`, as a row's key) and its agent's session or shell's id.
 */
export type BoardContext = { kind: 'board' } | { kind: 'window'; id: string } | { kind: 'expanded'; nodeId: string; id: string };

/**
 * ⌘K in an expanded tile: ↵ shows the tile picked on the board, as on the board itself, and picking the tile's own
 * session only closes the switcher. With nothing to say what opens beside, every pull request, page or session does,
 * in the tile.
 */
export const expandedPlace = (nodeId: string, id: string): SpotlightPlace<BoardContext> => ({ context: { kind: 'expanded', nodeId, id }, mode: 'show', current: nodeId });

/**
 * The session a pull request, page or session picked opens in as a tab: the session window's, or the expanded tile's,
 * so it stays expanded (opened from the board, its agent's own window would open and take the tile off the board).
 * None on the board.
 */
export const tabHostOf = (context: BoardContext): string | undefined => (context.kind === 'board' ? undefined : context.id);
