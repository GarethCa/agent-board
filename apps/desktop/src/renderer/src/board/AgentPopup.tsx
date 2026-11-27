import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { useEscStep } from '../keys/esc-ladder';
import { leaveToTile, useLeaveKeys } from '../keys/escape-hatch';
import { pressed } from '../keys/registry';
import { isTyping } from '../keys/typing';
import { escClosesFromBehind } from './agent-popup';
import { usePopupFill } from './popup-fill';
import { usePopupFrost } from './popup-frost';
import { capBites, dragPopup, POPUP_EDGES, popupSize, readPopupSize, writePopupSize, type PopupEdge, type Size } from './popup-size';
import type { PopupSplit } from './popup-split';
import { useBoardCommands } from './commands';
import { AgentView, type PopUpBoard } from './agent-view/AgentView';
import { PopupWideContext } from './agent-view/AgentViewHeader';
import type { PopUpSplitting } from './agent-view/use-agent-view-row';

/**
 * An agent's pop-up: its session over the dimmed board, which stays where it was under it, opened by a double-click on
 * its tile or ⋯ → Open. Inside the board's window, so nothing takes the focus from the app. Three parts, each its own
 * slot: the header (mark, name and status, then the one action for what it is doing now, Expand, Pop out, More and –
 * back to the tile) and the body (its session, as its window shows it), with no row of controls at its foot: its pull
 * requests and their checks are in More. It takes the keys as it opens, so the board's behind it act on nothing unseen.
 * –, Esc, or a click on the dimmed board closes it, the tile selected.
 */
export function AgentPopup({
  agent,
  helpers,
  on,
  popped = [],
  nodeId,
  onClose,
  board: ticketBoard,
}: {
  agent: Agent;
  /** A ticket's helpers, each a tab after its chat's (`popUpHelpers`); undefined for an agent that is no ticket. */
  helpers?: readonly Agent[] | undefined;
  /** The helper's tab it opens on, as Answer does; else it opens on its chat. */
  on?: string | undefined;
  /** The helpers popped out into a window of their own: a click on one's tab brings its window forward. */
  popped?: readonly string[] | undefined;
  nodeId: string;
  onClose(): void;
  /** What a ticket's Board tab draws its board from; without it the Board tab shows the chat. */
  board?: PopUpBoard | undefined;
}) {
  const root = useRef<HTMLElement>(null);
  const board = useBoardCommands();
  const leave = () => leaveToTile(root.current, onClose, board.selectNode);
  // Esc from its header, or ⌘Esc from anywhere in it, as a session window's; its terminal keeps its own Esc.
  useLeaveKeys(root, onClose, board.selectNode);
  // The keys are its own once it is up (its session takes them as a window's does, else the pop-up itself).
  useEffect(() => {
    const surface = root.current;
    if (surface && !surface.contains(document.activeElement)) surface.focus();
  }, []);
  // Esc with the focus behind it, on the board: the pop-up is in front of all of it.
  useEscStep(
    'surface',
    (event) => escClosesFromBehind({ escape: pressed('window.escape', event), typing: isTyping(event), inPopUp: event.target instanceof Node && root.current?.contains(event.target) === true }),
    leave,
  );
  // Only a click that starts on the dimmed board closes it: a selection dragged out of its terminal ends there too.
  const pressedOnScrim = useRef(false);
  const onScrimDown = (event: PointerEvent) => {
    pressedOnScrim.current = event.target === event.currentTarget;
  };
  const onScrim = (event: MouseEvent) => {
    if (event.target === event.currentTarget && pressedOnScrim.current) leave();
    pressedOnScrim.current = false;
  };
  const scrim = useRef<HTMLDivElement>(null);
  // Two agents side by side, grown to the board's edges; kept only while it is open.
  const [split, setSplit] = useState<PopupSplit>();
  const { style, edges, wide } = usePopupSize(scrim, split !== undefined);
  const splitting: PopUpSplitting = { split, onSplit: setSplit, agents: ticketBoard?.agents ?? [] };
  const frost = usePopupFrost();
  return (
    <div ref={scrim} className="agent-popup-scrim" data-testid="agent-popup-scrim" data-frost={frost || undefined} onPointerDown={onScrimDown} onClick={onScrim}>
      <div className="agent-popup-frame" style={style}>
        {/* nokey: the board's own keys (Delete, the arrows) leave the tiles behind it be. */}
        <section
          ref={root}
          className="agent-popup nokey"
          data-testid="agent-popup"
          data-session-id={agent.sessionId}
          role="dialog"
          aria-modal="true"
          aria-label={`${agent.name}, pop-up`}
          tabIndex={-1}
          data-ticket={helpers !== undefined || undefined}
          data-split={split !== undefined || undefined}
        >
          <PopupWideContext.Provider value={wide}>
            {/* A ticket's view is not a lone agent's, even of the same agent: a new one as its helpers come or go. */}
            <AgentView key={helpers === undefined ? 'agent' : 'ticket'} agent={agent} helpers={helpers} on={on} popped={popped} board={ticketBoard} nodeId={nodeId} onClose={onClose} root={root} splitting={splitting} />
          </PopupWideContext.Provider>
        </section>
        {/* Split, it has all the board: nothing to drag. */}
        {split === undefined && edges}
      </div>
    </div>
  );
}

