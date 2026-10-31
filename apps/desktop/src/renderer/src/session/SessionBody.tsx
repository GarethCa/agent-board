import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsDownUp, ChevronsUpDown, ClipboardList, FileText, GitPullRequest, Globe, SquareTerminal } from 'lucide-react';
import type { PaneLayout } from '@agent-board/daemon/pane-layout';
import { OWN_SURFACE } from '@agent-board/daemon/window-layout';
import type { Agent, Shell, ShellOwner } from '@agent-board/daemon/protocol';
import { STATE_LABELS } from '../states';
import { Button, Dialog, ErrorText, Segmented, Tag, type SegmentedOption } from '../ui';
import { useAction } from '../use-action';
import { errorMessage } from '../../../shared/errors';
import { SessionDetails } from './SessionDetails';
import { DetailsHandle } from './DetailsHandle';
import { ChatView } from './ChatView';
import { Composer } from './Composer';
import type { RunsChoice, RunsMode } from './chat';
import { ChatAgentsSwitch } from './ChatAgentsFilter';
import { ChatStyleSwitch } from './ChatStyleSwitch';
import { ShellPanes } from './ShellPanes';
import { TerminalPane, type AttachState, type PaneStatus } from './TerminalPane';
import { composerBlock } from './composer-block';
import { canRestart, endedShellLabel, exitText, RestartAgent } from './RestartAgent';
import { HARNESS_COMMANDS, planSurfaceOf, pullRequestSurfaceOf, shellOwner, tabLiveShells, windowShells, worstState, type TabOwner, type WindowSurface } from './tabs';
import { agentWorktrees, dropKey, dropOver as dropOverValue, foreignFolder, tabMover } from './shell-moves';
import type { StripTab } from './TabStrip';
import { useWindowPanes, type WindowPanesControl } from './use-window-panes';
import { PaneStrip, WindowPanes } from './WindowPanes';
import { chosenView, useSessionView, type SessionView } from './session-view';
import { useOpensOn } from './opens-on';
import { pressed } from '../keys/registry';
import { PullRequestTab } from './PullRequestTab';
import { WebTab } from './WebTab';
import { GateTab } from '../gate/GateTab';
import { PlanTab } from '../plan/PlanTab';
import { DocumentTab } from '../doc/DocumentTab';
import { DocTab } from './DocTab';
import { gateDot } from '../gate/gate-view';
import { useGateRuns } from '../gate/GatesProvider';
import { WebLinkContext } from './web-links';
import { useSeenWhileShown } from './mark-seen';

/**
 * What a session window or an expanded tile shows: one session's terminal (with its agent, live, for an agent's
 * controls and composer), or a shell tile's panes, its controls acting on the focused pane. The shell is undefined
 * until it is listed. Or, popped out only, a tab window's tabs (slice 4), which are no session's.
 */
export type WindowContent =
  | { kind: 'session'; sessionId: string; agent?: Agent }
  | { kind: 'shell'; shellId: string; shell: Shell | undefined }
  | { kind: 'tabs'; id: string };

interface SessionBodyProps {
  content: WindowContent;
  /** Whether the details are collapsed to an icon rail, and how to change that. */
  detailsCollapsed: boolean;
  onDetailsCollapsed(collapsed: boolean): void;
  /** A line about the session shown above its terminal, e.g. why it is not asking yet. */
  notice?: ReactNode;
  /** Hears how the terminal (or a shell's focused pane) is attached. */
  onAttachState?(state: AttachState): void;
  /** Whether the terminal takes the keyboard as it opens. True by default. */
  autoFocus?: boolean;
  /** Whether the window shows this body at all: false while its Review or Activity tab covers it. True by default. */
  shown?: boolean;
  /**
   * Where an agent's Chat | Timeline | Terminal switch goes: the session window's header, under the Simplified design,
   * which also gives ⌥⌘T to it (null until the header is drawn). Without one, a Terminal | Chat switch ends the pane's strip.
   */
  viewSlot?: HTMLElement | null;
  /** Set to what ⌥⌘T does, with the switch in the header, for the header's menu to do too. */
  terminalToggle?: RefObject<(() => void) | null>;
}

/**
 * The body shared by the session window and the expanded tile: the details strip
 * on the LEFT, and the dark terminal column, with a strip naming its pane and how it is attached, the terminal or a
 * shell's panes, and for an agent in its chat view a message composer under it. The terminal is attached while this is mounted.
 */
