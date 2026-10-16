import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { AgentState } from '@agent-board/daemon/protocol';
import { Activity, ChevronLeft, ChevronRight, FileCheck, GitBranch, MessageSquare, Maximize2, Minimize2, Minus, MoreHorizontal, SquareArrowDownLeft, SquareArrowOutUpRight, SquareTerminal, Trash2, X } from 'lucide-react';
import { HarnessMark } from '../board/HarnessMark';
import { commandKey, windowShortcut, withWindowShortcut } from '../keys';
import { agentPill, STATE_LABELS } from '../states';
import { Button, IconButton, Kbd, Menu, Segmented, StatusPill, Tabs, useToast, type SegmentedOption } from '../ui';
import { ReviewViewer } from '../review/ReviewViewer';
import { useReviews } from '../review/ReviewsProvider';
import { useReviewTabRequests } from '../review/review-tab';
import { roundsOf, showsReviewTab } from '../review/reviews';
import { ActivityLog, useActivity } from '../orchestrators/ActivityLog';
import { SessionName } from './SessionName';
import { SessionBody, type SessionView, type WindowContent } from './SessionBody';
import { pendingTab, requestTab, useTabRequestCount } from './tab-request';
import { gateSurfaceOf } from './tabs';
import { isRunGateKey } from './window-keys';
import { GateControls } from '../gate/GateControls';
import { gated } from '../gate/gate-view';
import { errorMessage } from '../../../shared/errors';
import type { AttachState } from './TerminalPane';
import { dropKey } from './shell-moves';
import { tokenNumber } from '../theme';
import { clampFrame, defaultFrame, EDGES, fromFractions, resizeFrame, toFractions, type Bounds, type Edge, type Frame, type SavedFrame } from '../windows/window-frame';

/** Where the window's session is among its group's, and how to step to the others (AL1). */
export interface WindowNav {
  /** From 0, in board order. */
  index: number;
  count: number;
  /** The zone the sessions share, or undefined for the board's loose sessions. */
  zone?: { name: string; color: string };
  /** The sessions either side: their names, and an agent's state, for the buttons' previews. */
  previous: { name: string; state?: AgentState };
  next: { name: string; state?: AgentState };
  /** Shows the previous (-1) or next (1) session in this window. */
  onStep(direction: -1 | 1): void;
}

interface SessionWindowProps {
  content: WindowContent;
  /** What the window's title bar calls the session. */
  title: string;
  /** On the board, over everything else; or filling an OS window of its own. */
  placement: 'board' | 'own-window';
  /** Closes the window. The session keeps running. */
  onClose(): void;
  /** Deletes the session, asking first if need be (the window closes with it). Absent where the board can't. */
  onDelete?(): void;
  /** Minimises it to the board's dock. */
  onMinimise?(): void;
  /** Pops it out into its own OS window. */
  onPopOut?(): void;
  /** Pops it back in, onto the board. */
  onPopIn?(): void;
  /** A line about the session shown above its terminal, e.g. why it is not asking yet. */
  notice?: ReactNode;
  /** Steps through the other sessions of its group: on the board only. */
  nav?: WindowNav;
  /** On the board: where the window is and its size, and how to change them (resizing, Maximise and Restore). */
  frame?: { saved: SavedFrame | null; onChange(saved: SavedFrame): void };
}

/**
 * The window that shows one session, or a shell tile's panes: a header with its
 * name, state and branch, and its window buttons; its details on the left; its terminal, dark, with a message
 * composer under it for an agent. On the board it has labelled Minimise, Pop out and Close buttons (V-c); popped out,
 * its header holds the OS window's traffic lights on macOS and Back to board, and its details start as an icon rail
 * (W-a). Closing or minimising it detaches; Stop ends the session. An implementer whose work is under review has a
 * Review tab beside its terminal (AD2), with the review doc viewer; the terminal stays attached behind it. An orchestrator
 * has an Activity tab (BB1), with what it did and tried. An agent's
 * header has a Terminal/Chat switch (AE1): the chat view reads its conversation from its transcript instead.
 */
