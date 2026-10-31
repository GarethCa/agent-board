import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, CircleStop, MoreHorizontal, PanelLeft, Play, Power, SquareArrowDownLeft, SquareArrowOutUpRight, SquareTerminal, Square, X } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, humanStatus } from '@agent-board/daemon/human-status';
import { agentMenu, type ModelEntry } from '../board/menu-model';
import { ClickOpensContext, TileActionsContext } from '../board/tile';
import { StatusMark } from '../board/StatusMark';
import { keyText, pressed } from '../keys/registry';
import { useNeedsYouShows } from '../needs-you-setting';
import { useReviews } from '../review/ReviewsProvider';
import { roundsOf } from '../review/reviews';
import { useGateRuns } from '../gate/GatesProvider';
import { GateControls } from '../gate/GateControls';
import { gated } from '../gate/gate-view';
import { Button, Dialog, IconButton, Menu, useToast, type MenuEntry } from '../ui';
import { errorMessage } from '../../../shared/errors';
import { SessionName } from './SessionName';
import type { WindowNav } from './SessionWindow';

interface SimplifiedHeaderProps {
  sessionId: string;
  /** Undefined until the agent is listed: its name and Done only, until then. */
  agent: Agent | undefined;
  name: string;
  title: string;
  placement: 'board' | 'own-window';
  nav?: WindowNav;
  /** Where the body puts its Chat | Timeline | Terminal switch. */
  onViewSlot(slot: HTMLElement | null): void;
  /** Shows the terminal, or from it the chat or timeline last shown: what ⌥⌘T does, set by the body. */
  terminalToggle: RefObject<(() => void) | null>;
  /** Whether the details beside the body are open, and how to change that. */
  detailsOpen: boolean;
  onDetailsOpen(open: boolean): void;
  onClose(): void;
  onPopOut?(): void;
  onPopIn?(): void;
}

/**
 * An agent's window header under the Simplified design (docs/adr/0022-simplified-design.md): its zone as a pop-up of
 * the zone's agents, its name and status, the one action that fits what it is doing (Stop while it works, Wake while
 * it is paused), the Chat | Timeline | Terminal switch, the details toggle, its ⋯ menu and Done. ⋯ is the agent's
 * menu, as its tile's, with this window's rows and End agent… added; the window's Minimise, Pop out and Delete live
 * there or go with it.
 */
export function SimplifiedHeader({ sessionId, agent, name, title, placement, nav, onViewSlot, terminalToggle, detailsOpen, onDetailsOpen, onClose, onPopOut, onPopIn }: SimplifiedHeaderProps) {
  const shows = useNeedsYouShows();
  const [ending, setEnding] = useState(false);
  const status = agent && humanStatus(agent, shows).status;
  const board = useBoardMenu(agent, placement);
  return (
    <>
      {nav && <ZonePopUp nav={nav} sessionId={sessionId} />}
      <SessionName agent={agent} name={name} title={title} />
      {status && <StatusMark status={status} />}
      <span className="session-window-head-fill" />
      {/* Its merge gate stays a technical detail until the steps strip takes its place. */}
      {agent && gated(agent) && (
        <span className="session-window-gate" data-technical-detail>
          <GateControls agent={agent} visible />
        </span>
      )}
      {agent && <StateAction agent={agent} placement={placement} />}
      <span className="session-window-view-slot" ref={onViewSlot} />
      <IconButton
        icon={<PanelLeft />}
        size="sm"
        aria-label={detailsOpen ? 'Hide details' : 'Show details'}
        aria-pressed={detailsOpen}
        tooltip={`${detailsOpen ? 'Hide' : 'Show'} its details  ${keyText('window.details')}`}
        onClick={() => onDetailsOpen(!detailsOpen)}
      />
      <Menu align="end" entries={windowMenu({ agent, placement, terminalToggle, onPopOut, onPopIn, onClose, onEnd: () => setEnding(true), board })}>
        <IconButton icon={<MoreHorizontal />} size="sm" aria-label="More" tooltip="More actions" />
      </Menu>
      <Button size="sm" onClick={onClose} aria-label={`Done, close ${name}`} tooltip={placement === 'board' ? 'Back to the board; it keeps running' : 'Close this window; it keeps running'}>
        Done
      </Button>
      {ending && agent && <EndAgentDialog agent={agent} onDone={() => setEnding(false)} />}
    </>
  );
}

