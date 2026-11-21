import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { WINDOW_QUERY, type WindowTarget } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { HeldPromptsNotice } from '../inbox/Inbox';
import { SquareArrowDownLeft, X } from 'lucide-react';
import { PopUpSession, TicketPopupBody, type PopUpSplitting, type PopUpWindow } from '../board/AgentPopup';
import type { PopupSplit } from '../board/popup-split';
import { popUpHelpers } from '../board/agent-popup';
import { tokenNumber } from '../theme';
import { NO_TILE_ACTIONS, TileActionsContext } from '../board/tile';
import { tileNodeId } from '../board/tiles';
import { frostedClasses } from '../board/paused';
import { useNeedsYouShows } from '../needs-you-setting';
import { requestPopUpReview } from '../review/review-tab';
import { SessionWindow } from '../session/SessionWindow';
import { dropKey } from '../session/shell-moves';
import { requestTab } from '../session/tab-request';
import type { AttachState } from '../session/TerminalPane';
import { Button, useToast } from '../ui';
import { POP_OUT_DROPS, popOutActions } from './pop-out-actions';
import { withChange } from './live-agents';
import { keptLayout } from '../session/use-window-panes';
import { PopOutSpotlight } from './PopOutSpotlight';
import { useCheatSheet } from '../keys/CheatSheet';
import { ParkThought } from '../keys/ParkThought';
import { handOffWebTabs } from './SessionWindows';
import { usePopOutMoves } from './use-pop-out-moves';

/** A popped-out agent is its pop-up, and its cheat sheet opens on the pop-up's keys; a shell or tab window's on a session window's. */
const sheetContextOf = (kind: WindowTarget['kind']) => () => (kind === 'session' ? ('pop-up' as const) : ('window' as const));

/**
 * A session window popped out into its own OS window: the whole window, with a button to pop it back in; or a tab
 * window (slice 4). Tabs drag to and from it, the board making the moves.
 */
export function PopOutWindow({ target: opened }: { target: WindowTarget }) {
  // Its ⌘K switcher may show another session in it.
  const [target, setTarget] = useState(opened);
  useEffect(() => {
    document.title = target.title;
  }, [target.title]);
  const [moveProblem, setMoveProblem] = useState<string>();
  usePopOutMoves(setMoveProblem);
  const notice = <Notice problem={moveProblem} />;
  const switched = (to: WindowTarget) => {
    // A reload shows what it shows now.
    const query = new URLSearchParams(location.search);
    query.set(WINDOW_QUERY.popOut, to.id);
    query.set(WINDOW_QUERY.kind, to.kind);
    query.set(WINDOW_QUERY.title, to.title);
    history.replaceState(null, '', `${location.pathname}?${query}${location.hash}`);
    setTarget(to);
  };
  // ⌘/ opens the cheat sheet here too, on the session window's keys.
  const cheatSheet = useCheatSheet(useMemo(() => sheetContextOf(target.kind), [target.kind]));
  return (
    <>
      {target.kind === 'tabs' ? (
        <PoppedTabs target={target} notice={notice} />
      ) : target.kind === 'shell' ? (
        <PoppedShell key={target.id} target={target} notice={notice} />
      ) : (
        <PoppedSession key={target.id} target={target} notice={notice} />
      )}
      <PopOutSpotlight target={target} onSwitched={switched} />
      {cheatSheet.sheet}
      <ParkThought />
    </>
  );
}

/** Why something in the window went wrong, over its tabs; nothing while all is well. */
function Notice({ problem }: { problem: string | undefined }) {
  return (
    problem && (
      <p className="session-window-notice" role="alert">
        {problem}
      </p>
    )
  );
}

/** A popped-out window, and what it shows over its tabs besides its own notices: why a move couldn't be made. */
type PoppedProps = { target: WindowTarget; notice: ReactNode };

/** Keeps the OS window's title in step with the session's name, which can be renamed. */
function useWindowTitle(name: string | undefined) {
  useEffect(() => {
    if (name !== undefined) document.title = name;
  }, [name]);
}

/** Back to the board, its web tabs' pages going with it as they are. */
const popIn = (target: WindowTarget) => () => void handOffWebTabs(target).then(() => window.agentBoard.windows.popIn(target.id));

/**
 * A popped-out agent: its pop-up, in a window of its own, with the same header, tabs and sidebar views; its header holds
 * the OS window's traffic lights, Back to board and, in its ⋯, Close window. Until its agent is listed, a plain session
 * window. The board's Open review on it opens its Review view here.
 */