export function SessionWindow({ content, title, placement, onClose, onDelete, onMinimise, onPopOut, onPopIn, notice, nav, frame }: SessionWindowProps) {
  const agent = content.kind === 'session' ? content.agent : undefined;
  const shell = content.kind === 'shell' ? content.shell : undefined;
  const [attach, setAttach] = useState<AttachState>('attaching');
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const name = agent?.name ?? shell?.name ?? title;
  const where = agent?.branch ?? shell?.cwd;
  const rounds = roundsOf(useReviews(), content.kind === 'session' ? content.sessionId : '');
  const [tab, setTab] = useState<WindowTab>('terminal');
  // Asked for (from its tile or its reviewer's), it opens on its Review tab, now and whenever asked again: even with its
  // latest round dismissed, whose doc can still be read.
  const [asked, setAsked] = useState(false);
  const reviewable = agent !== undefined && showsReviewTab(rounds, asked);
  const reviewRequests = useReviewTabRequests(content.kind === 'session' ? content.sessionId : undefined);
  const seenRequests = useRef(0);
  useEffect(() => {
    if (reviewRequests > seenRequests.current) {
      setTab('review');
      setAsked(true);
    }
    seenRequests.current = reviewRequests;
  }, [reviewRequests]);
  // A terminal tab asked for (a row of its tile's shells chip) shows over Review or Activity: one asked for as
  // it opens (read as it first renders, before its body takes it), or after.
  const agentId = content.kind === 'session' ? content.sessionId : undefined;
  const tabRequests = useTabRequestCount(agentId);
  const askedAtOpen = useRef(pendingTab(agentId) !== undefined);
  const seenTabRequests = useRef(tabRequests);
  useEffect(() => {
    if (askedAtOpen.current || tabRequests > seenTabRequests.current) setTab('terminal');
    askedAtOpen.current = false;
    seenTabRequests.current = tabRequests;
  }, [tabRequests]);
  // An orchestrator's Activity tab (BB1), once it has done or tried something (most agents may orchestrate, few do),
  // or to say its activity could not be read.
  const activity = useActivity(agent?.sessionId);
  const orchestrates = agent !== undefined && (activity.lines.length > 0 || activity.error !== undefined);
  const showing = (tab === 'review' && reviewable) || (tab === 'activity' && orchestrates) ? tab : 'terminal';
  const [view, setView] = useState<SessionView>('terminal');
  const root = useRef<HTMLDivElement>(null);
  const placed = useWindowFrame(root, frame);
  useMinimiseOnClickOutside(root, placement === 'board' ? onMinimise : undefined);

  // ⌘I shows or hides the details.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!commandKey(event) || event.altKey || event.shiftKey || event.key !== 'i') return;
      event.preventDefault();
      setDetailsCollapsed((collapsed) => !collapsed);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // ⌘⇧G runs its gate, wherever the focus is in the window, the terminal too, and shows it in a Gate tab.
  const gateAgent = agent && gated(agent) ? agent.sessionId : undefined;
  const toast = useToast();
  useEffect(() => {
    if (gateAgent === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isRunGateKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      requestTab(gateAgent, gateSurfaceOf(gateAgent));
      window.agentBoard.gates.run(gateAgent).catch((failure: unknown) => toast.show({ tone: 'error', message: `Could not run the gate: ${errorMessage(failure)}` }));
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [gateAgent, toast]);

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Session window"
      className={`session-window session-window-${placement}`}
      data-testid="session-window"
      data-session-id={content.kind === 'session' ? content.sessionId : undefined}
      data-shell-id={content.kind === 'shell' ? content.shellId : undefined}
      data-tab-window-id={content.kind === 'tabs' ? content.id : undefined}
      // A tab, pane or shell tile dropped on it, header too, joins its tabs: an agent's or a shell tile's.
      data-tab-drop={agent ? dropKey({ kind: 'agent', id: agent.sessionId }) : content.kind === 'shell' ? dropKey({ kind: 'shell', id: content.shellId }) : undefined}
      data-state={attach}
      data-maximised={frame === undefined ? undefined : placed.maximised}
      style={placed.style}
    >
      {frame && EDGES.map((edge) => <span key={edge} className={`session-window-edge session-window-edge-${edge}`} data-edge={edge} onPointerDown={(event) => placed.startResize(event, edge)} />)}
      <header className="session-window-head" data-drag-region={placement === 'own-window' || undefined} onDoubleClick={placed.onHeaderDoubleClick}>
        {nav && <NavButtons nav={nav} />}
        {content.kind !== 'tabs' && <HarnessMark className="session-window-mark" harness={agent?.harness ?? 'shell'} />}
        <SessionName agent={agent} shell={shell} name={name} title={title} />
        {agent && <StatusPill {...agentPill(agent)} />}
        {nav && <NavCount nav={nav} />}
        {where !== undefined && (
          <span className="session-window-where" title={agent?.worktree ?? where}>
            {agent && <GitBranch aria-hidden />}
            {where}
          </span>
        )}
        <span className="session-window-head-fill" />
        {/* Its merge gate (BM3), for an agent with a branch of its own. */}
        {agent && gated(agent) && <GateControls agent={agent} visible />}
        {/* How its terminal tab shows it: hidden over the Review tab, whose own tabs lead back. */}
        {agent && showing === 'terminal' && <Segmented<SessionView> className="session-window-view-switch" aria-label="View" value={view} onChange={setView} options={VIEW_OPTIONS} />}
        {onMinimise && (
          <Button variant="ghost" size="sm" icon={<Minus />} onClick={onMinimise} aria-label="Minimise session window" tooltip="Minimise to the dock; it keeps running">
            <span className="session-window-folding-label">Minimise</span>
          </Button>
        )}
        {frame && (
          <IconButton
            icon={placed.maximised ? <Minimize2 /> : <Maximize2 />}
            size="sm"
            onClick={placed.toggleMaximised}
            aria-label={placed.maximised ? 'Restore session window' : 'Maximise session window'}
            tooltip={placed.maximised ? 'Restore: back to the size it had' : 'Maximise: fill the board'}
          />
        )}
        {onPopOut && (
          <Button variant="ghost" size="sm" icon={<SquareArrowOutUpRight />} onClick={onPopOut} aria-label="Pop out session window" tooltip="Into its own window">
            <span className="session-window-folding-label">Pop out</span>
          </Button>
        )}
        {onPopIn && (
          <Button size="sm" icon={<SquareArrowDownLeft />} onClick={onPopIn}>
            Back to board
          </Button>
        )}
        {placement === 'board' && onDelete && (
          <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete} aria-label="Delete session" tooltip="Delete it, asking first if it is running or has work to lose">
            Delete
          </Button>
        )}
        {placement === 'board' ? (
          <Button size="sm" icon={<X />} onClick={onClose} aria-label="Close session window" tooltip="Back to its tile; the session keeps running">
            Close
          </Button>
        ) : (
          <Menu align="end" entries={[{ label: 'Close window', icon: <X />, onSelect: onClose }]}>
            <IconButton icon={<MoreHorizontal />} size="sm" aria-label="More" />
          </Menu>
        )}
      </header>
      {(reviewable || orchestrates) && (
        <Tabs<WindowTab>
          className="session-window-tabs"
          aria-label="Window tabs"
          value={showing}
          onChange={setTab}
          tabs={[
            { id: 'terminal', label: 'Terminal', icon: <SquareTerminal /> },
            ...(reviewable ? [{ id: 'review' as const, label: `Review · round ${rounds.at(-1)!.round}`, icon: <FileCheck /> }] : []),
            ...(orchestrates ? [{ id: 'activity' as const, label: 'Activity', icon: <Activity /> }] : []),
          ]}
        />
      )}
      <div className="session-window-view" hidden={showing !== 'terminal'}>
        <SessionBody
          content={content}
          detailsCollapsed={detailsCollapsed}
          onDetailsCollapsed={setDetailsCollapsed}
          notice={notice}
          onAttachState={setAttach}
          view={view}
          shown={showing === 'terminal'}
          onShowTerminal={() => setView('terminal')}
        />
      </div>
      {/* A new round is shown as it starts, whichever round was picked. */}
      {showing === 'review' && agent && (
        <ReviewViewer
          key={rounds.length}
          implementer={agent}
          rounds={rounds}
          onDismissed={() => {
            setTab('terminal');
            setAsked(false);
          }}
        />
      )}
      {showing === 'activity' && agent && <ActivityLog orchestrator={agent} activity={activity} />}
    </div>
  );
}

