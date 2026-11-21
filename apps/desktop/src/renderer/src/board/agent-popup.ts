// The rules for an agent's pop-up over the board (AgentPopup.tsx): what opening it does with the agent's session window,
// and when it shows. Pure, so they are unit-tested.
import type { Agent } from '@agent-board/daemon/protocol';
import type { SessionWindows } from '../windows/session-windows';
import type { RowTab } from './popup-tab-row';
import { drawnIn, drawsAsTicket, heldInCard, tileNodeId } from './tiles';
import { popUpViewKey } from '../session/session-view';

/**
 * What popping the agent up does first: an agent popped out into a window of its own is only brought forward there,
 * and its window shown on the board goes to the dock, as the pop-up takes its place.
 */
export function popUpOpening(windows: SessionWindows, sessionId: string): 'open' | 'minimise' | 'forward' {
  const entry = windows.find((each) => each.id === sessionId);
  return entry?.placement === 'popped' ? 'forward' : entry?.placement === 'shown' ? 'minimise' : 'open';
}

/**
 * The agent whose pop-up shows: the one popped up, while it is listed, no session window is shown on the board (one
 * opened from somewhere else, a notification or ⌘K, takes its place) and its tile is not expanded on the board, so its
 * session is never drawn twice. A tile pinned expanded is taken off the board while its pop-up is up, as for its
 * session window, and given back, pinned, once it closes; until then the pop-up waits (`popUpEnded`).
 */
export function popUpShown(popUpId: string | undefined, agents: readonly Agent[], windows: SessionWindows, expanded: readonly { id: string }[]): Agent | undefined {
  if (popUpId === undefined || windows.some((each) => each.placement === 'shown')) return undefined;
  const nodeId = tileNodeId('agent', popUpId);
  if (expanded.some((tile) => tile.id === nodeId)) return undefined;
  return agents.find((agent) => agent.sessionId === popUpId);
}

/**
 * Whether the pop-up is over rather than waiting to show: its agent gone, a session window shown on the board in its
 * place, or its tile expanded on the board. A tile pinned expanded doesn't end it: the board takes that tile off while
 * the pop-up is up, and the pop-up shows once it has.
 */
export function popUpEnded(popUpId: string, agents: readonly Agent[], windows: SessionWindows, expanded: readonly { id: string }[], pinned: ReadonlySet<string>): boolean {
  const nodeId = tileNodeId('agent', popUpId);
  if (!agents.some((agent) => agent.sessionId === popUpId) || windows.some((each) => each.placement === 'shown')) return true;
  return expanded.some((tile) => tile.id === nodeId) && !pinned.has(nodeId);
}

/**
 * Whether an Esc closes the pop-up from behind it, with the focus on the board: unless typing, as the pop-up is in front
 * of the whole board. Inside it, its own leave keys have the Esc (from its header; its terminal keeps its own).
 */
export function escClosesFromBehind(press: { escape: boolean; typing: boolean; inPopUp: boolean }): boolean {
  return press.escape && !press.typing && !press.inPopUp;
}

/**
 * A ticket's helpers its pop-up has a tab for: the ones its ticket's tile holds (`heldInCard`), in the order given; none
 * for an agent that is no ticket's chat, or one that draws as an agent for now, whose helpers have tiles of their own.
 */
export function popUpHelpers(agent: Agent, agents: readonly Agent[]): Agent[] | undefined {
  if (!agent.ticketChat || !drawsAsTicket(agent)) return undefined;
  return agents.filter((each) => each.ticket === agent.sessionId && heldInCard(each, agents));
}

/**
 * Where an agent's pop-up keeps its one Chat | Terminal pick (`popUpViewKey`): its ticket's, for a ticket's chat and the
 * helpers its pop-up has a tab for; its own session's for any other agent.
 */
export function viewKeyOf(agent: Agent, agents: readonly Agent[]): string {
  const chat = agent.ticketChat ? agent : agents.find((each) => each.sessionId === agent.ticket);
  const helpers = chat === undefined ? undefined : popUpHelpers(chat, agents);
  if (chat === undefined || helpers === undefined) return agent.sessionId;
  return chat === agent || helpers.some((each) => each.sessionId === agent.sessionId) ? popUpViewKey(chat, true) : agent.sessionId;
}

/** The key of a ticket's pop-up's Board tab, its overview, in its row and its kept order. */
export const BOARD_TAB = 'board';
/** The key of a pop-up's Activity tab: what an orchestrating agent did. */
export const ACTIVITY_TAB = 'activity';
/** The key of a pop-up's Review tab: the latest round of the review of its work. */
export const REVIEW_TAB = 'review';

/** A view a pop-up can open as a tab, from its sidebar: its key and its name. */
export interface PopUpView {
  key: typeof BOARD_TAB | typeof ACTIVITY_TAB | typeof REVIEW_TAB;
  label: string;
}

/**
 * The views a pop-up's sidebar lists, in their order: a ticket's Board first, its overview; Activity for an agent with
 * an activity log; then "Review · round n" once a review of its work has begun.
 */
export function popUpViews({ board, activity, reviewRound }: { board: boolean; activity: boolean; reviewRound: number | undefined }): PopUpView[] {
  return [
    ...(board ? [{ key: BOARD_TAB, label: 'Board' } as const] : []),
    ...(activity ? [{ key: ACTIVITY_TAB, label: 'Activity' } as const] : []),
    ...(reviewRound === undefined ? [] : [{ key: REVIEW_TAB, label: `Review · round ${reviewRound}` } as const]),
  ];
}

/** The views open as a pop-up opens: its overview, a ticket's Board; the others open from the sidebar. */
export const viewsOpenAtFirst = (views: readonly PopUpView[]): string[] => views.filter((view) => view.key === BOARD_TAB).map((view) => view.key);