function PoppedSession({ target, notice }: PoppedProps) {
  const { id, title } = target;
  const { agent, agents } = useLiveAgents(id);
  useWindowTitle(agent?.name);
  useEffect(() => window.agentBoard.windows.onReviewAsked(() => requestPopUpReview(id)), [id]);
  if (agent !== undefined) return <PoppedAgent agent={agent} agents={agents} target={target} notice={notice} />;
  return (
    <SessionWindow
      content={{ kind: 'session', sessionId: id, agent }}
      title={title}
      placement="own-window"
      onClose={() => window.close()}
      onPopIn={popIn(target)}
      notice={
        <>
          {notice}
          {agent && <HeldPromptsNotice agent={agent} />}
        </>
      }
    />
  );
}

/**
 * The pop-up of a popped-out agent, filling its window, its menu doing in the window what it can and asking the board
 * the rest: a ticket's chat with its helpers' tabs and its Board view, as its pop-up on the board has.
 */
function PoppedAgent({ agent, agents, target, notice }: PoppedProps & { agent: Agent; agents: readonly Agent[] }) {
  const root = useRef<HTMLElement>(null);
  const [attach, setAttach] = useState<AttachState>('attaching');
  // Two agents side by side, as in the pop-up; the window is already all its own, so a split fills it as it is.
  const [split, setSplit] = useState<PopupSplit>();
  const shows = useNeedsYouShows();
  const toast = useToast();
  const nodeId = tileNodeId('agent', agent.sessionId);
  const report = useMemo(() => (action: string) => (error: unknown) => toast.show({ tone: 'error', message: `Could not ${action}: ${errorMessage(error)}` }), [toast]);
  const actions = useMemo(
    () =>
      popOutActions(NO_TILE_ACTIONS, {
        api: window.agentBoard,
        sessionId: agent.sessionId,
        requestTab,
        requestReviewTab: requestPopUpReview,
        report,
      }),
    [report, agent.sessionId],
  );
  const helpers = popUpHelpers(agent, agents);
  const others = usePoppedOut().filter((id) => id !== agent.sessionId);
  const splitting: PopUpSplitting = { split, onSplit: setSplit, agents, popped: others };
  const board = useMemo(() => ({ agents, desk: { gap: tokenNumber('--desk-dot-gap'), size: tokenNumber('--desk-dot-size') }, onError: report }), [agents, report]);
  const own: PopUpWindow = {
    buttons: (
      <Button size="sm" icon={<SquareArrowDownLeft />} onClick={popIn(target)}>
        Back to board
      </Button>
    ),
    menuEnd: [{ label: 'Close window', icon: <X />, onSelect: () => window.close() }],
    drops: POP_OUT_DROPS,
    notice: (
      <>
        {notice}
        <HeldPromptsNotice agent={agent} />
      </>
    ),
    onAttachState: setAttach,
  };
  return (
    <TileActionsContext value={actions}>
      <section
        ref={root}
        className={frostedClasses('agent-popup agent-popup-own-window', agent, shows)}
        data-testid="session-window"
        data-session-id={agent.sessionId}
        // A tab, pane or shell tile dropped on it, header too, joins its tabs: as a session window's.
        data-tab-drop={dropKey({ kind: 'agent', id: agent.sessionId })}
        data-state={attach}
        data-ticket={helpers !== undefined || undefined}
      data-split={split !== undefined || undefined}
        aria-label={`${agent.name}, popped out`}
      >
        {helpers === undefined ? (
          <PopUpSession agent={agent} nodeId={nodeId} onClose={() => window.close()} root={root} splitting={splitting} window={own} />
        ) : (
          <TicketPopupBody chat={agent} helpers={helpers} on={undefined} popped={others} nodeId={nodeId} onClose={() => window.close()} root={root} board={board} splitting={splitting} window={own} />
        )}
      </section>
    </TileActionsContext>
  );
}

function PoppedShell({ target, notice }: PoppedProps) {
  const { id, title } = target;
  const { shell, problem } = useLiveShell(id);
  useWindowTitle(shell?.name);
  return (
    <SessionWindow
      content={{ kind: 'shell', shellId: id, shell }}
      title={title}
      placement="own-window"
      onClose={() => window.close()}
      onPopIn={popIn(target)}
      notice={
        <>
          {notice}
          <Notice problem={problem} />
        </>
      }
    />
  );
}

