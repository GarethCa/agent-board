import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import { WINDOW_QUERY, windowTargetFrom, type WindowTarget } from '../../../preload/api';
import { VIEW_KEYS, viewSaver } from '../../../shared/view-saver';
import { HeldPromptsNotice } from '../inbox/Inbox';
import { SquareArrowOutUpRight, X } from 'lucide-react';
import { needsYou } from '../../../shared/needs-you';
import { HarnessMark } from '../board/HarnessMark';
import { Button, IconButton, Island, StatusPill, useToast } from '../ui';
import { SessionWindow, type WindowNav } from '../session/SessionWindow';
import type { WindowContent } from '../session/SessionBody';
import {
  closeWindow,
  minimiseWindow,
  popInWindow,
  popOutWindow,
  poppedOut,
  restoreWindows,
  showWindow,
  shownWindow,
  switchWindow,
  type SessionWindowEntry,
  type SessionWindows as Windows,
} from './session-windows';
import { sessionNav, type NavSession } from './session-nav';
import { frameFrom, type SavedFrame } from './window-frame';

interface SessionWindowsValue {
  windows: Windows;
  /** Whether the windows saved from the last run have been taken back yet. */
  restored: boolean;
  /** Shows the target's window, opening it; a popped-out one is brought forward instead. */
  show(target: WindowTarget): void;
  minimise(id: string): void;
  close(id: string): void;
  popOut(target: WindowTarget): void;
  /** Shows the target in the window `fromId` instead; a popped-out target is left where it is. */
  switchTo(fromId: string, target: WindowTarget): void;
}

const SessionWindowsContext = createContext<SessionWindowsValue | null>(null);

/** The board's session windows, for anything that opens one. */
export function useSessionWindows(): SessionWindowsValue {
  const value = use(SessionWindowsContext);
  if (value === null) throw new Error('useSessionWindows needs a SessionWindowsProvider');
  return value;
}

/** The board's windows when it opens: one shown if main opened the board for it (a pop-in with the board closed). */
function initialWindows(): Windows {
  const target = windowTargetFrom(new URLSearchParams(location.search), WINDOW_QUERY.show);
  return target === undefined ? [] : showWindow([], target);
}

/** How long the windows must stay put before where they are gets saved. */
const SAVE_WINDOWS_DELAY_MS = 200;

/**
 * Holds where every session window is, and hears when a popped-out one comes back or is closed. The windows are saved
 * as they change, and taken back when the board opens: popped-out ones are popped out again.
 */