/** The agent's menu rows, as its tile's ⋯ has them: on the board only, where the board's actions are. */
function useBoardMenu(agent: Agent | undefined, placement: 'board' | 'own-window'): ModelEntry[] {
  const actions = useContext(TileActionsContext);
  const clickOpens = useContext(ClickOpensContext);
  const rounds = roundsOf(useReviews(), agent?.sessionId ?? '');
  const gate = useGateRuns().get(agent?.sessionId ?? '');
  if (agent === undefined || placement !== 'board') return [];
  return agentMenu({ nodeId: '', agent, clickOpens, gate, rounds, rename: () => {}, actions });
}

/**
 * The agent menu's rows a window has no use for, or has its own of: renaming is a click on the name it shows, and
 * opening, popping out and folding are the window's own.
 */
const WINDOW_OWN = new Set(['expand', 'open-window', 'pop-out', 'fold', 'rename']);

/**
 * The ⋯ menu: the agent's run first, as its tile's menu has it, then this window's rows (into its own window or back
 * to the board, and the terminal), its settings, reviews and gate, then End agent… above Delete. A pop-out, which has
 * no board to act for it, has the window's rows and End agent… alone. `board` is the agent's menu as its tile has it.
 */
export function windowMenu({
  agent,
  placement,
  terminalToggle,
  onPopOut,
  onPopIn,
  onClose,
  onEnd,
  board,
}: {
  agent: Agent | undefined;
  placement: 'board' | 'own-window';
  terminalToggle: RefObject<(() => void) | null>;
  onPopOut?(): void;
  onPopIn?(): void;
  onClose(): void;
  onEnd(): void;
  board: readonly ModelEntry[];
}): MenuEntry[] {
  const own: MenuEntry[] = [
    ...(onPopOut ? [{ label: 'Open in its own window', icon: <SquareArrowOutUpRight />, onSelect: onPopOut }] : []),
    ...(onPopIn ? [{ label: 'Back to board', icon: <SquareArrowDownLeft />, onSelect: onPopIn }] : []),
    ...(agent ? [{ label: 'Show terminal, or back', icon: <SquareTerminal />, shortcut: keyText('window.terminalView'), onSelect: () => terminalToggle.current?.() }] : []),
    ...(placement === 'own-window' ? [{ label: 'Close window', icon: <X />, onSelect: onClose }] : []),
  ];
  const end: MenuEntry[] = agent && agent.endedAt === null ? [{ label: 'End agent…', icon: <Power />, hint: 'It stops, and keeps its tile and history', onSelect: onEnd }] : [];
  const rows = board.filter((entry) => entry === 'separator' || !('id' in entry) || !WINDOW_OWN.has(entry.id));
  const deleteAt = rows.findIndex((entry) => entry !== 'separator' && 'id' in entry && entry.id === 'delete');
  const firstBreak = rows.indexOf('separator');
  if (rows.length === 0) return tidy([...own, 'separator', ...end]);
  const run = rows.slice(0, firstBreak === -1 ? rows.length : firstBreak);
  const rest = rows.slice(run.length, deleteAt === -1 ? rows.length : deleteAt);
  const last = deleteAt === -1 ? [] : rows.slice(deleteAt);
  return tidy([...run, 'separator', ...own, ...rest, 'separator', ...end, ...last]);
}

/** Drops the separators at either end and those doubled up, which rows left out of a menu would leave. */
function tidy(entries: MenuEntry[]): MenuEntry[] {
  return entries.filter((entry, index) => entry !== 'separator' || (index > 0 && index < entries.length - 1 && entries[index - 1] !== 'separator'));
}

