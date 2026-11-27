import { useContext } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { MoreHorizontal } from 'lucide-react';
import { useGateRuns } from '../../gate/GatesProvider';
import { useReviews } from '../../review/ReviewsProvider';
import { roundsOf } from '../../review/reviews';
import { ContextMenu, IconButton, Menu, type MenuEntry } from '../../ui';
import { agentMenu, popUpAgentMenu, pullRequestEntries, withoutRows, type BesideChoice, type ModelEntry } from '../menu-model';
import { useTicketChatMenu } from '../use-ticket-chat-menu';
import { ClickOpensContext, TileActionsContext } from '../tile';

/**
 * The agent menu's rows its pop-up has of its own: Open is the pop-up itself, Expand and Pop out are in its header, and
 * its name renames on a double-click or its pencil.
 */
const POPUP_OWN = new Set(['open', 'expand', 'pop-out', 'rename']);

/** What an agent's menu in its pop-up does that only the pop-up can: open its name field, split beside it, end the split. */
export interface PopUpMenuHooks {
  rename(): void;
  /** The agents to open beside it: undefined for an agent not shown, or while split. */
  openBeside: readonly BesideChoice[] | undefined;
  /** Opens this agent beside the one shown, on another agent's menu; undefined where it can't. */
  openBesideThis?: (() => void) | undefined;
  /** Ends the split, on its right side's menu. */
  closeSide?: (() => void) | undefined;
  /** The rows of the menu, by id, left out: none, unless the pop-up is in a window of its own. */
  drops?: readonly string[] | undefined;
}

/** A menu with nothing of the pop-up's own to do: a gallery's. */
export const NO_MENU_HOOKS = (): PopUpMenuHooks => ({ rename: () => {}, openBeside: undefined });

/** A lone agent's header ⋯: its pull requests with their checks, then the same menu as an agent tab's ⋯. */
export function AgentViewMenu({ agent, nodeId, menu, end = [] }: { agent: Agent; nodeId: string; menu: PopUpMenuHooks; end?: MenuEntry[] | undefined }) {
  const actions = useContext(TileActionsContext);
  const prs = pullRequestEntries(agent, actions);
  const entries = [...prs, ...(prs.length > 0 ? ['separator' as const] : []), ...usePopUpAgentEntries(agent, nodeId, menu), ...(end.length > 0 ? ['separator' as const, ...end] : [])];
  return (
    <Menu align="end" entries={entries}>
      <IconButton icon={<MoreHorizontal />} size="sm" aria-label="More" tooltip="More: Pause, Run gate, Rename, Stop session, Delete…" />
    </Menu>
  );
}

/** ⋯ on the agent's tab that is on: its menu, the same as a right-click on its tab. */
export function TabMoreMenu({ agent, nodeId, menu }: { agent: Agent; nodeId: string; menu: PopUpMenuHooks }) {
  return (
    <Menu align="start" entries={usePopUpAgentEntries(agent, nodeId, menu)}>
      <IconButton className="agent-popup-tab-more" data-testid="agent-popup-tab-more" icon={<MoreHorizontal />} size="xs" variant="ghost" aria-label={`More for ${agent.name}`} tooltip="Pause, Run gate, Rename, Stop session, Delete…" />
    </Menu>
  );
}

/** The menu a right-click on an agent's tab opens, at the pointer. */
export function TabContextMenu({ agent, nodeId, menu, at, onClose }: { agent: Agent; nodeId: string; menu: PopUpMenuHooks; at: { x: number; y: number }; onClose(): void }) {
  return <ContextMenu at={at} entries={usePopUpAgentEntries(agent, nodeId, menu)} label={`${agent.name}'s menu`} onClose={onClose} />;
}

/** An agent's menu in its pop-up (`popUpAgentMenu`), wired to the board's actions and the pop-up's own. */
function usePopUpAgentEntries(agent: Agent, nodeId: string, { rename, openBeside, openBesideThis, closeSide, drops }: PopUpMenuHooks): ModelEntry[] {
  const actions = useContext(TileActionsContext);
  const clickOpens = useContext(ClickOpensContext);
  const rounds = roundsOf(useReviews(), agent.sessionId);
  const gate = useGateRuns().get(agent.sessionId);
  const entries = popUpAgentMenu({ nodeId, agent, clickOpens, gate, rounds, rename, actions, openBeside, openBesideThis, closeSide });
  return drops === undefined ? entries : withoutRows(entries, drops);
}

/** The agent's menu (Pause, Run gate, Delete…), less the rows its pop-up has of its own. */
function usePopupAgentMenu(agent: Agent, nodeId: string): ModelEntry[] {
  const actions = useContext(TileActionsContext);
  const clickOpens = useContext(ClickOpensContext);
  const rounds = roundsOf(useReviews(), agent.sessionId);
  const gate = useGateRuns().get(agent.sessionId);
  return agentMenu({ nodeId, agent, clickOpens, gate, rounds, rename: () => {}, actions }).filter(
    (entry: ModelEntry) => entry === 'separator' || !('id' in entry) || !POPUP_OWN.has(entry.id),
  );
}

/** ⋯ of a ticket's pop-up: the ticket's rows (its board, Watches…, its pull request and checks, its chat's kind), then its chat's own, then Close ticket…. */
export function TicketMoreMenu({
  chat,
  helpers,
  nodeId,
  name,
  drops,
  end = [],
}: {
  chat: Agent;
  helpers: readonly Agent[];
  nodeId: string;
  name: string;
  /** As `PopUpMenuHooks`' `drops`. */
  drops?: readonly string[] | undefined;
  /** Rows after the rest, a popped-out window's own. */
  end?: MenuEntry[] | undefined;
}) {
  const own = usePopupAgentMenu(chat, nodeId);
  const ticket = useTicketChatMenu(chat, helpers, [], own, name);
  const entries = [...(drops === undefined ? ticket.entries : withoutRows(ticket.entries, drops)), ...(end.length > 0 ? ['separator' as const, ...end] : [])];
  const { watches } = ticket;
  return (
    <>
      <Menu align="end" entries={entries}>
        <IconButton icon={<MoreHorizontal />} size="sm" aria-label="More" tooltip="More: its pull request, Watches, Run gate, Close ticket…" />
      </Menu>
      {watches}
    </>
  );
}