/** How far, in px, a press on an edge moves before it is a drag: a click with a trackpad's jitter keeps no size. */
const DRAG_SLOP = 3;

/**
 * The pop-up's size on the board under `scrim`: the board's width less its margin, or the size dragged to from its
 * edges and corners, which every pop-up keeps through restarts. A double-click on an edge gives its default size back.
 * It stays centred as it is dragged, out to the board's edges whatever the cap.
 * Split, it grows to the board's edges, and has its size back as the split ends. On a wide screen (`wide`) it stops at
 * the cap's width, centred, unless set to fill it.
 */
function usePopupSize(scrim: RefObject<HTMLElement | null>, split: boolean): { style: CSSProperties | undefined; edges: ReactNode; wide: boolean } {
  const fill = usePopupFill();
  const [room, setRoom] = useState<Size | null>(null);
  const [saved, setSaved] = useState(readPopupSize);
  const drag = useRef<{ edge: PopupEdge; x: number; y: number; start: Size; room: Size; moved: boolean; last: Size } | null>(null);
  // The room it has: the board less the scrim's padding, its margin. Before it is painted, and again whenever the
  // board's window is resized.
  useLayoutEffect(() => {
    const element = scrim.current;
    if (!element) return;
    const measure = () => {
      const pad = getComputedStyle(element);
      const across = Number.parseFloat(pad.paddingLeft) + Number.parseFloat(pad.paddingRight);
      const down = Number.parseFloat(pad.paddingTop) + Number.parseFloat(pad.paddingBottom);
      setRoom({ width: element.clientWidth - across, height: element.clientHeight - down });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrim]);
  const size = room === null ? null : popupSize(room, saved, { split, fill });
  const dragged = (event: PointerEvent, held: NonNullable<typeof drag.current>) => dragPopup(held.start, held.edge, event.clientX - held.x, event.clientY - held.y, held.room);
  const onDown = (edge: PopupEdge) => (event: PointerEvent<HTMLElement>) => {
    if (size === null || room === null || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edge, x: event.clientX, y: event.clientY, start: size, room, moved: false, last: size };
  };
  const onMove = (event: PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (held === null) return;
    held.moved ||= Math.abs(event.clientX - held.x) > DRAG_SLOP || Math.abs(event.clientY - held.y) > DRAG_SLOP;
    if (!held.moved) return;
    held.last = dragged(event, held);
    setSaved(held.last);
  };
  const onUp = (event: PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (held === null) return;
    drag.current = null;
    // A click, or the first of a double-click, keeps no size.
    if (held.moved) writePopupSize(dragged(event, held));
  };
  // A drag the system takes away keeps the size it reached, as a pointer-up there would.
  const onCancel = () => {
    const held = drag.current;
    drag.current = null;
    if (held?.moved) writePopupSize(held.last);
  };
  const onReset = () => {
    setSaved(null);
    writePopupSize(null);
  };
  const edges = POPUP_EDGES.map((edge) => (
    <div
      key={edge}
      className="agent-popup-edge"
      data-edge={edge}
      data-testid={`agent-popup-edge-${edge}`}
      aria-hidden
      title="Drag to resize · double-click for its default size"
      onPointerDown={onDown(edge)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onDoubleClick={onReset}
    />
  ));
  return { style: size === null ? undefined : { width: size.width, height: size.height }, edges, wide: room !== null && capBites(room) };
}