/** The window's tabs: its terminal, an implementer's Review (AD2) and an orchestrator's Activity (BB1). */
type WindowTab = 'terminal' | 'review' | 'activity';

const VIEW_OPTIONS: SegmentedOption<SessionView>[] = [
  { id: 'terminal', label: 'Terminal', icon: <SquareTerminal aria-hidden /> },
  { id: 'chat', label: 'Chat', icon: <MessageSquare aria-hidden /> },
];

/**
 * A pointer-down on the board outside the window minimises it, and carries on to do its normal job there. Not
 * outside: the window itself, the dock and its list of sessions, the onboarding "Back to setup" pill (that click closes the sign-in window and
 * needs the click to land), and anything portalled out of the board's DOM (menus, dialogs, popovers and toasts opened
 * from the window), which a click on is never inside the board. The listener is on the capture phase and never
 * stops the event, so the board still sees it. A drag that starts inside and ends outside has no pointer-down outside.
 */
function useMinimiseOnClickOutside(root: React.RefObject<HTMLDivElement | null>, onMinimise: (() => void) | undefined) {
  const latest = useRef(onMinimise);
  latest.current = onMinimise;
  const active = onMinimise !== undefined;
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      const element = root.current;
      const target = event.target;
      if (element === null || !(target instanceof Node) || element.contains(target)) return;
      if (!element.offsetParent?.contains(target)) return;
      if (target instanceof Element && target.closest('.session-dock, .session-dock-popover, .onboarding-away') !== null) return;
      latest.current?.();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [root, active]);
}

