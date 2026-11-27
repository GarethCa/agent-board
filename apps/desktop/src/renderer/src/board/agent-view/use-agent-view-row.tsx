import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { OWN_SURFACE } from '@agent-board/daemon/window-layout';
import { VIEW_KEYS } from '../../../../shared/view-saver';
import { useReviews } from '../../review/ReviewsProvider';
import { reviewedOf } from '../../review/reviews';
import { ReviewViewer } from '../../review/ReviewViewer';
import { ActivityLog, useActivity } from '../../orchestrators/ActivityLog';
import type { ShelfViews } from '../../session/AgentShelves';
import type { PaneRow } from '../../session/SessionBody';
import { tabAtDigit } from '../../session/tabs';
import { ACTIVITY_TAB, BOARD_TAB, isViewKey, popUpRow, popUpRowOwner, popUpTabOn, popUpTabShown, popUpViews, REVIEW_TAB, type PopUpRowTab, type PopUpView } from '../agent-popup';
import { afterClose, closedView, keptOrders, movedTab, openedView, popUpRowKey, rowOrder, steppedTab, viewRow, withKeptOrder, type KeptOrders, type RowKey } from '../popup-tab-row';
import { besideCandidates, canDropInSplit, dropAtEdge, dropInSplit, openSplit, selectInSplit, tabOnInSplit, type PopupSplit, type SplitSide } from '../popup-split';
import type { BesideChoice } from '../menu-model';
import type { PopUpMenuHooks } from './AgentViewMenu';
import { viewIcon } from './view-icon';

/**
 * A pop-up's row as its tabs act on it: the agents' and views' tabs from `row`, the shown agent's shell tabs from its
 * body. A shell tab on covers the agent's own pane; a view on covers both. Picking an agent brings its own pane forward.
 */
export function usePaneTabs(row: ReturnType<typeof usePopUpRow>, paneRow: PaneRow | undefined) {
  const shell = row.view === undefined ? paneRow?.active : undefined;
  const isShell = (key: string) => paneRow?.tabs.some((tab) => tab.id === key) === true;
  const select = (key: string) => {
    if (isShell(key)) {
      // Off a view, back to the agent the shell is of, and on to its shell.
      if (row.view !== undefined) row.pick(row.shown.sessionId);
      paneRow?.select(key);
      return;
    }
    // Its own tab again brings its own pane forward; another agent's leaves this one's layout as it was.
    if (key === row.shown.sessionId && row.view === undefined) paneRow?.select(OWN_SURFACE);
    row.pick(key);
  };
  const close = (key: string) => (isShell(key) ? paneRow?.close(key) : row.close(key));
  return { active: row.view ?? shell ?? row.active, agentOn: row.view === undefined && shell === undefined, select, close };
}

/** What the row's keys step along and pick with: the row's own, or a split's while it is open. */
interface RowKeysTarget {
  order: readonly string[];
  active: string;
  pick(key: string): void;
}

/** What a pop-up's body splits by: the split, kept by the pop-up (it sizes the window), and the board's agents. */
export interface PopUpSplitting {
  split: PopupSplit | undefined;
  onSplit(split: PopupSplit | undefined): void;
  /** Every agent on the board: Open beside… offers the zone's. */
  agents: readonly Agent[];
  /** A lone agent's: the sessions popped out into windows of their own, which Open beside… leaves out. */
  popped?: readonly string[] | undefined;
}

/** The split as a body acts on it (`usePopUpSplit`). */
export type PopUpSplitControl = ReturnType<typeof usePopUpSplit>;

/**
 * A body's split: the row's own agent on the left, the one picked beside it on the right, each tab picking into the
 * pane with the focus. An agent from outside the row gets a tab of its own while it is beside. The one beside going (it
 * ended, or popped out) ends the split.
 */
