// What a double-click on an agent's or shell tile opens: an agent's pop-up over the board, the default, its session
// window, that window always opened maximised, or the tile expanded in place. Kept in the daemon's view state. Pure, so
// the rules are unit-tested.

import type { WindowPath } from './expanded';

/**
 * What opening a tile in its window (a double-click, Enter, ⌘K ↵, under a window setting) asks for it as: the way the sessions list does, so a
 * tile pinned expanded is brought forward rather than put in its window. Only its header's Maximise opens that.
 */
export const OPEN_TILE_WINDOW_PATH: WindowPath = 'openAgent';

/** The click setting: the pop-up, the session window as it was left, the session window maximised, or the tile expanded in place. */
export type ClickOpens = 'popup' | 'window' | 'maximised' | 'expand';

const CLICK_OPENS: readonly ClickOpens[] = ['popup', 'window', 'maximised', 'expand'];

const isClickOpens = (value: unknown): value is ClickOpens => CLICK_OPENS.includes(value as ClickOpens);

/**
 * The setting before one is saved: the pop-up, unless the window's query names another. Only an unpackaged build's
 * main process puts one there, so the end-to-end specs written for the session window keep it.
 */
export function defaultClickOpens(search: string): ClickOpens {
  const named = new URLSearchParams(search).get('clickOpens');
  return isClickOpens(named) ? named : 'popup';
}

const WINDOW_DEFAULT = defaultClickOpens(typeof location === 'undefined' ? '' : location.search);

/** The click setting as saved (view state, read back untyped): the default unless another was saved. */
export function clickOpensFrom(saved: unknown, fallback: ClickOpens = WINDOW_DEFAULT): ClickOpens {
  return isClickOpens(saved) ? saved : fallback;
}

/**
 * What opening a tile (a double-click, or Enter on it) does, under the setting. The pop-up is an agent's: a shell tile
 * opens its window under it. A tile with no session window (an external session's) always expands.
 */
export function tileOpenAction(setting: ClickOpens, tile: { hasWindow: boolean; agent: boolean }): 'popup' | 'window' | 'expand' {
  if (setting === 'expand' || !tile.hasWindow) return 'expand';
  return setting === 'popup' && tile.agent ? 'popup' : 'window';
}

/** Opens an agent's tile as the setting says: its pop-up, its session window, or expanded in place. */
export function openAgentTile<A>(setting: ClickOpens, actions: { popUp(agent: A): void; openAgent(agent: A): void; expand(nodeId: string): void }, nodeId: string, agent: A): void {
  const opens = tileOpenAction(setting, { hasWindow: true, agent: true });
  if (opens === 'popup') actions.popUp(agent);
  else if (opens === 'window') actions.openAgent(agent);
  else actions.expand(nodeId);
}

/** What an agent tile's tooltip says a double-click does, under the setting. */
export function agentTileTip(setting: ClickOpens): string {
  return setting === 'popup' ? 'Double-click to open it over the board' : setting === 'expand' ? 'Double-click to expand it here' : 'Double-click to open its session window';
}

/**
 * What a ticket tile's Answer does, for the agent `asker` of its ticket that asks: under the pop-up setting, the
 * ticket's pop-up opened on that agent's tab (on its chat, when the chat asks); else the asker's session window.
 */
export function answerTicket<A>(setting: ClickOpens, actions: { popUp(agent: A, path?: undefined, on?: string): void; openAgent(agent: A): void }, chat: A & { sessionId: string }, asker: A & { sessionId: string }): void {
  if (setting !== 'popup') return actions.openAgent(asker);
  if (asker.sessionId === chat.sessionId) actions.popUp(chat);
  else actions.popUp(chat, undefined, asker.sessionId);
}
