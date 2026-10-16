import { useEffect, useState, type ReactNode } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { WINDOW_QUERY, type WindowTarget } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { HeldPromptsNotice } from '../inbox/Inbox';
import { SessionWindow } from '../session/SessionWindow';
import { keptLayout } from '../session/use-window-panes';
import { PopOutSpotlight } from './PopOutSpotlight';
import { handOffWebTabs } from './SessionWindows';
import { usePopOutMoves } from './use-pop-out-moves';

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

function PoppedSession({ target, notice }: PoppedProps) {
  const { id, title } = target;
  const agent = useLiveAgent(id);
  useWindowTitle(agent?.name);
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

/** The session's agent, kept live; undefined for a shell session (or until the list arrives). Closes the window when the agent is deleted. */
function useLiveAgent(sessionId: string): Agent | undefined {
  const [agent, setAgent] = useState<Agent>();
  useEffect(() => {
    let changed = false;
    const unsubscribe = window.agentBoard.agents.onChanged((change) => {
      if ((change.type === 'agent.updated' ? change.agent.sessionId : change.sessionId) !== sessionId) return;
      if (change.type === 'agent.removed') {
        // The agent was deleted, perhaps from the CLI or by an orchestrator: nothing is left to show.
        window.close();
        return;
      }
      changed = true;
      setAgent(change.agent);
    });
    // A change that lands while the list is in flight is newer than it. Without the list, the window is a plain
    // session's until the agent's next change.
    window.agentBoard.agents.list().then(
      (agents) => {
        if (!changed) setAgent(agents.find((known) => known.sessionId === sessionId));
      },
      () => {},
    );
    return unsubscribe;
  }, [sessionId]);
  return agent;
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