/**
 * ‹ and › with ⌘[ and ⌘] (AL1; Ctrl+Shift+[ and ] off macOS, where Ctrl+[ is the terminal's Esc): each previews the
 * session it goes to. Disabled when the session is alone in its group.
 */
function NavButtons({ nav }: { nav: WindowNav }) {
  const { count, onStep } = nav;
  // Read through a ref: `nav` is new each render, and the listener need only be added once.
  const navRef = useRef(nav);
  navRef.current = nav;
  // Before the board's own keys (⌘[ and ⌘] restack its selection), and wherever the focus is, the terminal too. They
  // are taken even for a session alone in its group: restacking the board's selection behind this window would go unseen.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = windowShortcut(event);
      if (key !== 'BracketLeft' && key !== 'BracketRight') return;
      event.preventDefault();
      event.stopPropagation();
      if (navRef.current.count > 1) navRef.current.onStep(key === 'BracketLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  const preview = (label: string, to: { name: string; state?: AgentState }, key: string) => (
    <span className="session-nav-preview">
      <span className="session-nav-preview-muted">{label}</span>
      {to.name}
      {to.state !== undefined && <span className="session-nav-preview-muted">· {STATE_LABELS[to.state]}</span>}
      <Kbd>{withWindowShortcut(key)}</Kbd>
    </span>
  );
  const alone = count < 2;
  const group = nav.zone?.name ?? 'Loose';
  return (
    <span className="session-nav" role="group" aria-label={`Sessions in ${group}`}>
      <IconButton
        icon={<ChevronLeft />}
        size="sm"
        aria-label="Previous session"
        tooltip={alone ? undefined : preview('Previous', nav.previous, '[')}
        disabled={alone}
        onClick={() => onStep(-1)}
      />
      <IconButton
        icon={<ChevronRight />}
        size="sm"
        aria-label="Next session"
        tooltip={alone ? undefined : preview('Next', nav.next, ']')}
        disabled={alone}
        onClick={() => onStep(1)}
      />
    </span>
  );
}

