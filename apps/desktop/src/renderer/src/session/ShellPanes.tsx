import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Shell, ShellOwner } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { ResumeButton } from '../board/RestartBanner';
import { paneLabel } from '../board/rename';
import { TileActionsContext } from '../board/tile';
import { EditableName, RenameButton, useRenaming } from '../ui';
import { bySession, type Rect } from './pane-geometry';
import { Dividers, useDividerDrag } from './use-divider-drag';
import { TerminalPane, type PaneStatus } from './TerminalPane';
import { endDrag, startDrag as startTabDrag, type TabDrag } from './shell-moves';

interface ShellPanesProps {
  shell: Shell;
  /** The pane with the keyboard. */
  focused: string;
  onFocus(sessionId: string): void;
  onStatus(sessionId: string, status: PaneStatus): void;
  /** Saves where a divider was left; settles once the saved layout is in (or saving failed). */
  onResize(splitId: string, ratio: number): Promise<void>;
  /** Whether the focused pane takes the keyboard as it mounts (`TerminalPane`). True by default. */
  autoFocus?: boolean;
  /** Whether these panes are showing: a tab in the background has none with the keyboard. True by default. */
  active?: boolean;
  /**
   * The agent's own pane, in an agent's own tab: what it shows (its terminal or chat) and what its header
   * calls it, in place of a shell pane.
   */
  agentPane?: { sessionId: string; label: string; content: ReactNode };
  /**
   * The window the panes are in, when a shell pane can be dragged out of its split by its header (AT2): to a
   * window's tab strip, or onto the board. Unset where nothing drags.
   */
  dragFrom?: ShellOwner;
}

const percent = (fraction: number) => `${fraction * 100}%`;

const boxStyle = ({ x, y, width, height }: Rect) => ({ left: percent(x), top: percent(y), width: percent(width), height: percent(height) });

/**
 * A shell tile's panes, tmux-style. They are laid out flat, each in its own box, and keyed by session, so splitting one
 * never re-mounts the others' terminals. A dragged divider moves alone, as a guide line; the panes take their new
 * sizes once it is let go, so their shells are resized once, not on every pointer move.
 */
export function ShellPanes({ shell, focused, onFocus, onStatus, onResize, autoFocus = true, active = true, agentPane, dragFrom }: ShellPanesProps) {
  const container = useRef<HTMLDivElement>(null);
  const { geometry: live, dividers } = useDividerDrag(container, shell.layout, bySession, onResize);

  return (
    <div className="shell-panes" ref={container} data-testid="shell-panes" data-panes={live.panes.length}>
      {live.panes.map(({ id: sessionId, rect }) => (
        <div
          key={sessionId}
          className="shell-pane"
          data-testid="shell-pane"
          data-session-id={sessionId}
          data-focused={active && sessionId === focused}
          data-agent={sessionId === agentPane?.sessionId || undefined}
          style={boxStyle(rect)}
          onMouseDownCapture={() => onFocus(sessionId)}
          onFocusCapture={() => onFocus(sessionId)}
          data-headed={live.panes.length > 1 || undefined}
        >
          {live.panes.length > 1 &&
            (sessionId === agentPane?.sessionId ? (
              <div className="shell-pane-head" data-testid="shell-pane-head">
                <span className="shell-pane-name">{agentPane.label}</span>
              </div>
            ) : (
              <PaneHeader shell={shell} sessionId={sessionId} dragFrom={dragFrom} />
            ))}
          {sessionId === agentPane?.sessionId ? (
            agentPane.content
          ) : shell.stoppedPanes.includes(sessionId) ? (
            // Keyed apart from the live pane, so a resumed pane attaches to its new shell afresh.
            <StoppedPane key="stopped" shellId={shell.id} sessionId={sessionId} focused={active && sessionId === focused} autoFocus={autoFocus} onStatus={onStatus} />
          ) : (
            <Pane
              key="pane"
              shellId={shell.id}
              sessionId={sessionId}
              ended={shell.endedPanes.includes(sessionId)}
              focused={active && sessionId === focused}
              autoFocus={autoFocus}
              onStatus={onStatus}
            />
          )}
        </div>
      ))}
      <Dividers {...dividers} />
    </div>
  );
}

/**
 * The header of a pane in a shell split into several: the label the user gave it, or the shell's name when it has
 * none. A double-click or the pencil edits it; clearing it goes back to the shell's name.
 */