/** The header's one action for what the agent is doing now: Stop (⌘.) while it works, Wake while paused, else none. */
function StateAction({ agent, placement }: { agent: Agent; placement: 'board' | 'own-window' }) {
  const toast = useToast();
  // On the board, Wake is the board's own, as from the tile, so a second press while one is under way waits on it.
  const { resumeAgent } = useContext(TileActionsContext);
  const wake = placement === 'board' ? () => resumeAgent(agent.sessionId) : () => window.agentBoard.agents.resume(agent.sessionId);
  const [busy, setBusy] = useState(false);
  const shows = useNeedsYouShows();
  const working = agent.endedAt === null && humanStatus(agent, shows).status === 'working';
  const paused = agent.state === 'hibernated';
  const act = (what: string, call: () => Promise<unknown>) => {
    setBusy(true);
    call()
      .catch((failure: unknown) => toast.show({ tone: 'error', message: `Could not ${what}: ${errorMessage(failure)}` }))
      .finally(() => setBusy(false));
  };
  const stop = useRef(() => {});
  stop.current = () => act('stop its step', () => window.agentBoard.agents.interrupt(agent.sessionId));
  // ⌘. while it works, wherever the focus is in the window, before the terminal takes it.
  useEffect(() => {
    if (!working) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('window.stopStep', event)) return;
      event.preventDefault();
      event.stopPropagation();
      stop.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [working]);
  if (working) {
    return (
      <Button size="sm" icon={<Square />} loading={busy} onClick={() => stop.current()} tooltip={`Stop what it is doing now; it keeps its conversation  ${keyText('window.stopStep')}`}>
        Stop
      </Button>
    );
  }
  if (paused) {
    return (
      <Button size="sm" icon={<Play />} loading={busy} onClick={() => act('wake it', wake)} tooltip="Wake it: it picks up where it was paused">
        Wake
      </Button>
    );
  }
  return null;
}

/** The zone as a pop-up: its agents and shells, each with its status, to show one here, and stepping through them. */
function ZonePopUp({ nav, sessionId }: { nav: WindowNav; sessionId: string }) {
  const shows = useNeedsYouShows();
  const group = nav.zone?.name ?? 'Loose';
  const entries: MenuEntry[] = [
    { heading: group },
    ...nav.members.map((member) => ({
      label: member.name,
      detail: member.id === sessionId ? 'Here' : member.agent ? HUMAN_STATUS_LABELS[humanStatus(member.agent, shows).status] : 'Shell',
      disabled: member.id === sessionId,
      onSelect: member.onShow,
    })),
    'separator',
    { label: 'Previous', shortcut: keyText('window.previous'), disabled: nav.count < 2, onSelect: () => nav.onStep(-1) },
    { label: 'Next', shortcut: keyText('window.next'), disabled: nav.count < 2, onSelect: () => nav.onStep(1) },
  ];
  return (
    <Menu align="start" entries={entries}>
      <Button variant="ghost" size="sm" className="session-window-zone" data-testid="session-window-zone" aria-label={`${group}: its agents`}>
        <span
          className="session-nav-dot"
          data-loose={nav.zone === undefined || undefined}
          // A zone's colour is its data, not a theme token.
          style={nav.zone === undefined ? undefined : { background: nav.zone.color }}
          aria-hidden
        />
        {group}
        <ChevronDown aria-hidden />
      </Button>
    </Menu>
  );
}

/** Asks before ending the agent: today's Stop, which keeps its tile, its history and its worktree. */
function EndAgentDialog({ agent, onDone }: { agent: Agent; onDone(): void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const end = () => {
    setBusy(true);
    window.agentBoard.agents
      .stop(agent.sessionId)
      .then(onDone, (failure: unknown) => {
        setBusy(false);
        toast.show({ tone: 'error', message: `Could not end it: ${errorMessage(failure)}` });
      });
  };
  return (
    <Dialog
      role="alertdialog"
      title={`End ${agent.name}?`}
      onClose={onDone}
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="danger" icon={<CircleStop />} loading={busy} onClick={end}>
            End agent
          </Button>
        </>
      }
    >
      It stops now. Its tile, its conversation and its work stay, and Restart in its menu starts it again.
    </Dialog>
  );
}