export function SessionBody({
  content,
  detailsCollapsed,
  onDetailsCollapsed,
  notice,
  onAttachState,
  autoFocus = true,
  shown = true,
  viewSlot,
  terminalToggle,
}: SessionBodyProps) {
  const agent = content.kind === 'session' ? content.agent : undefined;
  const shell = content.kind === 'shell' ? content.shell : undefined;
  const [single, setSingle] = useState<PaneStatus>({ state: 'attaching' });
  const [problem, setProblem] = useState<string>();
  const [paneStatuses, setPaneStatuses] = useState<Record<string, PaneStatus>>({});
  const onPaneStatus = useCallback(
    (paneId: string, status: PaneStatus) => setPaneStatuses((current) => ({ ...current, [paneId]: status })),
    [],
  );
  const owner: TabOwner | undefined = agent ? { kind: 'agent', agent } : shell ? { kind: 'shell', shell } : content.kind === 'tabs' ? content : undefined;
  // Tabs and panes drag between windows and onto the board, and between OS windows, where the
  // board can move them: a pop-out asks it to.
  const moves = tabMover.use();
  const panes = useWindowPanes(owner, { onProblem: setProblem, moves });
  const gateRuns = useGateRuns();
  const dropOver = dropOverValue.use();
  const worktrees = agentWorktrees.use();
  const from = owner === undefined ? undefined : shellOwner(owner);
  const dragFrom = moves === undefined ? undefined : from;
  // A shell moved in from another agent keeps its folder: say so when it is outside this agent's worktree.
  const astray = agent && panes && foreignFolder(panes.surfaces.flatMap((surface) => (surface.kind === 'tab' && surface.tab.shell ? [surface.tab.shell] : [])), agent.sessionId, agent.worktree, worktrees);
  const panelPrefix = useId();
  const tabPanel = (key: string) => `${panelPrefix}-tab-${key}`;
  // The window's own: its own surface and its shell tabs, not another session shown in it.
  const ownFocused = panes === undefined || panes.focusedPane.active.kind === 'tab';
  // The session with the keyboard, in any pane; and in the window's own surfaces, the one its controls act on: the
  // focused one, else the own surface's.
  const anyFocus = panes?.focusedSession;
  const tabFocus = panes === undefined ? undefined : ownFocused ? anyFocus : panes.focusIn(panes.surfaces[0]!);
  // Whatever way in this session was opened by (⌘K, the inbox, ‹ ›, a restored window...), showing the agent's own pane
  // is seeing its ask: not while a shell tab of its pane, or its Review or Activity tab, covers it.
  useSeenWhileShown(content.kind === 'session' ? content.sessionId : undefined, shown && (panes === undefined || panes.showing(OWN_SURFACE)));
  // A shell pane of one of the window's tabs with the keyboard, not an agent's own.
  const tabShellFocused = tabFocus !== undefined && tabFocus !== agent?.sessionId;
  // The session's own pane: a shell tile's focused pane, or the agent's (whose window and controls it is, whichever
  // pane has the keyboard).
  const own = (shell && tabFocus !== undefined && paneStatuses[tabFocus]) || single;
  // What the strip says: the focused pane, a shell pane in an agent's tab or another session shown here too.
  const otherFocused = !ownFocused && anyFocus !== undefined;
  const pane = (otherFocused && paneStatuses[anyFocus]) || (tabShellFocused && paneStatuses[tabFocus]) || own;
  // A shell tile not listed yet has no pane for its controls to act on.
  const controlSession = content.kind === 'session' ? content.sessionId : tabFocus;
  const live = controlSession !== undefined && own.state !== 'exited' && own.state !== 'unavailable';
  const openLink = useCallback(
    (url: string) => void window.agentBoard.trackers.openLink(url).catch((error: unknown) => setProblem(`could not open the link: ${errorMessage(error)}`)),
    [],
  );
  useEffect(() => onAttachState?.(own.state), [own.state, onAttachState]);
  // The chat is picked for the agent's own pane: a shell tab stays a terminal, with no message box or chat actions under it.
  // The Timeline is the chat drawn as its rail, in the Simplified design's window, whose header has the switch and which
  // opens on the view its setting names. Anywhere else (Classic, an expanded tile) a Timeline pick shows as the chat,
  // in the chat's own style, and the terminal is what shows until a view is picked.
  const headerSwitch = viewSlot !== undefined;
  const opensOn = useOpensOn();
  const windowOpensOn = headerSwitch ? opensOn : 'terminal';
  const [pickedView, pickView] = useSessionView(agent?.sessionId, windowOpensOn);
  const chatPicked = pickedView !== 'terminal' && agent !== undefined;
  const onShowTerminal = () => switchView('terminal');
  const chat = chatPicked && (panes === undefined || panes.showing(OWN_SURFACE));
  // Expand all and Collapse all, kept while the window is open, through switches to the terminal and back.
  const [runs, setRuns] = useState<RunsChoice>({ mode: 'auto', at: 0 });
  const pressRuns = (mode: RunsMode) => setRuns((current) => ({ mode, at: current.at + 1 }));
  const terminalView = useRef<HTMLDivElement>(null);
  const wasChat = useRef(chatPicked);
  // Set by a pick made in this body: one heard from another window of the session moves neither tab nor keyboard here.
  const pickedHere = useRef(false);
  const select = panes?.select;
  useEffect(() => {
    // Back from the chat picked here, the terminal takes the keyboard again: it lost it when it was hidden.
    if (pickedHere.current && wasChat.current && !chatPicked) terminalView.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus();
    pickedHere.current = false;
    wasChat.current = chatPicked;
  }, [chatPicked]);
  const switchView = (next: SessionView) => {
    // A pick that changes nothing sets no flag: the next change heard from elsewhere is still not this body's.
    pickedHere.current = chosenView(agent?.sessionId, windowOpensOn) !== next;
    pickView(next);
    // Chat picked while a shell tab shows brings the agent's own tab forward. Only on a pick: a tab asked for as the
    // window opens (a row of the shells chip) still shows.
    if (next !== 'terminal') select?.(OWN_SURFACE);
  };
  // ⌥⌘T, with the switch in the header: the terminal, and from it back to the chat or timeline last shown.
  const lastConversation = useRef<SessionView>('chat');
  if (pickedView !== 'terminal') lastConversation.current = pickedView;
  const toggleTerminal = useRef(() => {});
  toggleTerminal.current = () => switchView(chat ? 'terminal' : lastConversation.current);
  if (terminalToggle) terminalToggle.current = () => toggleTerminal.current();
  // Not while the window's Review or Activity tab covers the body: the switch it would change can't be seen.
  const listening = headerSwitch && agent !== undefined && shown;
  useEffect(() => {
    if (!listening) return;
    // Before the terminal, which would otherwise take the key, and wherever the focus is in the window.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('window.terminalView', event)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleTerminal.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listening]);

  // An agent's terminal, with its chat view over it when that is picked: in its own tab, or the whole window.
  const sessionView = content.kind === 'session' && (
    <>
      <div ref={terminalView} className="session-terminal-view" hidden={chatPicked}>
        {/* Keyed by when its session started, so a relaunched agent's session is attached afresh; an ended
            agent's pane shows the shell it dropped into, while that runs. */}
        <TerminalPane
          key={`${content.agent?.createdAt}/${content.agent?.shellSessionId}`}
          sessionId={content.agent?.shellSessionId ?? content.sessionId}
          onStatus={setSingle}
          autoFocus={autoFocus}
          // In its tab, it has the keyboard while that tab shows and it is the tab's focused pane.
          focused={panes === undefined || (panes.focusedPane.active.key === OWN_SURFACE && anyFocus === agent?.sessionId)}
          // The shell an ended agent dropped into is a plain shell, until the user runs its harness in it.
          harness={content.agent?.shellSessionId ? content.agent.shellHarness : (content.agent?.harness ?? null)}
        />
      </div>
      {agent && (
        <div className="session-chat-view" hidden={!chatPicked}>
          <ChatView
            key={agent.sessionId}
            agent={agent}
            active={chatPicked}
            onShowTerminal={onShowTerminal}
            runs={runs}
            onOpenLink={openLink}
            onOpenPlan={panes && (() => panes.open(planSurfaceOf(agent.sessionId)))}
            style={headerSwitch && pickedView === 'timeline' ? 'timeline' : undefined}
          />
        </div>
      )}
    </>
  );

  // How the agent's pane shows it, over the pane it changes: the same in a session window and an expanded tile. Over a
  // shell tab it reads Terminal, which is what shows; pressing Chat brings the agent's own tab forward.
  const viewSwitch = agent && !headerSwitch && <Segmented<SessionView> className="session-view-switch" aria-label="View" value={chat ? 'chat' : 'terminal'} onChange={switchView} options={VIEW_OPTIONS} />;
  // In the header, the three views, always there: Terminal reads as picked while a shell tab shows, as it is what shows.
  const headerViewSwitch =
    agent && viewSlot
      ? createPortal(<Segmented<SessionView> className="session-header-view-switch" aria-label="View" value={chat ? pickedView : 'terminal'} onChange={switchView} options={HEADER_VIEW_OPTIONS} />, viewSlot)
      : null;
  // A split window's panes have strips of their own; the switch ends the one holding the agent's own tab.
  const split = panes !== undefined && panes.panes.length > 1;
  const here = agent ? 'in this worktree' : 'in this folder';
  /** A surface's tab: an agent's own dot is its attachment unless a shell split beside it failed; a shell's, its shells'. */
  const stripTabOf = (surface: WindowSurface): StripTab => {
    const closable = panes?.closable(surface) ?? false;
    const base = { id: surface.key, label: surface.label, closable };
    if (surface.kind === 'agent') return { ...base, dot: paneStatuses[surface.agent.sessionId]?.state ?? 'attaching', closeHint: 'Close the tab; the session keeps running' };
    if (surface.kind === 'pr') return { ...base, icon: <GitPullRequest />, title: `${surface.pr.repo}#${surface.pr.number}`, closeHint: 'Close the tab' };
    if (surface.kind === 'web') return { ...base, icon: <Globe />, title: surface.web.url || 'New tab', closeHint: 'Close the tab and forget its cookies' };
    if (surface.kind === 'plan') return { ...base, icon: <ClipboardList />, title: `${surface.agent.name}'s plans`, closeHint: 'Close the tab; its plans stay in its history' };
    if (surface.kind === 'doc') return { ...base, icon: <FileText />, title: surface.doc.path, closeHint: 'Close the tab; the doc stays in its sidebar' };
    if (surface.kind === 'document') return { ...base, icon: <FileText />, title: surface.document.path, closeHint: 'Close the tab; the document stays on its agent' };
    if (surface.kind === 'gate') return { ...base, dot: gateDot(gateRuns.get(surface.gate.sessionId)), title: `${surface.agent.name}'s merge gate`, closeHint: 'Close the tab; the gate keeps its last run' };
    if (surface.kind === 'tile') return { ...base, dot: worstState(windowShells({ kind: 'shell', shell: surface.shell }, [surface.shell]).map((each) => each.state)) ?? 'idle', closeHint: 'Close the tab; its shells keep running' };
    const dots = panes?.dots.get(surface.key);
    const dot = agent && surface.key === OWN_SURFACE ? (dots === 'failed' ? 'failed' : single.state) : (dots ?? 'idle');
    return { ...base, dot, closeHint: 'Close the tab, ending its shells' };
  };
  const renderSurface = (surface: WindowSurface, visible: boolean) =>
    panes === undefined ? null : (
      <SurfaceView
        surface={surface}
        panes={panes}
        visible={visible}
        shown={shown}
        autoFocus={autoFocus}
        onPaneStatus={onPaneStatus}
        onProblem={setProblem}
        agentPane={surface.key === OWN_SURFACE && agent ? { sessionId: agent.sessionId, label: HARNESS_COMMANDS[agent.harness], content: sessionView } : undefined}
        dragFrom={dragFrom}
      />
    );

  return (
    <WebLinkContext.Provider value={panes?.openWeb}>
    <div
      className="session-window-body"
      onKeyDownCapture={panes?.onKeyDown}
      data-tab-drop={from === undefined ? undefined : dropKey(from)}
      data-drop-over={(from !== undefined && dropOver === dropKey(from)) || undefined}
    >
      {content.kind !== 'tabs' && (
      <SessionDetails
        sessionId={controlSession}
        agent={agent}
        shell={panes?.focusedPane.active.kind === 'tab' ? panes.focusedPane.active.tab.shell : undefined}
        focusedPane={tabFocus}
        onFocusPane={panes?.focus}
        onSplit={panes?.splitFromDetails}
        live={live}
        onProblem={setProblem}
        collapsed={detailsCollapsed}
        onCollapsed={onDetailsCollapsed}
        onOpenLink={openLink}
        onOpenPullRequest={
          panes &&
          ((pr) => {
            const surface = pullRequestSurfaceOf(pr);
            if (surface === undefined) openLink(pr.url);
            else panes.open(surface);
          })
        }
        onOpenSurface={panes && ((surface) => panes.open(surface))}
        onOpenWeb={panes?.openWeb}
      />
      )}
      {content.kind !== 'tabs' && <DetailsHandle collapsed={detailsCollapsed} onCollapsed={onDetailsCollapsed} />}
      <div className="session-window-main" data-surface="window">
        <div className="session-window-strip">
          {panes ? (
            panes.panes.length === 1 && (
              <PaneStrip panes={panes} pane={panes.panes[0]!} stripTab={stripTabOf} here={here} panelId={tabPanel} focused={false} />
            )
          ) : (
            <span className="session-window-pane">
              <span className="session-window-pane-dot" data-state={pane.state} aria-hidden />
              shell
            </span>
          )}
          {chat && !headerSwitch && <ChatStyleSwitch />}
          {chat && agent && <ChatAgentsSwitch sessionId={agent.sessionId} />}
          {chat && (
            <span className="chat-runs-actions">
              <Button variant="ghost" size="xs" icon={<ChevronsUpDown />} onClick={() => pressRuns('expanded')} tooltip="Open every call and run of calls" aria-label="Expand all">
                <span className="chat-runs-label">Expand all</span>
              </Button>
              <Button variant="ghost" size="xs" icon={<ChevronsDownUp />} onClick={() => pressRuns('collapsed')} tooltip="Close every call and run of calls" aria-label="Collapse all">
                <span className="chat-runs-label">Collapse all</span>
              </Button>
            </span>
          )}
          {astray && (
            <Tag tone="warning" className="session-window-astray" data-testid="session-window-astray">
              {astray}
            </Tag>
          )}
          <span className="session-window-status" data-testid="session-window-status" data-error={pane.state === 'exited' || problem !== undefined}>
            {/* A tab window has no session of its own to tell of: only another's shown in it, and what went wrong. */}
            {content.kind !== 'tabs' || otherFocused ? statusText(pane, tabShellFocused || otherFocused ? undefined : agent) : null}
            {problem && `${content.kind !== 'tabs' || otherFocused ? ' · ' : ''}${problem}`}
          </span>
          {!split && viewSwitch}
        </div>
        {notice}
        {agent && <BlockedBanner agent={agent} chat={chat} onShowTerminal={onShowTerminal} />}
        {agent && canRestart(agent) && (
          <div className="agent-exit-banner" role="status" data-testid="agent-exit-banner">
            {exitText(agent)}
            <RestartAgent agent={agent} />
          </div>
        )}
        <div className="session-panes">
          {panes ? (
            <WindowPanes panes={panes} stripTab={stripTabOf} renderSurface={renderSurface} here={here} panelId={tabPanel} inlineStrip={panes.panes.length === 1} trailingOf={(pane) => (pane.surfaces.some((surface) => surface.key === OWN_SURFACE) ? viewSwitch : undefined)} />
          ) : content.kind === 'session' ? (
            sessionView
          ) : content.kind === 'tabs' ? null : (
            <p className="session-window-pending">Loading panes…</p>
          )}
        </div>
        {agent && chat && <Composer agent={agent} />}
      </div>
      {panes?.closing && <CloseTabDialog surface={panes.closing} onAnswer={panes.confirmClose} />}
      {headerViewSwitch}
    </div>
    </WebLinkContext.Provider>
  );
}

const VIEW_OPTIONS: SegmentedOption<SessionView>[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'chat', label: 'Chat' },
];

/** The Simplified design's header switch: the conversation first, then the harness's own screen. */
const HEADER_VIEW_OPTIONS: SegmentedOption<SessionView>[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'terminal', label: 'Terminal', icon: <SquareTerminal /> },
];