/** "3 of 7 · Frontend", with the zone's colour; a hollow dot and "Loose" for the board's loose sessions. */
function NavCount({ nav }: { nav: WindowNav }) {
  return (
    <span className="session-nav-count" data-testid="session-nav-count">
      <b>{nav.index + 1}</b> of {nav.count} ·
      <span
        className="session-nav-dot"
        data-loose={nav.zone === undefined || undefined}
        // A zone's colour is its data, not a theme token.
        style={nav.zone === undefined ? undefined : { background: nav.zone.color }}
        aria-hidden
      />
      {nav.zone?.name ?? 'Loose'}
    </span>
  );
}

/**
 * How far down from the board's top edge a session window stays: on macOS, windowed, below the row of islands the traffic
 * lights float in, as its stylesheet places it filling the board (`.session-window-board`). Otherwise nothing.
 */
function clearTop(): number {
  const { chrome, fullScreen } = document.documentElement.dataset;
  if (chrome !== 'inset' || fullScreen === 'true') return 0;
  return tokenNumber('--island-inset') + tokenNumber('--island-height') + tokenNumber('--space-2');
}

/**
 * The board window's size and place: maximised it fills the board as its stylesheet says; otherwise it is
 * placed at the saved frame, kept inside the board, and resized by dragging any of its edges or corners.
 */
function useWindowFrame(root: React.RefObject<HTMLDivElement | null>, frame: SessionWindowProps['frame']) {
  const [bounds, setBounds] = useState<Bounds | undefined>();
  const [live, setLive] = useState<Frame | undefined>();
  const saved = frame?.saved ?? null;
  // Fills the board until a frame is kept, as the window always did.
  const maximised = saved === null || saved.maximised;
  const onChange = frame?.onChange;
  useEffect(() => {
    const parent = root.current?.offsetParent;
    if (!(parent instanceof HTMLElement) || onChange === undefined) return;
    const measure = () => setBounds({ width: parent.clientWidth, height: parent.clientHeight, top: clearTop() });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    // Full screen hides the traffic lights, and the room kept for them goes with them.
    const fullScreen = new MutationObserver(measure);
    fullScreen.observe(document.documentElement, { attributes: true, attributeFilter: ['data-full-screen'] });
    return () => {
      observer.disconnect();
      fullScreen.disconnect();
    };
  }, [root, onChange]);
  const kept = saved === null || bounds === undefined ? undefined : clampFrame(fromFractions(saved.frame, bounds), bounds);
  const shown = live ?? kept;
  const style: CSSProperties | undefined =
    maximised && live === undefined
      ? undefined
      : shown === undefined
        ? undefined
        : { inset: 'auto', left: shown.x, top: shown.y, width: shown.width, height: shown.height };
  /** The window as drawn now, in the board's pixels. */
  const current = (): Frame | undefined => {
    const element = root.current;
    return element === null ? undefined : { x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight };
  };
  const toggleMaximised = () => {
    if (frame === undefined) return;
    if (bounds === undefined) return;
    const base = saved === null ? defaultFrame(bounds) : fromFractions(saved.frame, bounds);
    frame.onChange({ frame: toFractions(clampFrame(base, bounds), bounds), maximised: !maximised });
  };
  return {
    maximised: maximised && live === undefined,
    style,
    toggleMaximised,
    onHeaderDoubleClick(event: React.MouseEvent) {
      // Empty header space only: a name, button or field takes its own double-click.
      const target = event.target as HTMLElement;
      if (target.closest('button, a, input, h2, .editable-name, .session-window-where, .session-nav, .ui-segmented') !== null) return;
      toggleMaximised();
    },
    startResize(event: ReactPointerEvent, edge: Edge) {
      const start = current();
      if (frame === undefined || start === undefined || bounds === undefined || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      const origin = { x: event.clientX, y: event.clientY };
      let latest = start;
      const move = (next: PointerEvent) => {
        latest = resizeFrame(start, edge, next.clientX - origin.x, next.clientY - origin.y, bounds);
        setLive(latest);
      };
      const stop = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        setLive(undefined);
        frame.onChange({ frame: toFractions(latest, bounds), maximised: false });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    },
  };
}
