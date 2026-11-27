import { createContext, useContext, type ReactNode } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { humanStatus } from '@agent-board/daemon/human-status';
import { Columns2, MessageSquare, Plus, SquareTerminal, Ticket, UnfoldHorizontal } from 'lucide-react';
import { keyText } from '../../keys/registry';
import type { PaneRow } from '../../session/SessionBody';
import { useSessionView, type SessionView } from '../../session/session-view';
import { SessionName } from '../../session/SessionName';
import { useAddEntries, type TabAdds } from '../../session/TabStrip';
import { useSimplified } from '../../design';
import { useNeedsYouShows } from '../../needs-you-setting';
import { agentPill } from '../../states';
import { IconButton, Kbd, Menu, Segmented, StatusPill, type MenuEntry, type SegmentedOption } from '../../ui';
import type { PopUpView } from '../agent-popup';
import { setPopupFill, usePopupFill } from '../popup-fill';
import { POPUP_CAP } from '../popup-size';
import type { PopupSplit } from '../popup-split';
import { HarnessMark } from '../HarnessMark';
import type { BesideChoice } from '../menu-model';
import { StatusMark } from '../StatusMark';
import type { AgentViewTile } from './AgentView';
import { viewIcon } from './view-icon';

/** The pop-up's switch's two views, the chat first. */
const POP_UP_VIEWS: SegmentedOption<SessionView>[] = [
  { id: 'chat', label: 'Chat', icon: <MessageSquare /> },
  { id: 'terminal', label: 'Terminal', icon: <SquareTerminal /> },
];

/**
 * The header's one Chat | Terminal switch, for every agent in the pop-up (a shell ignores it), kept for the pop-up the
 * next time it opens. Dimmed while a view or a shell tab is on, which it doesn't change.
 */
export function PopupViewSwitch({ viewKey, agentOn }: { viewKey: string; agentOn: boolean }) {
  const [view, pick] = useSessionView(viewKey);
  return (
    <span className="agent-popup-switch-group">
      <span className="agent-popup-switch" data-testid="agent-popup-switch" data-dimmed={!agentOn || undefined} title={agentOn ? 'Every agent in this pop-up' : 'Applies when an agent tab is on'}>
        <Segmented<SessionView> aria-label="View of every agent in this pop-up" value={view} onChange={pick} options={POP_UP_VIEWS} />
      </span>
      <FillButton />
    </span>
  );
}

/** Whether the board is wide enough for the cap to bite, and so for the fill button to show. */
export const PopupWideContext = createContext(false);

/**
 * The header's fill button, beside the Chat | Terminal switch, on a wide screen only: pressed, every pop-up fills the
 * board; not, it stops at the cap's width. It flips the Settings option, so the next pop-up opens the same way.
 */
function FillButton() {
  const wide = useContext(PopupWideContext);
  const fill = usePopupFill();
  if (!wide) return null;
  return (
    <IconButton
      className="agent-popup-fill"
      data-testid="agent-popup-fill"
      icon={<UnfoldHorizontal />}
      size="sm"
      aria-label="Fill the screen"
      aria-pressed={fill}
      tooltip={fill ? `Back to ${POPUP_CAP} px wide` : 'Fill the screen'}
      onClick={() => setPopupFill(!fill)}
    />
  );
}

/** Open beside…, as a menu's row: each agent it can open beside the one shown. */
const besideMenu = (beside: readonly BesideChoice[]): MenuEntry => ({ label: 'Open beside…', icon: <Columns2 />, detail: 'split', entries: beside.map(({ label, onSelect }) => ({ label, onSelect })) });

/**
 * The header's split button: pressed while split, ending it; else the agents to open beside the one shown, or nothing
 * where there are none.
 */
export function SplitButton({ split, beside, onEnd }: { split: PopupSplit | undefined; beside: readonly BesideChoice[]; onEnd(): void }) {
  if (split !== undefined)
    return <IconButton className="agent-popup-split" data-testid="agent-popup-split" icon={<Columns2 />} size="sm" aria-label="End the split" aria-pressed tooltip="End the split, back to one agent" onClick={onEnd} />;
  if (beside.length === 0) return null;
  return (
    <Menu align="end" entries={[{ heading: 'Open beside' }, ...beside.map(({ label, onSelect }) => ({ label, onSelect }))]}>
      <IconButton className="agent-popup-split" data-testid="agent-popup-split" icon={<Columns2 />} size="sm" aria-label="Open beside…" aria-pressed={false} tooltip="Split: another agent beside this one" />
    </Menu>
  );
}

