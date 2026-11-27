import { useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, humanStatus } from '@agent-board/daemon/human-status';
import { lookShown } from '@agent-board/daemon/character';
import { ChevronDown, MessageSquare, SquareTerminal } from 'lucide-react';
import type { PaneRow } from '../../session/SessionBody';
import { ROW_TAB_TYPE, TabStrip, type StripTab } from '../../session/TabStrip';
import { useNeedsYouShows } from '../../needs-you-setting';
import { agentPill } from '../../states';
import { EditableName, Menu, useRenaming, type MenuEntry } from '../../ui';
import { BOARD_TAB, type PopUpRowTab, type PopUpView } from '../agent-popup';
import { foldRow, shellDragOf } from '../popup-tab-row';
import { useCharacterStyle } from '../characters';
import { useNowForSince } from '../../inbox/use-now';
import { HarnessMark } from '../HarnessMark';
import type { BesideChoice } from '../menu-model';
import { nameTarget } from '../rename';
import { poseOfPill } from '../tile-pose';
import { sinceLabel } from '../tile-shows';
import { TileCharacter } from '../TileCharacter';
import { TileActionsContext } from '../tile';
import { PopupPlus } from './AgentViewHeader';
import { type PopUpMenuHooks, NO_MENU_HOOKS, TabMoreMenu, TabContextMenu } from './AgentViewMenu';
import { viewIcon } from './view-icon';

/** The height of an agent's character on its tab, in px. */
const TAB_CHARACTER_HEIGHT = 18;

export const PANEL_ID = 'agent-popup-panel';

/** How wide "+n ▾" is taken to be, in px, before it has been drawn to measure. */
const MORE_GUESS = 56;

/** How wide a tab is taken to be, in px, before it has been drawn to measure. */
const TAB_GUESS = 140;

/** The room a tab's ⋯ or × takes, kept on each tab that isn't on, so the row holds still as the tab that is on moves. */
const TabEndSlot = () => <span className="agent-popup-tab-end-slot" aria-hidden />;

/**
 * The row of tabs: the Board, then each agent with its character, its name, "chat" on the chat's, and its status dot,
 * whose tooltip says since when, then the shown agent's shells. The tab that is on ends in ⋯ (its agent's menu, which a
 * right-click on any agent's tab opens too) or, on a view or a shell, ×. The views and agents drag along it into any
 * order. What doesn't fit folds into "+n ▾", from the right, but never the tab that is on nor one that asks; + ends the
 * row: a new shell, the views to open, and Open beside….
 */