/**
 * Asks before closing a shell tab whose shells still run, as deleting a shell tile does: here, in the window, which a
 * pop-out has no board to ask from.
 */
function CloseTabDialog({ surface, onAnswer }: { surface: WindowSurface; onAnswer(confirmed: boolean): void }) {
  const live = surface.kind === 'tab' ? tabLiveShells(surface.tab) : 0;
  return (
    <Dialog
      role="alertdialog"
      title="Close tab?"
      onClose={() => onAnswer(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onAnswer(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => onAnswer(true)}>
            Close tab
          </Button>
        </>
      }
    >
      {`${surface.label} ${live === 1 ? 'still has a running shell. Closing the tab ends it.' : `still has ${live} running shells. Closing the tab ends them.`}`}
    </Dialog>
  );
}

/** Gives the keyboard to the terminal in the window around `from`, where a permission prompt waits; whether it could. */
function focusTerminal(from: HTMLElement): boolean {
  const terminal = from.closest('.session-window-main')?.querySelector<HTMLElement>('.xterm-helper-textarea');
  terminal?.focus();
  return terminal !== null && terminal !== undefined;
}

/**
 * The slim banner over the panes (the exit banner's) when an agent can't take a message and something gets it
 * going: Resume after a restart, Show prompt for a permission prompt. An ended agent's Restart is the exit banner's.
 * From the chat, where the terminal is hidden, Show prompt switches to it.
 */
function BlockedBanner({ agent, chat, onShowTerminal }: { agent: Agent; chat: boolean; onShowTerminal(): void }) {
  const [problem, setProblem] = useState<string>();
  const { busy, error, run } = useAction();
  const blocked = composerBlock(agent);
  if (blocked?.action !== 'resume' && blocked?.action !== 'show-prompt') return null;
  const resume = blocked.action === 'resume';
  return (
    <div className="agent-exit-banner" role="status" data-testid="agent-blocked-banner">
      {blocked.reason}
      <Button
        type="button"
        size="xs"
        variant="primary"
        loading={busy}
        onClick={(event) => {
          setProblem(undefined);
          if (resume) run(() => window.agentBoard.agents.resume(agent.sessionId));
          else if (chat) onShowTerminal();
          else if (!focusTerminal(event.currentTarget)) setProblem('the terminal is not attached yet');
        }}
      >
        {resume ? 'Resume' : 'Show prompt'}
      </Button>
      {(error ?? problem) && <ErrorText className="banner-error">{error ?? problem}</ErrorText>}
    </div>
  );
}

/**
 * What one tab of a window shows, by its kind: a shell tab's panes (the window's own, with the agent's
 * pane in an agent's), another agent's terminal, or a shell tile's panes. The keyboard goes to it while its pane has it.
 */
function SurfaceView({
  surface,
  panes,
  visible,
  shown,
  autoFocus,
  onPaneStatus,
  onProblem,
  agentPane,
  dragFrom,
}: {
  surface: WindowSurface;
  panes: WindowPanesControl;
  visible: boolean;
  /** Whether the window shows its body at all. */
  shown: boolean;
  autoFocus: boolean;
  onPaneStatus(sessionId: string, status: PaneStatus): void;
  onProblem(problem: string): void;
  agentPane?: { sessionId: string; label: string; content: ReactNode };
  dragFrom: ShellOwner | undefined;
}) {
  const keyboard = visible && panes.focusedPane.active.key === surface.key;
  const focused = panes.focusIn(surface) ?? '';
  // Showing another agent's session is seeing its ask, as its own window would be.
  useSeenWhileShown(surface.kind === 'agent' ? surface.agent.sessionId : undefined, shown && visible);
  const resize = (shellId: string) => (splitId: string, ratio: number) =>
    window.agentBoard.shells.resizeSplit(shellId, splitId, ratio).then(
      (resized) => panes.apply(resized),
      (error: unknown) => onProblem(`could not resize: ${errorMessage(error)}`),
    );
  if (surface.kind === 'agent') {
    const { agent } = surface;
    return (
      <TerminalPane
        key={`${agent.createdAt}/${agent.shellSessionId}`}
        sessionId={agent.shellSessionId ?? agent.sessionId}
        onStatus={(status) => onPaneStatus(agent.sessionId, status)}
        focused={keyboard}
        autoFocus={autoFocus}
        harness={agent.shellSessionId ? agent.shellHarness : agent.harness}
      />
    );
  }
  if (surface.kind === 'pr') return <PullRequestTab pr={surface.pr} visible={shown && visible} />;
  if (surface.kind === 'gate') return <GateTab sessionId={surface.gate.sessionId} agent={surface.agent} visible={shown && visible} />;
  if (surface.kind === 'doc') {
    const paneId = panes.panes.find((pane) => pane.surfaces.includes(surface))?.id;
    return (
      <DocTab
        doc={surface.doc}
        agent={surface.agent}
        visible={shown && visible}
        onFocus={() => paneId !== undefined && panes.focusPane(paneId)}
        onPaneKey={(key) => paneId !== undefined && panes.paneKey(paneId, key)}
      />
    );
  }
  if (surface.kind === 'plan') {
    const paneId = panes.panes.find((pane) => pane.surfaces.includes(surface))?.id;
    return (
      <PlanTab
        agent={surface.agent}
        visible={shown && visible}
        onFocus={() => paneId !== undefined && panes.focusPane(paneId)}
        onPaneKey={(key) => paneId !== undefined && panes.paneKey(paneId, key)}
      />
    );
  }
  if (surface.kind === 'document') {
    const paneId = panes.panes.find((pane) => pane.surfaces.includes(surface))?.id;
    return (
      <DocumentTab
        agent={surface.agent}
        document={surface.document}
        visible={shown && visible}
        onFocus={() => paneId !== undefined && panes.focusPane(paneId)}
        onPaneKey={(key) => paneId !== undefined && panes.paneKey(paneId, key)}
      />
    );
  }
  if (surface.kind === 'web') {
    const paneId = panes.panes.find((pane) => pane.surfaces.includes(surface))?.id;
    return (
      <WebTab
        web={surface.web}
        visible={shown && visible}
        servers={panes.localServers}
        keyboard={keyboard}
        autoFocus={autoFocus}
        onNavigate={(url) => panes.navigated({ ...surface.web, url })}
        onFocus={() => paneId !== undefined && panes.focusPane(paneId)}
        onPaneKey={(key) => paneId !== undefined && panes.paneKey(paneId, key)}
      />
    );
  }
  if (surface.kind === 'tile') {
    return <ShellPanes shell={surface.shell} focused={focused} onFocus={panes.focus} onStatus={onPaneStatus} autoFocus={autoFocus} active={keyboard} onResize={resize(surface.shell.id)} />;
  }
  const { tab } = surface;
  return (
    <ShellPanes
      shell={tab.shell ?? untabbedShell(tab.layout)}
      focused={focused}
      onFocus={panes.focus}
      onStatus={onPaneStatus}
      autoFocus={autoFocus}
      active={keyboard}
      onResize={tab.shell === undefined ? () => Promise.resolve() : resize(tab.shell.id)}
      agentPane={agentPane}
      dragFrom={dragFrom}
    />
  );
}

/**
 * The agent's own tab before the daemon keeps it (it is first split): the agent's pane alone, which no shell call
 * acts on.
 */
const untabbedShell = (layout: PaneLayout): Shell => ({
  id: '',
  zoneId: null,
  position: null,
  name: '',
  cwd: '',
  layout,
  paneFolders: {},
  endedPanes: [],
  stoppedPanes: [],
  exitCodes: {},
  busyPanes: [],
  panePorts: {},
  failedCommands: {},
  owner: null,
  tabOrder: null,
  createdAt: '',
});

function statusText({ state, ended, problem }: PaneStatus, agent: Agent | undefined): string {
  switch (state) {
    case 'attaching':
      return 'attaching…';
    case 'attached':
      if (agent?.shellSessionId != null) return endedShellLabel(agent);
      return agent ? STATE_LABELS[agent.state] : 'running';
    case 'exited':
      // An agent's own state says how it went: a stop and a clean exit are both just ended.
      if (agent?.state === 'hibernated') return 'paused';
      if (agent?.state === 'done') return 'ended';
      if (agent?.state === 'stopped-by-restart' || ended?.stoppedByRestart) return 'stopped by a restart';
      return `exited${ended?.exitCode == null ? '' : ` (${ended.exitCode})`}`;
    case 'detached':
      return 'lost connection to the daemon';
    case 'unavailable':
      return `could not open the session: ${problem}`;
  }
}