/**
 * A tab window (slice 4): the pull request, web and session tabs dragged out of windows on their own, laid out
 * as any window's. It closes once its last tab leaves; closed, it takes its tabs with it.
 */
function PoppedTabs({ target: { id, title }, notice }: PoppedProps) {
  useTabWindowLayout(id);
  return <SessionWindow content={{ kind: 'tabs', id }} title={title} placement="own-window" onClose={() => window.close()} notice={notice} />;
}

/**
 * Closes the tab window once it has no tab left: its last moved out, or none kept for it (since a restart, say). Closed
 * by the user (Close window, or the OS window's own close), it forgets its tabs as it last showed them: a tab moved
 * into it as it closes (a redo) keeps it, and the board shows it again.
 */
function useTabWindowLayout(id: string): void {
  useEffect(() => {
    const owner = { kind: 'tabs', id } as const;
    let heard = false;
    const unsubscribe = window.agentBoard.shells.onWindowLayout((change) => {
      if (change.owner.kind !== 'tabs' || change.owner.id !== id) return;
      heard = true;
      if (change.layout === null) window.close();
    });
    window.agentBoard.shells.windowLayout(owner).then(
      (layout) => {
        if (!heard && layout === null) window.close();
      },
      () => {},
    );
    // One call, sent as the page goes: the layout as this window last kept or heard it.
    const forget = () => {
      const shown = keptLayout(owner);
      if (shown != null) void window.agentBoard.shells.forgetWindow(owner, shown).catch(() => false);
    };
    window.addEventListener('beforeunload', forget);
    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', forget);
    };
  }, [id]);
}

/**
 * The session's agent and every agent, kept live: undefined until the list arrives (and for a shell session). Closes
 * the window when its agent is deleted. A change that lands while the list is in flight is newer than it; without the
 * list, the window knows what has changed since.
 */
function useLiveAgents(sessionId: string): { agent: Agent | undefined; agents: readonly Agent[] } {
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  useEffect(() => {
    let listed: readonly Agent[] | undefined;
    const early = new Map<string, Agent | null>();
    const show = (list: readonly Agent[]) => {
      listed = list;
      setAgents(list);
    };
    const unsubscribe = window.agentBoard.agents.onChanged((change) => {
      const id = change.type === 'agent.updated' ? change.agent.sessionId : change.sessionId;
      // The agent was deleted, perhaps from the CLI or by an orchestrator: nothing is left to show.
      if (change.type === 'agent.removed' && id === sessionId) return void window.close();
      const now = change.type === 'agent.updated' ? change.agent : null;
      if (listed === undefined) early.set(id, now);
      else show(withChange(listed, id, now));
    });
    const settle = (list: readonly Agent[]) => show([...early].reduce((each, [id, now]) => withChange(each, id, now), list));
    window.agentBoard.agents.list().then(settle, () => settle([]));
    return unsubscribe;
  }, [sessionId]);
  return { agent: agents.find((known) => known.sessionId === sessionId), agents };
}

/** The sessions popped out into windows of their own, read as the window opens and each time it comes forward. */
function usePoppedOut(): readonly string[] {
  const [popped, setPopped] = useState<readonly string[]>([]);
  useEffect(() => {
    const read = () => void window.agentBoard.windows.poppedOut().then(setPopped, () => {});
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, []);
  return popped;
}

/**
 * The shell tile, kept live: undefined until it is listed, with why if listing it failed. Closes the window when the
 * tile goes, or becomes another's tab.
 */
function useLiveShell(shellId: string): { shell: Shell | undefined; problem: string | undefined } {
  const [shell, setShell] = useState<Shell>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    let changed = false;
    const unsubscribe = window.agentBoard.shells.onChanged((change) => {
      if (change.type === 'shell.removed') {
        if (change.shellId === shellId) window.close();
        return;
      }
      if (change.shell.id !== shellId) return;
      // Become another's tab (its only tab dragged into another window): it has no window of its own any more.
      if (change.shell.owner !== null) {
        window.close();
        return;
      }
      changed = true;
      setShell(change.shell);
      setProblem(undefined);
    });
    window.agentBoard.shells.list().then(
      (shells) => {
        if (changed) return;
        const found = shells.find((known) => known.id === shellId);
        if (found === undefined || found.owner !== null) window.close();
        else setShell(found);
      },
      (error: unknown) => {
        if (!changed) setProblem(`could not load the shell's panes: ${errorMessage(error)}`);
      },
    );
    return unsubscribe;
  }, [shellId]);
  return { shell, problem };
}
