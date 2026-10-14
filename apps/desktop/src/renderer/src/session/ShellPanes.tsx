import { useContext, useEffect, useRef, useState, type PointerEvent } from 'react';
import { setSplitRatio } from '@agent-board/daemon/pane-layout';
import type { Shell } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { ResumeButton } from '../board/RestartBanner';
import { paneLabel } from '../board/rename';
import { TileActionsContext } from '../board/tile';
import { EditableName, RenameButton, useRenaming } from '../ui';
import { paneGeometry, ratioAt, type Divider, type Rect } from './pane-geometry';
import { TerminalPane, type PaneStatus } from './TerminalPane';

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
}

const percent = (fraction: number) => `${fraction * 100}%`;

const boxStyle = ({ x, y, width, height }: Rect) => ({ left: percent(x), top: percent(y), width: percent(width), height: percent(height) });

/**
 * A shell tile's panes, tmux-style. They are laid out flat, each in its own box, and keyed by session, so splitting one
 * never re-mounts the others' terminals. A dragged divider moves alone, as a guide line; the panes take their new
 * sizes once it is let go, so their shells are resized once, not on every pointer move.
 */
export function ShellPanes({ shell, focused, onFocus, onStatus, onResize, autoFocus = true }: ShellPanesProps) {
  const container = useRef<HTMLDivElement>(null);
  /** The divider being dragged and where it is; `released` once let go, until the saved layout replaces it. */
  const [drag, setDrag] = useState<{ splitId: string; ratio: number; released: boolean }>();
  /** Takes the drag's listeners off the window, while there is a drag. */
  const endDrag = useRef<() => void>(undefined);
  useEffect(() => () => endDrag.current?.(), []);
  const saved = paneGeometry(shell.layout);
  // A divider gone meanwhile (its pane closed elsewhere) drags nothing.
  const current = drag && saved.dividers.some((divider) => divider.splitId === drag.splitId) ? drag : undefined;
  const live = current?.released ? paneGeometry(setSplitRatio(shell.layout, current.splitId, current.ratio)) : saved;
  const dividers = live.dividers.map((divider) => (divider.splitId === current?.splitId ? { ...divider, ratio: current.ratio } : divider));

  /**
   * Follows the pointer from a divider until it is let go, with listeners on the window: nothing under the pointer
   * (a terminal, the board) can swallow the drag, and it carries on outside the panes.
   */
  const startDrag = (divider: Divider, down: PointerEvent) => {
    if (down.button !== 0) return;
    down.preventDefault();
    endDrag.current?.();
    const ratioFor = (event: { clientX: number; clientY: number }) => {
      const box = container.current!.getBoundingClientRect();
      return ratioAt(divider, { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
    };
    const onMove = (event: globalThis.PointerEvent) => setDrag({ splitId: divider.splitId, ratio: ratioFor(event), released: false });
    const onUp = (event: globalThis.PointerEvent) => {
      const ratio = ratioFor(event);
      stop();
      // Held where it was let go until the saved layout replaces it, so it doesn't snap back meanwhile.
      setDrag({ splitId: divider.splitId, ratio, released: true });
      void onResize(divider.splitId, ratio).finally(() => setDrag(undefined));
    };
    const onCancel = () => {
      stop();
      setDrag(undefined);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      endDrag.current = undefined;
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    endDrag.current = stop;
  };

  return (
    <div className="shell-panes" ref={container} data-testid="shell-panes" data-panes={live.panes.length}>
      {live.panes.map(({ sessionId, rect }) => (
        <div
          key={sessionId}
          className="shell-pane"
          data-testid="shell-pane"
          data-session-id={sessionId}
          data-focused={sessionId === focused}
          style={boxStyle(rect)}
          onMouseDownCapture={() => onFocus(sessionId)}
          onFocusCapture={() => onFocus(sessionId)}
          data-headed={live.panes.length > 1 || undefined}
        >
          {live.panes.length > 1 && <PaneHeader shell={shell} sessionId={sessionId} />}
          {shell.stoppedPanes.includes(sessionId) ? (
            // Keyed apart from the live pane, so a resumed pane attaches to its new shell afresh.
            <StoppedPane key="stopped" shellId={shell.id} sessionId={sessionId} focused={sessionId === focused} autoFocus={autoFocus} onStatus={onStatus} />
          ) : (
            <Pane
              key="pane"
              shellId={shell.id}
              sessionId={sessionId}
              ended={shell.endedPanes.includes(sessionId)}
              focused={sessionId === focused}
              autoFocus={autoFocus}
              onStatus={onStatus}
            />
          )}
        </div>
      ))}
      {dividers.map((divider) => {
        const side = divider.direction === 'horizontal';
        const at = side ? divider.region.x + divider.region.width * divider.ratio : divider.region.y + divider.region.height * divider.ratio;
        return (
          <div
            key={divider.splitId}
            className="shell-divider"
            data-testid="shell-divider"
            data-dragging={divider.splitId === current?.splitId && !current.released}
            data-direction={divider.direction}
            data-ratio={divider.ratio}
            role="separator"
            aria-orientation={side ? 'vertical' : 'horizontal'}
            style={
              side
                ? { left: percent(at), top: percent(divider.region.y), height: percent(divider.region.height) }
                : { top: percent(at), left: percent(divider.region.x), width: percent(divider.region.width) }
            }
            onPointerDown={(event) => startDrag(divider, event)}
          />
        );
      })}
    </div>
  );
}

/**
 * The header of a pane in a shell split into several: the label the user gave it, or the shell's name when it has
 * none. A double-click or the pencil edits it; clearing it goes back to the shell's name.
 */
function PaneHeader({ shell, sessionId }: { shell: Shell; sessionId: string }) {
  const { rename } = useContext(TileActionsContext);
  const label = paneLabel(shell, sessionId);
  const renaming = useRenaming(label ?? '', (name) => rename({ kind: 'pane', shellId: shell.id, sessionId }, name), true);
  return (
    <div className="shell-pane-head" data-testid="shell-pane-head">
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
