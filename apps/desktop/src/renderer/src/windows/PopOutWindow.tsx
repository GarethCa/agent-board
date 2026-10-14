import { useEffect, useState } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import type { WindowTarget } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { HeldPromptsNotice } from '../inbox/Inbox';
import { SessionWindow } from '../session/SessionWindow';

/** A session window popped out into its own OS window: the whole window, with a button to pop it back in. */
export function PopOutWindow({ target }: { target: WindowTarget }) {
  useEffect(() => {
    document.title = target.title;
  }, [target.title]);
  return target.kind === 'shell' ? <PoppedShell target={target} /> : <PoppedSession target={target} />;
}

/** Keeps the OS window's title in step with the session's name, which can be renamed. */
function useWindowTitle(name: string | undefined) {
  useEffect(() => {
    if (name !== undefined) document.title = name;
  }, [name]);
}

const popIn = (id: string) => () => void window.agentBoard.windows.popIn(id);

function PoppedSession({ target: { id, title } }: { target: WindowTarget }) {
  const agent = useLiveAgent(id);
  useWindowTitle(agent?.name);
  return (
    <SessionWindow
      content={{ kind: 'session', sessionId: id, agent }}
      title={title}
      placement="own-window"
      onClose={() => window.close()}
      onPopIn={popIn(id)}
      notice={agent && <HeldPromptsNotice agent={agent} />}
    />
  );
}

function PoppedShell({ target: { id, title } }: { target: WindowTarget }) {
  const { shell, problem } = useLiveShell(id);
  useWindowTitle(shell?.name);
  return (
    <SessionWindow
      content={{ kind: 'shell', shellId: id, shell }}
      title={title}
      placement="own-window"
      onClose={() => window.close()}
      onPopIn={popIn(id)}
      notice={
        problem && (
          <p className="session-window-notice" role="alert">
            {problem}
          </p>
        )
      }
    />
  );
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

/** The shell tile, kept live: undefined until it is listed, with why if listing it failed. Closes the window when the tile goes. */
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
      changed = true;
      setShell(change.shell);
      setProblem(undefined);
    });
    window.agentBoard.shells.list().then(
      (shells) => {
        if (changed) return;
        const found = shells.find((known) => known.id === shellId);
        if (found === undefined) window.close();
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
