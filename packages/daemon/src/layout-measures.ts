// How the app draws the board, as it measured it: boxes drawn other than saved (a text item at the size its text takes,
// a tile pushed aside by an expanded one) and the height each agent note's text needs. Kept in memory only, from the
// app's last report, while the connection that sent it is open; arrange and the zone map prefer them to estimates. Each
// measure holds only while what it depends on is as it was: a box's own saved box, a note's text and width, and for a
// spot an expanded tile pushed it to, the expanded tiles themselves.
import { invalidParams, paramsObject, stringParam } from './params.ts';
import { MAX_MEASURED_BOXES, measuredText, type BoxRect, type DaemonMethods, type ExpandedBox, type MeasuredBox } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import type { BoardConnection } from './board.ts';

/** How long an arrange waits for the app to measure the notes it wrote, by default. */
const DEFAULT_MEASURE_WAIT_MS = 1500;

/** Half a pixel: the app's boxes and the saved ones are rounded differently. */
const same = (a: number, b: number) => Math.abs(a - b) < 0.5;

/** A box, px: finite, and a size of at least 0. */
function boxParam(params: Record<string, unknown>, name: string): BoxRect {
  const box = params[name];
  if (typeof box !== 'object' || box === null) throw invalidParams(`${name} must be a box`);
  const fields = box as Record<string, unknown>;
  const value = (field: keyof BoxRect) => {
    const each = fields[field];
    if (typeof each !== 'number' || !Number.isFinite(each)) throw invalidParams(`${name}.${field} must be a finite number`);
    if ((field === 'width' || field === 'height') && each < 0) throw invalidParams(`${name}.${field} must be at least 0`);
    return each;
  };
  return { x: value('x'), y: value('y'), width: value('width'), height: value('height') };
}

/** A window's size, px: finite, and more than 0. */
function windowParam(raw: unknown): { width: number; height: number } {
  if (typeof raw !== 'object' || raw === null) throw invalidParams('window must be a size');
  const fields = raw as Record<string, unknown>;
  const value = (field: 'width' | 'height') => {
    const each = fields[field];
    if (typeof each !== 'number' || !Number.isFinite(each) || each <= 0) throw invalidParams(`window.${field} must be a finite number more than 0`);
    return each;
  };
  return { width: value('width'), height: value('height') };
}

function measuredBoxParam(raw: unknown): MeasuredBox {
  const params = paramsObject(raw);
  const box: MeasuredBox = { key: stringParam(params, 'key'), saved: boxParam(params, 'saved'), drawn: boxParam(params, 'drawn') };
  if (params.fits === undefined) return box;
  const fits = paramsObject(params.fits);
  const height = fits.height;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) throw invalidParams('fits.height must be a finite number of at least 0');
  return { ...box, fits: { height, text: stringParam(fits, 'text') } };
}

function expandedBoxParam(raw: unknown): ExpandedBox {
  const params = paramsObject(raw);
  return { key: stringParam(params, 'key'), ...boxParam({ expanded: params }, 'expanded') };
}

/** Whether two sets of expanded tiles are the same tiles, saved at the same spots and expanded to the same sizes. */
function sameExpanded(a: readonly ExpandedBox[], b: readonly ExpandedBox[]): boolean {
  const byKey = new Map(b.map((box) => [box.key, box]));
  return (
    a.length === b.length &&
    a.every((box) => {
      const other = byKey.get(box.key);
      return other !== undefined && same(box.x, other.x) && same(box.y, other.y) && same(box.width, other.width) && same(box.height, other.height);
    })
  );
}

/** A note's height wanted measured: its key, the width it is drawn at and the text it says. */
export interface NoteToMeasure {
  key: string;
  width: number;
  text: string;
}