export function AgentViewTabs({
  row,
  shells = [],
  active,
  from,
  nodeId,
  views,
  open,
  ownLabel,
  paneRow,
  menuOf = NO_MENU_HOOKS,
  sides,
  beside = [],
  renaming,
  onRenamed,
  onDragKey,
  label,
  onSelect,
  onClose,
  onMove,
  onOpenWindow,
  panelId = PANEL_ID,
  dragShells = false,
}: {
  /** Whether its shell tabs drag out of the row, onto the board, a tile or another window: an expanded tile's do. */
  dragShells?: boolean;
  row: readonly PopUpRowTab[];
  /** The id of the panel its tabs control: one per expanded tile, as several can be on the board at once. */
  panelId?: string;
  /** The shown agent's shell tabs (and what else its body opened), after the agents. */
  shells?: readonly StripTab[];
  /** What its shells do: undefined until its body has drawn, and in a gallery. */
  paneRow?: PaneRow | undefined;
  /** What an agent's menu does that only the pop-up can. */
  menuOf?(agent: Agent): PopUpMenuHooks;
  /** Split, the agents on each side: both their tabs are on, with a "left" and a "right" pill. */
  sides?: { left: string; right: string } | undefined;
  /** The agents its + offers to open beside the one shown. */
  beside?: readonly BesideChoice[];
  /** The agent whose tab is renamed in place, if one is. */
  renaming?: string | undefined;
  onRenamed?(): void;
  /** The tab being dragged in the row, as the drag starts, then none as it ends: the body takes it to show where it drops. */
  onDragKey?(key: string | undefined): void;
  active: string;
  from: string | undefined;
  nodeId: string;
  /** The views it has, which + offers: opening one, or going to its tab when it is open (`open`). */
  views: readonly PopUpView[];
  open: readonly string[];
  /** What one agent alone calls its own tab ("Chat" or "Terminal"), with no ⋯ of its own: its header's is the same menu. */
  ownLabel?: string | undefined;
  /** What the row is, as a screen reader says it. */
  label: string;
  onSelect(key: string): void;
  onClose(key: string): void;
  /** Moves a tab to `index` in the whole row, as the strip counts it. */
  onMove(key: string, index: number): void;
  onOpenWindow(agent: Agent): void;
}) {
  const shows = useNeedsYouShows();
  const style = useCharacterStyle();
  const tabs: StripTab[] = row.map(({ key, agent, view, chat: isChat }) => {
    if (agent === undefined)
      return {
        id: key,
        label: view?.label ?? key,
        icon: viewIcon(view?.key ?? BOARD_TAB),
        closable: key === active,
        closeHint: `Close ${view?.label ?? key}`,
        // Its slot exactly while no × is drawn.
        ...(key === active ? {} : { mark: <TabEndSlot /> }),
      };
    // One agent alone has one agent tab: its own, named for its view.
    if (ownLabel !== undefined)
      return { id: key, label: ownLabel, icon: ownLabel === 'Chat' ? <MessageSquare /> : <SquareTerminal />, title: agent.name, closable: false, closeHint: '' };
    const status = humanStatus(agent, shows).status;
    const side = sides?.left === key ? 'left' : sides?.right === key ? 'right' : undefined;
    return {
      id: key,
      label: agent.name,
      beside: side !== undefined,
      closable: false,
      closeHint: '',
      lead:
        style === 'off' ? (
          <HarnessMark harness={agent.harness} />
        ) : (
          <TileCharacter harness={agent.harness} {...lookShown(poseOfPill(agentPill(agent, shows).state), agent)} style={style} height={TAB_CHARACTER_HEIGHT} />
        ),
      ...(side !== undefined ? { pill: side } : isChat ? { pill: 'chat' } : {}),
      mark: (
        <>
          <TabDot status={status} since={agent.stateSince} />
          {key === active || side !== undefined ? <TabMoreMenu agent={agent} nodeId={nodeId} menu={menuOf(agent)} /> : <TabEndSlot />}
        </>
      ),
      ask: status === 'needs-you',
      ...(renaming === agent.sessionId ? { editing: <TabRename agent={agent} onDone={() => onRenamed?.()} /> } : {}),
    };
  });
  // The shells: "Shell" with a terminal icon in words under one agent alone, × on the one on.
  for (const shell of shells)
    tabs.push({
      ...shell,
      ...(ownLabel !== undefined && shells.length === 1 ? { label: 'Shell', title: shell.title ?? shell.label } : {}),
      icon: shell.icon ?? <SquareTerminal />,
      closable: shell.id === active && shell.closable,
      // Its slot exactly while no × is drawn, so one that can't be closed keeps its width too.
      ...(shell.id === active && shell.closable ? {} : { mark: <TabEndSlot /> }),
    });
  const [context, setContext] = useState<{ agent: Agent; at: { x: number; y: number } }>();
  const box = useRef<HTMLDivElement>(null);
  const folded = useFold(box, tabs, active);
  const showing = tabs.filter((tab) => !folded.includes(tab.id));
  const order = tabs.map((tab) => tab.id);
  // A drop among the tabs showing, at the place of the tab there in the whole row, or after the last one showing.
  const placeOf = (index: number) => {
    const at = showing[index];
    return at !== undefined ? order.indexOf(at.id) : order.indexOf(showing.at(-1)!.id) + 1;
  };
  const agentOf = (key: string) => row.find((each) => each.key === key)?.agent;
  const more: MenuEntry[] = tabs
    .filter((tab) => folded.includes(tab.id))
    .map((tab) => ({ label: tab.label, onSelect: () => onSelect(tab.id) }));
  const rowKeys = new Set(row.map((each) => each.key));
  return (
    <div
      ref={box}
      className="agent-popup-tabs"
      data-testid="agent-popup-tabs"
      data-split={sides !== undefined || undefined}
      onDragStart={(event) => onDragKey?.(event.dataTransfer.getData(ROW_TAB_TYPE) || undefined)}
      onDragEnd={() => onDragKey?.(undefined)}
    >
      <TabStrip
        tabs={showing}
        active={active}
        from={from}
        label={label}
        onSelect={onSelect}
        onAltSelect={(key) => {
          const agent = agentOf(key);
          if (agent !== undefined) onOpenWindow(agent);
        }}
        onClose={onClose}
        panelId={() => panelId}
        dragOf={shellDragOf(
          dragShells,
          shells.map((shell) => shell.id),
          paneRow?.dragOf,
        )}
        // Shells stay after the agents: only the views and agents move.
        reorder={(key, index) => rowKeys.has(key) && onMove(key, Math.min(placeOf(index), row.length))}
        onContextMenu={(key, at) => {
          const agent = agentOf(key);
          if (agent === undefined) return false;
          setContext({ agent, at });
          return true;
        }}
        trailing={
          <span className="agent-popup-row-end">
            {more.length > 0 && (
              <Menu align="end" entries={more}>
                <button type="button" className="agent-popup-more" data-testid="agent-popup-more" title="The tabs that don't fit">
                  +{more.length}
                  <ChevronDown aria-hidden />
                </button>
              </Menu>
            )}
            <PopupPlus paneRow={paneRow} views={views} open={open} beside={beside} onSelect={onSelect} />
          </span>
        }
      />
      {context !== undefined && <TabContextMenu agent={context.agent} nodeId={nodeId} menu={menuOf(context.agent)} at={context.at} onClose={() => setContext(undefined)} />}
    </div>
  );
}