export function usePopUpSplit({ split, onSplit, agents }: PopUpSplitting, row: ReturnType<typeof usePopUpRow>, tabs: ReturnType<typeof usePaneTabs>, popped: readonly string[]) {
  const rowAgents = row.row.flatMap((each) => (each.agent === undefined ? [] : [each.agent]));
  const members = new Set(rowAgents.map((agent) => agent.sessionId));
  const left = row.shown.sessionId;
  const right = split === undefined ? undefined : (rowAgents.find((agent) => agent.sessionId === split.right) ?? agents.find((agent) => agent.sessionId === split.right && agent.endedAt === null));
  const live = right === undefined || right.sessionId === left || popped.includes(right.sessionId) ? undefined : split;
  useEffect(() => {
    if (split !== undefined && live === undefined) onSplit(undefined);
  });
  const beside: BesideChoice[] =
    live !== undefined
      ? []
      : besideCandidates({ shown: row.shown, row: rowAgents, agents, popped }).map((agent) => ({ id: agent.sessionId, label: agent.name, onSelect: () => onSplit(openSplit(left, agent.sessionId)) }));
  const isAgent = (key: string) => members.has(key) || key === live?.right;
  // The row's own pane showing `key`, as a click on its tab would, the focus on it.
  const showLeft = (key: string) => tabs.select(key);
  const select = (key: string) => {
    if (live === undefined) return tabs.select(key);
    const step = selectInSplit(live, left, key, members, isAgent(key));
    onSplit(step.split);
    if (step.split?.focused === 'left') showLeft(step.left ?? key);
  };
  const active = live === undefined ? tabs.active : tabOnInSplit(live, tabs.active);
  const extraKeys = live !== undefined && !members.has(live.right) ? [live.right] : [];
  const { keysRef } = row;
  useLayoutEffect(() => {
    keysRef.current = live === undefined ? undefined : { order: [...row.order, ...extraKeys], active, pick: select };
  });
  // A shell or a view coming on in the left pane (⌘T, the sidebar) while the right has the focus gives the left the focus.
  const leftTabRef = useRef(tabs.active);
  useEffect(() => {
    if (leftTabRef.current === tabs.active) return;
    leftTabRef.current = tabs.active;
    if (live?.focused === 'right' && !isAgent(tabs.active)) onSplit({ ...live, focused: 'left' });
  });
  // The tab being dragged, as `getData` is empty until the drop.
  const draggedRef = useRef<string>(undefined);
  const dropsAgent = (key: string) => isAgent(key) || agents.some((agent) => agent.sessionId === key && agent.endedAt === null);
  const canDrop = (side: SplitSide | 'edge') => {
    const key = draggedRef.current;
    return key !== undefined && canDropInSplit(live, left, side, key, members, dropsAgent(key));
  };
  const drop = (side: SplitSide | 'edge', key: string) => {
    if (!dropsAgent(key)) return;
    if (live === undefined) {
      if (side === 'edge') onSplit(dropAtEdge(left, key));
      return;
    }
    if (side === 'edge') return;
    const step = dropInSplit(live, left, side, key, members);
    onSplit(step.split);
    if (step.left !== undefined) showLeft(step.left);
  };
  const extra: PopUpRowTab[] = live !== undefined && right !== undefined && !members.has(right.sessionId) ? [{ key: right.sessionId, kind: 'agent', agent: right, chat: false }] : [];
  const menuOf = (agent: Agent, hooks: PopUpMenuHooks): PopUpMenuHooks => ({
    ...hooks,
    openBeside: live === undefined && agent.sessionId === left ? beside : undefined,
    openBesideThis: live === undefined ? beside.find((each) => each.id === agent.sessionId)?.onSelect : undefined,
    closeSide: live !== undefined && agent.sessionId === live.right ? () => onSplit(undefined) : undefined,
  });
  return {
    live,
    right: live === undefined ? undefined : right,
    beside,
    select,
    drop,
    extra,
    menuOf,
    /** The tab on: the one in the pane with the focus. */
    active,
    canDrop,
    dragging: (key: string | undefined) => {
      draggedRef.current = key;
    },
    sides: live === undefined ? undefined : { left, right: live.right },
    focus: (side: SplitSide) => {
      if (live !== undefined && live.focused !== side) onSplit({ ...live, focused: side });
    },
    ratio: (ratio: number) => {
      if (live !== undefined) onSplit({ ...live, ratio });
    },
    end: () => onSplit(undefined),
    /** The row's reorder, leaving out the tab of an agent from outside the row: it has no place in the row's order. */
    move:
      (move: (key: string, index: number) => void) =>
      (key: string, index: number): void => {
        if (row.order.includes(key)) move(key, index);
      },
  };
}