export interface LayoutMeasures {
  handlers: RpcHandlers<Pick<DaemonMethods, 'layout.measured'>, BoardConnection>;
  /** Whether an app window reports how it draws the board. */
  live(): boolean;
  /**
   * Where and how big `key` is drawn, if the app measured it while it was saved at `saved` (a tile's size aside). Its
   * spot holds only while the tiles expanded are still `expanded`, which it was drawn round; else it is where it is saved.
   */
  drawn(key: string, saved: BoxRect, sized: boolean, expanded: readonly ExpandedBox[]): BoxRect | undefined;
  /** The height a note's text needs, if the app measured it saying the same, at the same width. */
  fits(note: NoteToMeasure): number | undefined;
  /** How big the window that reports is, if one does and said. */
  window(): { width: number; height: number } | undefined;
  /** Waits until the app has measured every one of `notes`, at most the wait it was made with (none with no app). */
  measured(notes: readonly NoteToMeasure[]): Promise<void>;
}

/**
 * `mayReport` says whether a connection is the app's (the one that serves captures): no other may say how the board
 * is drawn, so none can take the report over from it.
 */
export function createLayoutMeasures({ waitMs = DEFAULT_MEASURE_WAIT_MS, mayReport = () => true }: { waitMs?: number; mayReport?: (connection: BoardConnection) => boolean } = {}): LayoutMeasures {
  let from: BoardConnection | undefined;
  let boxes = new Map<string, MeasuredBox>();
  let drawnRound: ExpandedBox[] = [];
  /** Whether the window that reports is no longer in front, so says nothing more for now. */
  let away = false;
  let size: { width: number; height: number } | undefined;
  const listeners = new Set<() => void>();

  const fits = ({ key, width, text }: NoteToMeasure) => {
    const box = boxes.get(key);
    return box?.fits !== undefined && same(box.saved.width, width) && box.fits.text === measuredText(text) ? box.fits.height : undefined;
  };

  return {
    handlers: {
      'layout.measured': (raw, connection) => {
        if (!mayReport(connection)) throw invalidParams("only the app's window says how it draws the board");
        const params = paramsObject(raw);
        if (!Array.isArray(params.boxes)) throw invalidParams('boxes must be a list');
        if (params.boxes.length > MAX_MEASURED_BOXES) throw invalidParams(`boxes must be at most ${MAX_MEASURED_BOXES}`);
        if (!Array.isArray(params.expanded)) throw invalidParams('expanded must be a list');
        if (params.expanded.length > MAX_MEASURED_BOXES) throw invalidParams(`expanded must be at most ${MAX_MEASURED_BOXES}`);
        if (params.away !== undefined && typeof params.away !== 'boolean') throw invalidParams('away must be true or false');
        const window = params.window === undefined ? undefined : windowParam(params.window);
        const next = new Map(params.boxes.map((each) => measuredBoxParam(each)).map((box) => [box.key, box] as const));
        const round = params.expanded.map((each) => expandedBoxParam(each));
        if (from !== connection) {
          from = connection;
          connection.closed?.addEventListener(
            'abort',
            () => {
              if (from !== connection) return;
              from = undefined;
              boxes = new Map();
              drawnRound = [];
              away = false;
              size = undefined;
              for (const listener of [...listeners]) listener();
            },
            { once: true },
          );
        }
        boxes = next;
        drawnRound = round;
        away = params.away === true;
        size = window;
        for (const listener of [...listeners]) listener();
        return null;
      },
    },
    live: () => from !== undefined,
    drawn(key, saved, sized, expanded) {
      const box = boxes.get(key);
      if (box === undefined || !same(box.saved.x, saved.x) || !same(box.saved.y, saved.y)) return undefined;
      if (sized && (!same(box.saved.width, saved.width) || !same(box.saved.height, saved.height))) return undefined;
      return sameExpanded(drawnRound, expanded) ? box.drawn : { ...box.drawn, x: saved.x, y: saved.y };
    },
    fits,
    window: () => size,
    measured(notes) {
      // A window that is away says nothing until it is in front again: there is nothing to wait for.
      const done = () => from === undefined || away || notes.every((note) => fits(note) !== undefined);
      if (done()) return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        };
        const check = () => {
          if (done()) finish();
        };
        const timer = setTimeout(finish, waitMs);
        listeners.add(check);
      });
    },
  };
}