function PaneHeader({ shell, sessionId, dragFrom }: { shell: Shell; sessionId: string; dragFrom: ShellOwner | undefined }) {
  const { rename } = useContext(TileActionsContext);
  const label = paneLabel(shell, sessionId);
  const renaming = useRenaming(label ?? '', (name) => rename({ kind: 'pane', shellId: shell.id, sessionId }, name), true);
  // Dragged by its header, as a tab is, while it isn't being renamed.
  const drags = dragFrom !== undefined && !renaming.editing;
  const drag: TabDrag | undefined = dragFrom === undefined ? undefined : { kind: 'pane', shellId: shell.id, sessionId, from: dragFrom };
  return (
    <div
      className={drags ? 'shell-pane-head nodrag' : 'shell-pane-head'}
      data-testid="shell-pane-head"
      draggable={drags}
      title={drags ? 'Drag to another window’s tabs, or onto the board' : undefined}
      onDragStart={drags && drag ? (event) => startTabDrag(event, drag, label ?? shell.name) : undefined}
      onDragEnd={drags && drag ? (event) => endDrag(event, drag) : undefined}
    >
      <EditableName
        className="shell-pane-name"
        value={label ?? shell.name}
        initial={label ?? ''}
        placeholder={shell.name}
        renaming={renaming}
        label="Pane name"
        title={label === undefined ? 'Double-click to label this pane' : undefined}
      />
      <RenameButton renaming={renaming} label="Rename pane" />
    </div>
  );
}

/**
 * A pane whose shell ended because the daemon went away (a restart): its last output, as the daemon saved it, and a
 * button that starts a new shell where the old one was.
 */
function StoppedPane({
  shellId,
  sessionId,
  focused,
  autoFocus,
  onStatus,
}: {
  shellId: string;
  sessionId: string;
  focused: boolean;
  autoFocus: boolean;
  onStatus: ShellPanesProps['onStatus'];
}) {
  const [problem, setProblem] = useState<string>();
  return (
    <>
      <TerminalPane sessionId={sessionId} focused={focused} autoFocus={autoFocus} onStatus={(next) => onStatus(sessionId, next)} />
      <div className="shell-pane-banner shell-pane-stopped" role="status" data-testid="shell-pane-stopped">
        {problem ?? 'Stopped by a restart'}
        {/* Its problem said here: a popped-out window has no board to report it. */}
        <ResumeButton
          onResume={() =>
            window.agentBoard.shells.resumePane(shellId, sessionId).then(
              () => {},
              (error: unknown) => setProblem(`Could not resume: ${errorMessage(error)}`),
            )
          }
        />
      </div>
    </>
  );
}

/**
 * One pane. A pane that had already ended when it appeared (its shell exited before a daemon restart) has nothing to
 * attach to; one that ends in front of the user keeps its terminal, and says so. Either can restart its shell.
 */
function Pane({
  shellId,
  sessionId,
  ended,
  focused,
  autoFocus,
  onStatus,
}: {
  shellId: string;
  sessionId: string;
  ended: boolean;
  focused: boolean;
  autoFocus: boolean;
  onStatus: ShellPanesProps['onStatus'];
}) {
  const [endedAtStart, setEndedAtStart] = useState(ended);
  const [status, setStatus] = useState<PaneStatus>({ state: 'attaching' });
  /** How many times its shell was restarted here: its terminal attaches afresh each time. */
  const [restarts, setRestarts] = useState(0);
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (endedAtStart) onStatus(sessionId, { state: 'exited' });
  }, [endedAtStart, sessionId, onStatus]);
  // Its problem said here: a popped-out window has no board to report it.
  const restart = (
    <ResumeButton
      label="Restart shell"
      testId="restart-shell"
      onResume={() =>
        window.agentBoard.shells.resumePane(shellId, sessionId).then(
          () => {
            setProblem(undefined);
            setEndedAtStart(false);
            setStatus({ state: 'attaching' });
            setRestarts((count) => count + 1);
          },
          (error: unknown) => setProblem(`Could not restart: ${errorMessage(error)}`),
        )
      }
    />
  );
  if (endedAtStart) {
    return (
      <div className="shell-pane-ended shell-pane-stopped" data-testid="shell-pane-ended">
        {problem ?? 'This pane has ended.'}
        {restart}
      </div>
    );
  }
  return (
    <>
      <TerminalPane
        key={restarts}
        sessionId={sessionId}
        focused={focused}
        autoFocus={autoFocus}
        onStatus={(next) => {
          setStatus(next);
          onStatus(sessionId, next);
        }}
      />
      {status.state === 'exited' && (
        <div className="shell-pane-banner shell-pane-stopped" role="status">
          {problem ?? `exited${status.ended?.exitCode == null ? '' : ` (${status.ended.exitCode})`}`}
          {restart}
        </div>
      )}
    </>
  );
}