/**
 * The views a pop-up has for its agents, `who` (its chat first) and `owner` (whose activity it shows), and how each is
 * drawn: Activity while the agent has an activity log, Review while one of them has a review round, its latest dismissed
 * too (`reviewedOf`: the one `asked` for from its tile first); a ticket's Board comes from `board`.
 */
export function useViewKit(who: readonly Agent[], owner: Agent, asked: string | undefined, board?: (onOpenAgent: (agent: Agent) => void) => ReactNode) {
  const reviewed = reviewedOf(who, useReviews(), asked);
  const activity = useActivity(owner.sessionId);
  const hasActivity = activity.lines.length > 0 || activity.error !== undefined;
  const views = popUpViews({ board: board !== undefined, activity: hasActivity, reviewRound: reviewed?.rounds.at(-1)?.round });
  const render = (key: PopUpView['key'], { onDismissed, onOpenAgent = () => {} }: { onDismissed(): void; onOpenAgent?(agent: Agent): void }): ReactNode =>
    key === BOARD_TAB ? (
      board?.(onOpenAgent)
    ) : key === ACTIVITY_TAB ? (
      <ActivityLog orchestrator={owner} activity={activity} titled={false} />
    ) : reviewed !== undefined ? (
      <ReviewViewer implementer={reviewed.agent} rounds={reviewed.rounds} onDismissed={onDismissed} />
    ) : null;
  return { views, render };
}

/**
 * A pop-up's row: its views open as tabs, then its own agent and its helpers, in the order they were dragged into; which
 * tab is on, the one it came from (⌘[ goes back to it) and the agent shown under a view that is on. A view opens from the
 * sidebar or +, or goes to its tab when it is open already; its × closes it. ⌃Tab and ⌃⇧Tab step along the row, ⌘1–⌘9
 * pick a place in it.
 */
