import { createContext, use, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { needsYouNow, type Agent, type Shell, type WindowOwner, type Zone } from '@agent-board/daemon/protocol';
import { windowPanes } from '@agent-board/daemon/window-layout';
import { tabWindowTitle } from '../session/tabs';
import { WINDOW_QUERY, windowTargetFrom, type ScreenPoint, type WindowTarget } from '../../../preload/api';
import { VIEW_KEYS, viewSaver } from '../../../shared/view-saver';
import { markSeen } from '../session/mark-seen';
import { agentPill } from '../states';
import { HeldPromptsNotice } from '../inbox/Inbox';
import { SquareArrowOutUpRight, X } from 'lucide-react';
import { HarnessMark } from '../board/HarnessMark';
import { TileActionsContext } from '../board/tile';
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
  /** Pops the target's window out into an OS window of its own: at `at` on the screen, if given (a tab dragged out there). */
  popOut(target: WindowTarget, at?: ScreenPoint): void;
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

/** The owner whose window layout the target's window shows. */
const windowOwnerOf = ({ kind, id }: WindowTarget): WindowOwner => (kind === 'session' ? { kind: 'agent', id } : { kind, id });

/**
 * Hands off the web tabs of the target's window (slice 4) as the window moves to another OS window, popped
 * out or back in: their pages wait for the window to open there and take them as they are, with no reload.
 */
export async function handOffWebTabs(target: WindowTarget): Promise<void> {
  const layout = await window.agentBoard.shells.windowLayout(windowOwnerOf(target)).catch(() => null);
  const webIds = layout === null ? [] : windowPanes(layout).flatMap((pane) => pane.tabs.flatMap((tab) => (tab.kind === 'web' ? [tab.id] : [])));
  await Promise.all(webIds.map((id) => window.agentBoard.webTabs.handOff(id).catch(() => {})));
}

/** Opening or focusing an agent's session counts as seeing what it asks. */
function markTargetSeen(target: WindowTarget) {
  if (target.kind === 'session') markSeen(target.id);
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
        // A tab window the board lost track of still holds its tabs (the app quit as it popped out, say): out again.
        void window.agentBoard.shells.tabWindows().then(
          (kept) => {
            if (cancelled) return;
            for (const { owner, layout } of kept) {
              if (windows.some((entry) => entry.id === owner.id)) continue;
              const first = windowPanes(layout)[0]!.tabs[0]!;
              const target: WindowTarget = { kind: 'tabs', id: owner.id, title: tabWindowTitle(first) };
              setWindows((current) => popOutWindow(current, target));
              void window.agentBoard.windows.popOut(target, { reveal: false });
            }
          },
          () => {},
        );
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
      // A tab window forgets its own tabs as it closes.
      window.agentBoard.windows.onReturned((target, how) =>
        setWindows((current) => (how === 'popIn' ? popInWindow(current, target) : closeWindow(current, target.id))),
      ),
    [],
  );
  // Stable, so what opens windows (every tile) doesn't re-render each time one moves.
  const actions = useMemo<Omit<SessionWindowsValue, 'windows' | 'restored'>>(
    () => ({
      show(target) {
        markTargetSeen(target);
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
      popOut(target, at) {
        markTargetSeen(target);
        const options = at === undefined ? undefined : { at };
        // Out already: moved to where it was let go, its web tabs where they are.
        if (windowsRef.current.some((entry) => entry.id === target.id && entry.placement === 'popped')) {
          void window.agentBoard.windows.popOut(target, options);
          return;
        }
        // Its web tabs' pages go with it, as they are, before its window here goes.
        void handOffWebTabs(target).then(() => {
          setWindows((current) => popOutWindow(current, target));
          void window.agentBoard.windows.popOut(target, options);
        });
      },
      switchTo(fromId, target) {
        markTargetSeen(target);
        setWindows((current) => switchWindow(current, fromId, target));
      },
    }),
    [],
  );
  const value = useMemo(() => ({ windows, restored, ...actions }), [windows, restored, actions]);
  return <SessionWindowsContext value={value}>{children}</SessionWindowsContext>;
}

/** Which session or shell tile an element is about, for tests and styling. */
const idAttributes = ({ kind, id }: WindowTarget) =>
  kind === 'shell' ? { 'data-shell-id': id } : kind === 'tabs' ? { 'data-tab-window-id': id } : { 'data-session-id': id };

/**
 * The session window shown on the board, and the dock along the board's bottom edge with every other one: minimised
 * windows to restore, and popped-out ones to bring forward. `agents` gives an agent's window its live controls, and
 * `shells` (undefined until listed) a shell tile's window its panes. Once the board has `loaded` them, a window whose
 * agent or shell is gone (deleted while the board was closed, or since) is closed. `sessions`, where every agent's and shell's
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
  const { deleteAgent, deleteShell } = useContext(TileActionsContext);
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
  const contentOf = ({ kind, id }: WindowTarget): WindowContent | undefined =>
    kind === 'shell'
      ? { kind, shellId: id, shell: shells?.find((shell) => shell.id === id) }
      : kind === 'session'
        ? { kind, sessionId: id, agent: agents.find((agent) => agent.sessionId === id) }
        : undefined;
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
      const agent = subject?.kind === 'session' ? subject.agent : undefined;
      return { name: agent?.name ?? (subject?.kind === 'shell' ? subject.shell?.name : undefined) ?? target.title, state: agent?.state };
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
  // A window whose agent or shell has gone has nothing left to show: shown, docked or popped out. Once the board has
  // its agents and shells, windows taken back from the last run whose tile was deleted meanwhile go. After that, a
  // window goes when its tile does, but only one that was listed first: a session window may open a moment before
  // its tile is.
  const listed = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    if (!loaded || !restored || shells === undefined) return;
    const known = new Set([...agents.map((agent) => agent.sessionId), ...shells.map((shell) => shell.id)]);
    const before = listed.current;
    listed.current = known;
    // A tab window is no session's: it goes when its last tab does.
    for (const entry of windows) if (entry.kind !== 'tabs' && !known.has(entry.id) && (before === undefined || before.has(entry.id))) close(entry.id);
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
            onDelete={() => (content.kind === 'session' ? deleteAgent(content.sessionId) : content.kind === 'shell' ? deleteShell(content.shellId) : undefined)}
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
            const agent = subject?.kind === 'session' ? subject.agent : undefined;
            // The live name, so a rename shows in the dock.
            const name = agent?.name ?? (subject?.kind === 'shell' ? subject.shell?.name : undefined) ?? entry.title;
            return (
              <span key={entry.id} className="session-dock-item" data-testid="dock-item" {...idAttributes(entry)} data-placement={entry.placement} data-attention={agent !== undefined && needsYouNow(agent)}>
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
                {agent && <StatusPill {...agentPill(agent)} />}
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