/** One tab of a pop-up: a view, or an agent and whether it is a ticket's chat. */
export interface PopUpRowTab extends RowTab {
  agent?: Agent;
  view?: PopUpView;
  chat: boolean;
}

/**
 * A pop-up's row of tabs, before any is dragged: the views open (`views`), then its own agent (a ticket's chat, or one
 * agent alone, with `ticket` false), then each helper.
 */
export function popUpRow(own: Agent, helpers: readonly Agent[], views: readonly PopUpView[], { ticket = true }: { ticket?: boolean } = {}): PopUpRowTab[] {
  return [
    ...views.map((view) => ({ key: view.key, kind: 'view' as const, view, chat: false })),
    { key: own.sessionId, kind: 'agent', agent: own, chat: ticket },
    ...helpers.map((agent) => ({ key: agent.sessionId, kind: 'agent' as const, agent, chat: false })),
  ];
}

/** Whose kept order a ticket's pop-up's row is: its chat's. */
export const popUpRowOwner = (chat: Agent) => `ticket:${chat.sessionId}`;

// A Record, so a new view's key can't be left out.
const VIEW_KEY: Record<PopUpView['key'], true> = { [BOARD_TAB]: true, [ACTIVITY_TAB]: true, [REVIEW_TAB]: true };
const VIEW_KEYS_ALL: readonly string[] = Object.keys(VIEW_KEY);

/** Whether a tab's key names a view rather than an agent. */
export const isViewKey = (key: string | undefined): key is PopUpView['key'] => key !== undefined && VIEW_KEYS_ALL.includes(key);

/**
 * What a pop-up shows for the tab `tab` names: a view while its tab is open (`open`); else the agent `popUpTabShown`
 * gives for it, or, for a view no longer open (a review dismissed elsewhere), for `under`, the agent shown under it.
 */
export function popUpTabOn(tab: string | undefined, under: string | undefined, chat: Agent, helpers: readonly Agent[], popped: readonly string[], open: readonly PopUpView['key'][]): PopUpView['key'] | Agent {
  if (!isViewKey(tab)) return popUpTabShown(tab, chat, helpers, popped);
  return open.includes(tab) ? tab : popUpTabShown(under, chat, helpers, popped);
}

/**
 * The agent a ticket's pop-up shows: the helper `on` names (picked on its tab, or the one Answer opened it on) while the
 * ticket still holds it and it is not popped out into a window of its own (`popped`), so its session is never drawn
 * twice; else its chat, which it always opens on.
 */
export function popUpTabShown(on: string | undefined, chat: Agent, helpers: readonly Agent[], popped: readonly string[] = []): Agent {
  return helpers.find((helper) => helper.sessionId === on && !popped.includes(on)) ?? chat;
}

/**
 * Which agent's pop-up opens for `agent`, and on which tab: a helper its ticket's tile holds opens its ticket's, on its
 * own tab; any other agent its own, on the tab `on` names (a ticket's helper, as Answer does) or its chat's.
 */
export function popUpTarget(agent: Agent, on: string | undefined, agents: readonly Agent[]): { agent: Agent; on?: string } | undefined {
  const chatId = drawnIn(agents, agent.sessionId);
  if (chatId === agent.sessionId) return on === undefined ? { agent } : { agent, on };
  const chat = agents.find((known) => known.sessionId === chatId);
  return chat === undefined ? undefined : { agent: chat, on: agent.sessionId };
}

/** What popping an agent up does: bring a window of its own forward, or pop up its ticket's (or its own) on a tab. */
export type PopUpPlan = { kind: 'forward'; agent: Agent } | { kind: 'pop-up'; chat: Agent; on?: string; minimise: string[] };

/**
 * What popping `agent` up does, on the tab `on` names: the agent its tab shows, popped out into a window of its own, is
 * brought forward there instead, as is its ticket's chat; else the pop-up opens, the windows shown on the board of those
 * it draws going to the dock.
 */
export function popUpPlan(agent: Agent, on: string | undefined, agents: readonly Agent[], windows: SessionWindows): PopUpPlan | undefined {
  const target = popUpTarget(agent, on, agents);
  if (target === undefined) return undefined;
  const helper = target.on === undefined ? undefined : agents.find((known) => known.sessionId === target.on);
  if (helper !== undefined && popUpOpening(windows, helper.sessionId) === 'forward') return { kind: 'forward', agent: helper };
  if (popUpOpening(windows, target.agent.sessionId) === 'forward') return { kind: 'forward', agent: target.agent };
  const drawn = [target.agent, ...(helper === undefined ? [] : [helper])];
  const minimise = drawn.filter((each) => popUpOpening(windows, each.sessionId) === 'minimise').map((each) => each.sessionId);
  return { kind: 'pop-up', chat: target.agent, ...(target.on === undefined ? {} : { on: target.on }), minimise };
}

/** The ones of `agents` popped out into a window of their own. */
export function poppedOutOf(agents: readonly Agent[], windows: SessionWindows): string[] {
  return agents.filter((each) => popUpOpening(windows, each.sessionId) === 'forward').map((each) => each.sessionId);
}

/**
 * The node ids of the tiles whose session is in a window of `windows`, or in the pop-up of the agent `poppedUp`: none of
 * them is also expanded on the board, and each expanded one, pinned too, is given back once that window or pop-up closes.
 */
export function windowedTiles(windows: SessionWindows, poppedUp: string | undefined): string[] {
  const ids = windows.map((entry) => tileNodeId(entry.kind === 'shell' ? 'shell' : 'agent', entry.id));
  return poppedUp === undefined ? ids : [...ids, tileNodeId('agent', poppedUp)];
}
