import type { Surface } from '@agent-board/daemon/window-layout';
import type { SpotlightPlace } from './Spotlight';
import type { BoardSubject } from './spotlight-results';

/**
 * Where ⌘K was pressed in the board's window: the board, the session window shown over it, an expanded tile with the
 * focus, by its node id (`agent:<session id>` or `shell:<id>`, as a row's key) and its agent's session or shell's id,
 * or the pop-up, by its agent's session id.
 */
export type BoardContext = { kind: 'board' } | { kind: 'window'; id: string } | { kind: 'expanded'; nodeId: string; id: string } | { kind: 'popup'; id: string };

/**
 * ⌘K on the board: ↵ shows the tile picked and ⇧↵ (or ⌘↵) opens its view; a pull request, page or session opens beside
 * the agent selected as `opensBeside` says.
 */
export const boardPlace = (opensBeside: (surface: Surface) => boolean): SpotlightPlace<BoardContext> => ({ context: { kind: 'board' }, mode: 'show', shiftOpens: true, opensBeside });

/**
 * ⌘K in the pop-up: ↵ opens the agent picked in the pop-up, in its place, and picking its own agent only closes the
 * switcher. It opens nothing beside: a pull request or page opens as from the board.
 */
export const popUpPlace = (id: string): SpotlightPlace<BoardContext> => ({ context: { kind: 'popup', id }, mode: 'switch', current: `agent:${id}`, opensBeside: () => false });

/**
 * The agent a row picked in the pop-up pops up in its place, by its session id. Undefined for what the board opens
 * instead, the pop-up closed: a shell, a zone, an item, a pull request or page, and a row of the Windows group, whose
 * window comes back as it does from the board.
 */
export const popUpPick = (subject: BoardSubject, windowed: boolean): string | undefined =>
  !windowed && subject.kind === 'agent' ? subject.agent.sessionId : undefined;

/**
 * ⌘K in an expanded tile: ↵ shows the tile picked on the board, as on the board itself, and picking the tile's own
 * session only closes the switcher. With nothing to say what opens beside, every pull request, page or session does,
 * in the tile.
 */
export const expandedPlace = (nodeId: string, id: string): SpotlightPlace<BoardContext> => ({ context: { kind: 'expanded', nodeId, id }, mode: 'show', current: nodeId });

/**
 * The session a pull request, page or session picked opens in as a tab: the session window's, or the expanded tile's,
 * so it stays expanded (opened from the board, its agent's own window would open and take the tile off the board).
 * None on the board, nor in the pop-up, whose tabs it can't ask for.
 */
export const tabHostOf = (context: BoardContext): string | undefined => (context.kind === 'board' || context.kind === 'popup' ? undefined : context.id);
