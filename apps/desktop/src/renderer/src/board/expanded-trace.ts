import type { ExpandedTraceEntry, TraceViewport } from '../../../preload/api';

/** A trigger's or a path's words, as the trace in main takes them. */
const WORD = /^[\w.:+-]{1,40}$/;

/**
 * The event being handled, as the trace names it: its type, and for a key its name (`Escape`, `ArrowLeft`) or, with
 * ⌘ or Ctrl held, its place on the keyboard (`Meta+KeyK`); a character typed is only `printable`. `none` outside any
 * event: an effect, a timer, a message from main.
 */
export function triggerOf(event: Event | undefined): string {
  if (event === undefined) return 'none';
  if (!WORD.test(event.type)) return 'other';
  if (!(event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress')) return event.type;
  const keys = event as KeyboardEvent;
  const chord = keys.metaKey || keys.ctrlKey;
  if (keys.key.length === 1 && !chord) return `${event.type} printable`;
  const mods = [keys.metaKey && 'Meta', keys.ctrlKey && 'Ctrl', keys.altKey && 'Alt', keys.shiftKey && 'Shift'].filter(Boolean);
  const name = keys.key.length === 1 ? keys.code : keys.key;
  return WORD.test(name) ? `${event.type} ${[...mods, name].join('+')}` : `${event.type} other`;
}

/** Where the keyboard is, by the kind of place: `terminal`, `field`, `tile`, `board`, `page` or `other`. */
export function focusOf(element: Element | null): string {
  if (element === null || element.tagName === 'BODY') return 'page';
  if (element.closest('.xterm') !== null) return 'terminal';
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || (element as HTMLElement).isContentEditable) return 'field';
  if (element.closest('.react-flow__node') !== null) return 'tile';
  if (element.closest('.react-flow') !== null) return 'board';
  return 'other';
}

/** How long a noted cause waits for the collapse or the view move it explains, unless it says. */
const CAUSE_KEPT_MS = 1000;
/** How long React Flow's own fit, as a board opens, may take to start: it waits for the tiles to be measured. */
export const FIT_NOTED_MS = 5000;
/** How long after a collapse the view is read again: the board laid out and any move it set off begun. */
const SETTLED_MS = 600;

interface Cause {
  path: string;
  trigger: string;
  focus: string;
  /** Until when it explains what follows. */
  until: number;
}

/** A board the view moves on: the main board, or a ticket's own (whose paths start `ticketBoard.`). */
export type TracedBoard = 'board' | 'ticketBoard';

export interface ExpandedTraceDeps {
  send(entry: ExpandedTraceEntry): void;
  now(): number;
  /** The trigger and the focus now. */
  here(): { trigger: string; focus: string };
  later(run: () => void, ms: number): void;
}

/**
 * The expanded-tile trace: each collapse of an expanded tile, and each view move a board makes (not the user's own
 * pan or zoom), sent to main with its cause. A code path that collapses tiles notes it first, with the tiles
 * (`noteCollapse`); one that moves the view notes it for its board (`noteView`). Either is noted with the event it
 * handles then. A tile that collapses takes the cause noted for it within a second, once; a move takes its board's.
 * A collapse or a move with no cause noted is `unexplained`: the one to look for. A collapse a tile's pin refuses is
 * sent as `kept`, by the path that tried (`kept`).
 */
export function createExpandedTrace({ send, now, here, later }: ExpandedTraceDeps) {
  let collapseCauses: { cause: Cause; tiles: Set<string> }[] = [];
  const viewCauses = new Map<TracedBoard, Cause>();
  const moving = new Map<TracedBoard, { cause: Cause; before: TraceViewport }>();
  let view: (() => TraceViewport) | undefined;
  const cause = (path: string, trigger?: string, keptMs = CAUSE_KEPT_MS): Cause => {
    const place = here();
    return { path, trigger: trigger ?? place.trigger, focus: place.focus, until: now() + keptMs };
  };
  const fresh = (noted: Cause | undefined) => (noted !== undefined && now() <= noted.until ? noted : undefined);
  const plain = ({ x, y, zoom }: TraceViewport) => ({ x, y, zoom });
  const pathOn = (board: TracedBoard, path: string) => (board === 'board' ? path : `${board}.${path}`);
  return {
    /** Where to read the main board's view from, once it is drawn. */
    watchView(read: () => TraceViewport) {
      view = read;
    },
    /** `path` is about to collapse `tiles`; `trigger` names a cause of the board's own where there is no event. */
    noteCollapse(path: string, tiles: readonly string[], trigger?: string) {
      if (tiles.length > 0) collapseCauses.push({ cause: cause(path, trigger), tiles: new Set(tiles) });
    },
    /** `path` would have collapsed `tiles`, but they are pinned expanded and stay open: a `kept` line at once. */
    kept(path: string, tiles: readonly string[], trigger?: string) {
      if (tiles.length === 0 || view === undefined) return;
      const by = cause(path, trigger);
      const at = plain(view());
      send({ kind: 'kept', path: by.path, trigger: by.trigger, focus: by.focus, tiles, before: at, after: at });
    },
    /** The expanded tiles `tiles` collapsed: a line for each cause, the tiles nothing was noted for as `unexplained`. */
    collapsed(tiles: readonly string[]) {
      collapseCauses = collapseCauses.filter((noted) => fresh(noted.cause) !== undefined);
      const lines = new Map<Cause, string[]>();
      let unexplained: Cause | undefined;
      for (const tile of tiles) {
        const noted = collapseCauses.find((entry) => entry.tiles.has(tile));
        noted?.tiles.delete(tile);
        const by = noted?.cause ?? (unexplained ??= cause('unexplained'));
        lines.set(by, [...(lines.get(by) ?? []), tile]);
      }
      collapseCauses = collapseCauses.filter((noted) => noted.tiles.size > 0);
      if (view === undefined) return;
      const read = view;
      const before = plain(read());
      later(() => {
        const after = plain(read());
        for (const [by, collapsedBy] of lines) send({ kind: 'collapse', path: by.path, trigger: by.trigger, focus: by.focus, tiles: collapsedBy, before, after });
      }, SETTLED_MS);
    },
    /** `board` is about to move its view, from `path`; `keptMs` for a move that comes later than a second. */
    noteView(path: string, board: TracedBoard = 'board', keptMs?: number) {
      viewCauses.set(board, cause(path, undefined, keptMs));
    },
    /**
     * The view of `board` began to move: by the user (a pan, a zoom) or by the board. React Flow's `onMoveStart` has
     * an event only for the user's; a controlled viewport's sync would pass `{ sync: true }`, but neither board is one.
     */
    moveStarted(byUser: boolean, before: TraceViewport, board: TracedBoard = 'board') {
      const noted = fresh(viewCauses.get(board));
      viewCauses.delete(board);
      if (byUser) moving.delete(board);
      else moving.set(board, { cause: noted ?? cause('unexplained'), before: plain(before) });
    },
    moveEnded(after: TraceViewport, board: TracedBoard = 'board') {
      const started = moving.get(board);
      if (started === undefined) return;
      moving.delete(board);
      const { cause: noted, before } = started;
      send({ kind: 'view', path: pathOn(board, noted.path), trigger: noted.trigger, focus: noted.focus, before, after: plain(after) });
    },
  };
}

/** The board's trace, sent to main; a capture window's is dropped there. Nothing outside a window (a unit test). */
const inWindow = typeof window !== 'undefined' && typeof document !== 'undefined';
export const expandedTrace = createExpandedTrace({
  send: (entry) => {
    if (inWindow) window.agentBoard.trace.expanded(entry);
  },
  now: () => Date.now(),
  here: () => (inWindow ? { trigger: triggerOf(window.event), focus: focusOf(document.activeElement) } : { trigger: 'none', focus: 'page' }),
  later: (run, ms) => setTimeout(run, ms),
});
