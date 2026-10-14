import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Agent, SessionInfo, Shell } from '@agent-board/daemon/protocol';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { SquareArrowOutUpRight } from 'lucide-react';
import { useBoardCommands } from './board/commands';
import { HarnessMark } from './board/HarnessMark';
import { errorMessage } from '../../shared/errors';
import { HARNESSES } from './harness';
import { STATE_LABELS, TILE_STATE_LABELS } from './states';
import { Button, EmptyState, PanelRow, Section, StatusPill, Tag, Tooltip, useToast } from './ui';
import { useSessionWindows } from './windows/SessionWindows';
import { panesLabel } from './session/panes';
import { liveShellCount } from './session/tabs';

interface SessionsProps {
  agents: readonly Agent[];
  /** Undefined until the board has listed them. */
  shells: readonly Shell[] | undefined;
  /** Narrows the rows to those whose name holds it. */
  filter?: string;
  /** Hears that a row was picked, so the menu can close. */
  onPicked?(): void;
  onOpenAgent(agent: Agent): void;
  onOpenShell(shell: Shell): void;
}

/**
 * The board menu's agents and running shells: each agent by name with its state, each shell tile with a live pane,
 * and any other session the daemon runs. Clicking a row shows its tile; Open opens its window on the board.
 */
export function Sessions({ agents, shells = [], filter = '', onPicked, onOpenAgent, onOpenShell }: SessionsProps) {
  const sessions = useLiveSessions();
  const windows = useSessionWindows();
  const board = useBoardCommands();
  // A tab is its owner's: an agent's window opens on it, or its shell tile's, listed while any of the tile's shells runs.
  const liveShells = shells.filter((shell) => !shell.owner && liveShellCount({ kind: 'shell', shell }, shells) > 0);
  // Sessions the board has no tile for: say, an agent's session it hasn't listed yet.
  const known = new Set([...agents.map((agent) => agent.sessionId), ...shells.flatMap((shell) => paneIds(shell.layout))]);
  const others = sessions.filter((session) => !known.has(session.id));

  const wanted = filter.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(wanted);
  const shownAgents = agents.filter((agent) => matches(agent.name));
  const shownShells = liveShells.filter((shell) => matches(shell.name));
  const shownOthers = others.filter((session) => matches(sessionTitle(session)));
  const picked = (act: () => void) => () => {
    onPicked?.();
    act();
  };
  const count = agents.length + liveShells.length + others.length;

  return (
    <Section label="Agents and shells" meta={count === 0 ? 'None' : `${agents.length} agents · ${liveShells.length + others.length} shells`}>
      {shownAgents.length + shownShells.length + shownOthers.length === 0 ? (
        <EmptyState framed={false} title={count === 0 ? 'Nothing running' : 'Nothing matches'}>
          {count === 0 ? 'Agents and shells you start show here.' : undefined}
        </EmptyState>
      ) : (
        <ul className="board-menu-list">
          {shownAgents.map((agent) => (
            <Row
              key={agent.sessionId}
              testId="agent-item"
              id={agent.sessionId}
              mark={<HarnessMark harness={agent.harness} />}
              name={agent.name}
              end={<StatusPill state={agent.state} label={TILE_STATE_LABELS[agent.state]} title={STATE_LABELS[agent.state]} />}
              onShow={picked(() => board.focusSession(agent.sessionId))}
              onOpen={picked(() => onOpenAgent(agent))}
            />
          ))}
          {shownShells.map((shell) => (
            <Row
              key={shell.id}
              testId="session-item"
              id={shell.id}
              mark={<HarnessMark harness="shell" />}
              name={shell.name}
              end={<Tag>{panesLabel(paneIds(shell.layout).length)}</Tag>}
              onShow={picked(() => board.focusSession(paneIds(shell.layout)[0]!))}
              onOpen={picked(() => onOpenShell(shell))}
            />
          ))}
          {shownOthers.map((session) => (
            <Row
              key={session.id}
              testId="session-item"
              id={session.id}
              mark={<HarnessMark harness={session.harness ?? 'shell'} />}
              name={sessionTitle(session)}
              onShow={picked(() => board.focusSession(session.id))}
              onOpen={picked(() => windows.show({ kind: 'session', id: session.id, title: sessionTitle(session) }))}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function Row({ testId, id, mark, name, end, onShow, onOpen }: { testId: string; id: string; mark: ReactNode; name: string; end?: ReactNode; onShow(): void; onOpen(): void }) {
  return (
    <li className="board-menu-session" data-testid={testId} data-id={id}>
      <Tooltip content="Show its tile on the board">
        <PanelRow as="button" mark={mark} name={name} end={end} onClick={onShow} />
      </Tooltip>
      <Button size="sm" variant="ghost" icon={<SquareArrowOutUpRight />} onClick={onOpen}>
        Open
      </Button>
    </li>
  );
}

/** The sessions the daemon runs, kept up to date as they start and end. */
function useLiveSessions(): SessionInfo[] {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const toasts = useToast();
  const refresh = useCallback(
    () =>
      window.agentBoard.sessions.list().then(setSessions, (failure: unknown) =>
        toasts.show({ id: 'sessions', tone: 'error', message: `Could not list the sessions: ${errorMessage(failure)}` }),
      ),
    [toasts],
  );
  useEffect(() => {
    void refresh();
    // A session can end with no window open: killed elsewhere, or its process gone.
    return window.agentBoard.sessions.onExited(() => void refresh());
  }, [refresh]);
  // A new shell's or agent's session shows up when the board's lists change.
  useEffect(() => window.agentBoard.shells.onChanged(() => void refresh()), [refresh]);
  useEffect(() => window.agentBoard.agents.onChanged(() => void refresh()), [refresh]);
  return sessions;
}

function sessionTitle(session: SessionInfo): string {
  return `${session.harness === null ? 'Shell' : HARNESSES[session.harness].label} · ${session.cwd}`;
}