export function SessionWindowsProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<Windows>(initialWindows);
  /** Whether the saved windows have been taken back, after which every change is saved. */
  const [restored, setRestored] = useState(false);
  /** The windows as last rendered, for what runs later: the restore, and the actions below. */
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const saveWindows = useMemo(() => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.windows, value), SAVE_WINDOWS_DELAY_MS), []);
  useEffect(() => {
    let cancelled = false;
    window.agentBoard.view
      .get(VIEW_KEYS.windows)
      .catch(() => null)
      .then((saved) => {
        if (cancelled) return;
        // On top of what is open now: a window may have been shown while the saved list was on its way.
        const before = windowsRef.current;
        const windows = restoreWindows(saved, before);
        setWindows((current) => restoreWindows(saved, current));
        // Those saved as popped out open again; one still out (the board was closed, not the app) is left where it is.
        for (const entry of windows) {
          if (entry.placement === 'popped' && !before.some((known) => known.id === entry.id)) {
            void window.agentBoard.windows.popOut(entry, { reveal: false });
          }
        }
        setRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (restored) saveWindows(windows);
  }, [restored, saveWindows, windows]);
  useEffect(
    () =>
      window.agentBoard.windows.onReturned((target, how) =>
        setWindows((current) => (how === 'popIn' ? popInWindow(current, target) : closeWindow(current, target.id))),
      ),
    [],
  );
  // Stable, so what opens windows (every tile) doesn't re-render each time one moves.
  const actions = useMemo<Omit<SessionWindowsValue, 'windows' | 'restored'>>(
    () => ({
      show(target) {
        // Already out: bring its OS window forward.
        const popped = windowsRef.current.some((entry) => entry.id === target.id && entry.placement === 'popped');
        if (popped) void window.agentBoard.windows.popOut(target);
        else setWindows((current) => showWindow(current, target));
      },
      minimise: (id) => setWindows((current) => minimiseWindow(current, id)),
      close(id) {
        // A popped-out one closes its OS window, and hears back that it went.
        const popped = windowsRef.current.some((entry) => entry.id === id && entry.placement === 'popped');
        if (popped) void window.agentBoard.windows.close(id);
        setWindows((current) => closeWindow(current, id));
      },
      popOut(target) {
        setWindows((current) => popOutWindow(current, target));
        void window.agentBoard.windows.popOut(target);
      },
      switchTo(fromId, target) {
        setWindows((current) => switchWindow(current, fromId, target));
      },
    }),
    [],
  );
  const value = useMemo(() => ({ windows, restored, ...actions }), [windows, restored, actions]);
  return <SessionWindowsContext value={value}>{children}</SessionWindowsContext>;
}

/** Which session or shell tile an element is about, for tests and styling. */
const idAttributes = ({ kind, id }: WindowTarget) => (kind === 'shell' ? { 'data-shell-id': id } : { 'data-session-id': id });

/**
 * The session window shown on the board, and the dock along the board's bottom edge with every other one: minimised
 * windows to restore, and popped-out ones to bring forward. `agents` gives an agent's window its live controls, and
 * `shells` (undefined until listed) a shell tile's window its panes. Once the board has `loaded` them, a window whose
 * agent or shell is gone (deleted while the board was closed) is closed. `sessions`, where every agent's and shell's
 * tile sits, and `zones` let the shown window step through the other sessions of its tile's zone (AL1).
 */
export function SessionWindowsLayer({
  agents,
  shells,
  loaded,
  notice,
  sessions,
  zones,
}: {
  agents: readonly Agent[];
  shells: readonly Shell[] | undefined;
  loaded: boolean;
  sessions: readonly NavSession[];
  zones: readonly Zone[];
  /** Shown at the top of the window shown on the board, such as the restart banner. */
  notice?: ReactNode;
}) {
  const { windows, restored, show, minimise, close, popOut, switchTo } = useSessionWindows();
  const toasts = useToast();
  // undefined until the saved frame has been read, so the window never draws maximised and then jumps to its size.
  const [frame, setFrame] = useState<SavedFrame | null | undefined>(undefined);
  const saveFrame = useMemo(() => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.windowFrame, value), SAVE_WINDOWS_DELAY_MS), []);
  useEffect(() => {
    window.agentBoard.view.get(VIEW_KEYS.windowFrame).then(
      (saved) => setFrame((current) => current ?? frameFrom(saved) ?? null),
      () => setFrame((current) => current ?? null),
    );
  }, []);
  const shown = shownWindow(windows);
  const docked = windows.filter((entry) => entry.placement !== 'shown');
  const contentOf = ({ kind, id }: WindowTarget): WindowContent =>
    kind === 'shell'
      ? { kind, shellId: id, shell: shells?.find((shell) => shell.id === id) }
      : { kind, sessionId: id, agent: agents.find((agent) => agent.sessionId === id) };
  const content = shown && contentOf(shown);
  const shownAgent = content?.kind === 'session' ? content.agent : undefined;
  const nav = shown && navOf(shown);
  function navOf(from: SessionWindowEntry): WindowNav | undefined {
    // Stepping goes past sessions popped out into their own OS windows: this window can't show them.
    const where = sessionNav(sessions, from.id, poppedOut(windows));
    if (where === undefined) return undefined;
    const zone = where.zoneId === null ? undefined : zones.find((known) => known.id === where.zoneId);
    const side = (target: WindowTarget) => {
      const subject = contentOf(target);
      const agent = subject.kind === 'session' ? subject.agent : undefined;
      return { name: agent?.name ?? (subject.kind === 'shell' ? subject.shell?.name : undefined) ?? target.title, state: agent?.state };
    };
    return {
      index: where.index,
      count: where.count,
      zone: zone && { name: zone.name, color: zone.color },
      previous: side(where.previous.target),
      next: side(where.next.target),
      onStep(direction) {
        const to = direction === 1 ? where.next : where.previous;
        switchTo(from.id, to.target);
        if (to.wrapped) toasts.show({ id: 'session-nav-wrapped', message: direction === 1 ? 'Back to the first' : 'Back to the last' });
      },
    };
  }
  // A shell tile deleted while the board was away (e.g. reopened for a pop-in) has nothing left to show.
  const gone = content?.kind === 'shell' && shells !== undefined && content.shell === undefined ? content.shellId : undefined;
  useEffect(() => {
    if (gone !== undefined) close(gone);
  }, [gone, close]);
  // Once, when the board has its agents and shells: windows taken back from the last run whose agent or shell was
  // deleted meanwhile go. Only then, as a session window may open a moment before its tile is listed.
  const pruned = useRef(false);
  useEffect(() => {
    if (!loaded || !restored || shells === undefined || pruned.current) return;
    pruned.current = true;
    const known = new Set([...agents.map((agent) => agent.sessionId), ...shells.map((shell) => shell.id)]);
    for (const entry of windows) if (!known.has(entry.id)) close(entry.id);
  }, [loaded, restored, agents, shells, windows, close]);
  return (
    <>
      {shown && content && frame !== undefined && (
        <>
          <div className="session-window-scrim" aria-hidden />
          <SessionWindow
            key={shown.id}
            content={content}
            title={shown.title}
            placement="board"
            onClose={() => close(shown.id)}
            onMinimise={() => minimise(shown.id)}
            onPopOut={() => popOut(shown)}
            nav={nav}
            frame={{
              saved: frame,
              onChange(next) {
                setFrame(next);
                saveFrame({ ...next.frame, maximised: next.maximised });
              },
            }}
            notice={
              <>
                {notice}
                {shownAgent && <HeldPromptsNotice agent={shownAgent} />}
              </>
            }
          />
        </>
      )}
      {docked.length > 0 && (
        <Island className="session-dock" role="navigation" aria-label="Dock" data-testid="session-dock">
          <span className="session-dock-label" aria-hidden>
            Dock
          </span>
          {docked.map((entry) => {
            const subject = contentOf(entry);
            const agent = subject.kind === 'session' ? subject.agent : undefined;
            // The live name, so a rename shows in the dock.
            const name = agent?.name ?? (subject.kind === 'shell' ? subject.shell?.name : undefined) ?? entry.title;
            return (
              <span key={entry.id} className="session-dock-item" data-testid="dock-item" {...idAttributes(entry)} data-placement={entry.placement} data-attention={agent !== undefined && needsYou([agent]).length > 0}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="session-dock-open"
                  icon={entry.placement === 'popped' ? <SquareArrowOutUpRight /> : <HarnessMark harness={agent?.harness ?? 'shell'} />}
                  tooltip={entry.placement === 'popped' ? 'In its own window: bring it forward' : 'Restore'}
                  onClick={() => show(entry)}
                >
                  {name}
                </Button>
                {agent && <StatusPill state={agent.state} />}
                {entry.placement === 'docked' && (
                  <IconButton icon={<X />} size="xs" aria-label={`Close ${name}`} tooltip="Close; the session keeps running" onClick={() => close(entry.id)} />
                )}
              </span>
            );
          })}
        </Island>
      )}
    </>
  );
}