/**
 * A pop-up's + (its tooltip says ⌘T): what Today's strip's + offered for the agent's pane (shells here or at a
 * folder, web pages, scripts, other sessions, pull requests, the to-do list), then the views, then Open beside….
 * Nothing while it has neither a pane nor a view to offer.
 */
export function PopupPlus({
  paneRow,
  views,
  open,
  beside,
  onSelect,
}: {
  paneRow: PaneRow | undefined;
  views: readonly PopUpView[];
  open: readonly string[];
  /** The agents it can open beside the one shown; none while split. */
  beside: readonly BesideChoice[];
  onSelect(key: string): void;
}) {
  const pane = useAddEntries(paneRow?.adds() ?? NOTHING_TO_ADD, { split: false });
  const viewRows: MenuEntry[] = [
    ...(views.length === 0 ? [] : [{ heading: 'Views' }]),
    ...views.map((view) => ({ label: view.label, icon: viewIcon(view.key), hint: open.includes(view.key) ? 'open' : undefined, onSelect: () => onSelect(view.key) })),
  ];
  const before: MenuEntry[] = [...(paneRow === undefined ? [] : [{ heading: 'New tab' }, ...pane.entries, ...(viewRows.length > 0 ? ['separator' as const] : [])]), ...viewRows];
  const entries: MenuEntry[] = [...before, ...(beside.length === 0 ? [] : [...(before.length > 0 ? ['separator' as const] : []), besideMenu(beside)])];
  if (entries.length === 0) return null;
  return (
    <Menu align="end" entries={entries} open={pane.menuOpen} onOpenChange={pane.onOpenChange}>
      <IconButton
        className="agent-popup-plus"
        data-testid="agent-popup-plus"
        icon={<Plus />}
        size="xs"
        variant="ghost"
        aria-label="New tab"
        tooltip={
          <>
            New tab: a shell, a page, a view, or one beside<Kbd>{keyText('window.newTab')}</Kbd>
          </>
        }
      />
    </Menu>
  );
}

/** A + before the body has drawn its panes: no shells to offer yet. */
const NOTHING_TO_ADD: TabAdds = { here: '', onNewShell: () => {}, onNewShellAt: () => {}, onRunScript: () => {}, scripts: () => Promise.resolve({ runner: 'npm', scripts: [] }), sessions: [], named: false, shells: false, onSplit: () => {} };

/**
 * The header: the agent's mark, name and status, or a ticket's id and title (`ticket`), then `children`, its buttons,
 * at the end. `renameAsk` going up opens the agent's name field. In a window of its own (`dragsWindow`), it drags the
 * window, as a window's title bar; in its expanded tile, the board drags the tile by it.
 */
export function AgentViewHeader({
  agent,
  ticket,
  renameAsk,
  dragsWindow,
  tile,
  children,
}: {
  agent: Agent;
  ticket?: { id: string | undefined; title: string } | undefined;
  renameAsk: number;
  dragsWindow: boolean;
  tile?: AgentViewTile | undefined;
  children: ReactNode;
}) {
  const shows = useNeedsYouShows();
  const simplified = useSimplified();
  return (
    <header
      className={tile === undefined ? 'session-window-head agent-popup-head' : `session-window-head agent-popup-head ${tile.headClassName}`}
      data-drag-region={dragsWindow || undefined}
      tabIndex={tile?.headTabIndex}
      onDoubleClick={tile?.onHeadDoubleClick}
    >
      {ticket === undefined ? (
        <>
          <HarnessMark className="session-window-mark" harness={agent.harness} />
          <SessionName agent={agent} name={agent.name} title={agent.name} nodeId={tile?.nodeId} ask={renameAsk} />
          {tile !== undefined ? tile.status : simplified ? <StatusMark status={humanStatus(agent, shows).status} /> : <StatusPill {...agentPill(agent, shows)} />}
        </>
      ) : (
        <>
          {ticket.id !== undefined && (
            <span className="ticket-tile-id" data-testid="ticket-id">
              <Ticket aria-hidden />
              {ticket.id}
            </span>
          )}
          <span className="agent-popup-title" title={ticket.title}>
            {ticket.title}
          </span>
        </>
      )}
      <span className="session-window-head-fill" />
      {children}
    </header>
  );
}