export function usePopUpRow({
  own,
  helpers,
  views,
  popped,
  on,
  openAtFirst,
  ticket,
  onPopped,
  root,
}: {
  own: Agent;
  helpers: readonly Agent[];
  views: readonly PopUpView[];
  popped: readonly string[];
  on: string | undefined;
  openAtFirst: readonly string[];
  ticket: boolean;
  /** Brings forward a helper popped out into a window of its own, never drawn here as well. */
  onPopped(agent: Agent): void;
  root: RefObject<HTMLElement | null>;
}) {
  const [tab, setTab] = useState(on ?? own.sessionId);
  // The agent tab on last: the one shown, out of view, under a view that is on.
  const [agentTab, setAgentTab] = useState(on ?? own.sessionId);
  const [from, setFrom] = useState<string>();
  const [opened, setOpened] = useState<readonly string[]>(openAtFirst);
  const [kept, keep] = useKeptOrders();
  const owner = ticket ? popUpRowOwner(own) : `agent:${own.sessionId}`;
  // Only views it has now: one it no longer has (a review dismissed) leaves the row.
  const openViews = views.filter((view) => opened.includes(view.key));
  const open = openViews.map((view) => view.key);
  const row = rowOrder(popUpRow(own, helpers, openViews, { ticket }), kept[owner]);
  const order = row.map((each) => each.key);
  const showing = popUpTabOn(tab, agentTab, own, helpers, popped, open);
  const view = typeof showing === 'string' ? showing : undefined;
  const shown = typeof showing === 'string' ? popUpTabShown(agentTab, own, helpers, popped) : showing;
  const active = view ?? shown.sessionId;
  const pick = (key: string) => {
    const helper = helpers.find((each) => each.sessionId === key);
    if (helper !== undefined && popped.includes(helper.sessionId)) return onPopped(helper);
    if (key === active) return;
    const isView = views.some((each) => each.key === key);
    if (isView) setOpened((before) => openedView(before, key));
    else setAgentTab(key);
    setFrom(active);
    setTab(key);
  };
  const back = () => pick(from !== undefined && order.includes(from) && from !== active ? from : own.sessionId);
  // Closing the tab that is on goes back to the one it came from, or its own; that one is on now, so nothing is
  // underlined, and a closed tab is never the one ⌘[ goes back to.
  const close = (key: string) => {
    if (key === active) {
      const to = afterClose(key, { active, from, order, under: shown.sessionId });
      setTab(to);
      if (!isViewKey(to)) setAgentTab(to);
    }
    if (key === active || key === from) setFrom(undefined);
    setOpened((before) => closedView(before, key));
  };
  // A split routes the keys as it routes a click (`usePopUpSplit`): its row, its tab on and its pick, while it is open.
  const keysRef = useRef<RowKeysTarget>(undefined);
  useRowKeys(root, (press) => {
    const keys = keysRef.current ?? { order, active, pick };
    // One agent alone, with no row, leaves its keys to its terminal.
    if (keys.order.length < 2) return false;
    if (press.kind === 'back') return from !== undefined && keys.order.includes(from) && from !== keys.active ? (keys.pick(from), true) : false;
    const to = press.kind === 'step' ? steppedTab(keys.order, keys.active, press.step, new Set(popped)) : tabAtDigit(keys.order, press.digit);
    if (to !== undefined) keys.pick(to);
    return to !== undefined;
  });
  const shelfViews: ShelfViews = {
    views: views.map((each) => ({ key: each.key, label: each.label, icon: viewIcon(each.key), state: viewRow(each.key, open, active) })),
    onOpen: pick,
  };
  // A tile's Open review: its Review view as a tab, or on to its tab when it is open already.
  const openReview = () => {
    if (views.some((each) => each.key === REVIEW_TAB)) pick(REVIEW_TAB);
  };
  return { row, order, open, view, shown, active, from, pick, back, close, openReview, move: (key: string, index: number) => keep(owner, movedTab(order, key, index)), shelfViews, keysRef };
}

/**
 * Each pop-up row's kept order, read from the view state as it opens and saved there as a tab is dragged. A save reads
 * what is saved first and adds to it, one after another, so a drag before the load (or after it failed) keeps the
 * other owners' orders; when the read fails, nothing is written.
 */
function useKeptOrders(): [KeptOrders, (owner: string, order: readonly string[]) => void] {
  const [orders, setOrders] = useState<KeptOrders>({});
  const saving = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    window.agentBoard.view.get(VIEW_KEYS.popUpTabOrder).then(
      // A drag made before the saved orders came in stays over theirs.
      (saved) => setOrders((dragged) => ({ ...keptOrders(saved), ...dragged })),
      () => {},
    );
  }, []);
  const keep = (owner: string, order: readonly string[]) => {
    setOrders((before) => withKeptOrder(before, owner, order));
    saving.current = saving.current
      .then(() => window.agentBoard.view.get(VIEW_KEYS.popUpTabOrder))
      .then((saved) => window.agentBoard.view.set(VIEW_KEYS.popUpTabOrder, withKeptOrder(keptOrders(saved), owner, order)))
      .then(
        () => {},
        () => {},
      );
  };
  return [orders, keep];
}

/**
 * The row's keys, wherever the focus is in the pop-up, its terminal too: caught on the window on the way in, as React's
 * own capture handlers (its panes', whose ⌘1–9 pick a shell tab) sit on the page's root, above the pop-up, and would
 * have them first. `run` says whether the row took the press.
 */
function useRowKeys(root: RefObject<HTMLElement | null>, run: (press: RowKey) => boolean): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.target instanceof Node) || root.current?.contains(event.target) !== true) return;
      const press = popUpRowKey(event);
      if (press === undefined || !latest.current(press)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [root]);
}