/**
 * Which of the row's tabs fold into "+n ▾": each tab measured as drawn (a folded one keeps the width it had), against
 * the room the row has beside its end, measured again as the pop-up is resized.
 */
function useFold(row: RefObject<HTMLElement | null>, tabs: readonly StripTab[], active: string): string[] {
  const [folded, setFolded] = useState<string[]>([]);
  const widths = useRef(new Map<string, number>());
  const [, remeasure] = useState(0);
  useEffect(() => {
    const box = row.current;
    if (box === null) return;
    const observer = new ResizeObserver(() => remeasure((n) => n + 1));
    observer.observe(box);
    return () => observer.disconnect();
  }, [row]);
  useLayoutEffect(() => {
    const box = row.current;
    if (box === null) return;
    // Each container's own gap: between the tabs (a tab counts the one after it, the last one's spare), between the
    // tabs and the row's end, and between "+n" and +.
    const gapOf = (selector: string) => {
      const element = box.querySelector(selector);
      return element === null ? 0 : parseFloat(getComputedStyle(element).columnGap) || 0;
    };
    const tabGap = gapOf('.session-tabs-list');
    for (const tab of box.querySelectorAll<HTMLElement>('[data-testid="session-tab"]')) widths.current.set(tab.dataset.tab ?? '', tab.getBoundingClientRect().width + tabGap);
    const plus = box.querySelector('.agent-popup-plus')?.getBoundingClientRect().width ?? 0;
    const more = box.querySelector('.agent-popup-more')?.getBoundingClientRect().width ?? MORE_GUESS;
    const inner = box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight);
    const keep = new Set([active, ...tabs.filter((tab) => tab.ask).map((tab) => tab.id)]);
    const next = foldRow(
      tabs.map((tab) => ({ key: tab.id, width: widths.current.get(tab.id) ?? TAB_GUESS })),
      { room: inner - plus - gapOf('.session-tabs'), more: more + gapOf('.agent-popup-row-end'), keep },
    ).folded;
    if (next.join('\n') !== folded.join('\n')) setFolded(next);
  });
  return folded;
}

/** A tab's status dot; its tooltip says since when, kept current as the time goes by. */
function TabDot({ status, since }: { status: keyof typeof HUMAN_STATUS_LABELS; since: string }) {
  const now = useNowForSince(since);
  return <span className="agent-popup-tab-dot" data-testid="agent-popup-tab-dot" data-status={status} title={`${HUMAN_STATUS_LABELS[status]} ${sinceLabel(since, now)}`} />;
}

/** An agent's name, in place of its tab's label while it is renamed from its menu; `onDone` once the field closes. */
function TabRename({ agent, onDone }: { agent: Agent; onDone(): void }) {
  const { rename } = useContext(TileActionsContext);
  const target = nameTarget({ agent });
  const renaming = useRenaming(agent.name, async (next) => {
    if (target !== undefined) await rename(target, next);
  });
  const opened = useRef(false);
  useEffect(() => {
    if (renaming.editing) opened.current = true;
    else if (opened.current) onDone();
    else renaming.startSoon();
    // Only the field opening and closing matters.
  }, [renaming.editing]);
  return <EditableName className="agent-popup-tab-rename" value={agent.name} renaming={renaming} label="Agent name" />;
}
