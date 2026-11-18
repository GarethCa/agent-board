import { appendFileSync, renameSync, statSync } from 'node:fs';
import { ipcMain } from 'electron';
import { TRACE_IPC } from '../preload/api';

/** The trace's file in the data dir, beside the daemon's log. */
export const EXPANDED_TRACE_FILE = 'expanded-tiles.log';
/** How many of a collapse's tiles its line names. */
const TILES_NAMED = 20;

/** How big the trace grows before it starts again, the last one kept beside it as `.1`: two of these at most. */
const TRACE_CAP_BYTES = 1024 * 1024;

/** A code path, a trigger, a place the keyboard was or a tile's node id: short words, never free text. */
const WORD = /^[\w.:+-]{1,80}$/;
const TRIGGER = /^[\w.:+-]+( [\w.:+-]+)?$/;

const isWord = (value: unknown): value is string => typeof value === 'string' && WORD.test(value);

/** A viewport as `x,y,zoom`, rounded; undefined unless it is one. */
function viewOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y, zoom } = value as Record<string, unknown>;
  if (![x, y, zoom].every((part) => typeof part === 'number' && Number.isFinite(part))) return undefined;
  const round = (part: number, places: number) => String(Math.round(part * 10 ** places) / 10 ** places);
  return `${round(x as number, 1)},${round(y as number, 1)},${round(zoom as number, 3)}`;
}

/**
 * One line of the expanded-tile trace for what a window sent (`ExpandedTraceEntry`), or undefined if it is not one: a
 * collapse with the tiles it collapsed, one refused with the pinned tiles it kept open (`kept`), or a view move; each with the view before and after. Every field is a
 * short word or a number, so nothing a terminal shows or a prompt holds can get in.
 */
export function traceLine(entry: unknown, at: Date): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { kind, path, trigger, focus, tiles, before, after } = entry as Record<string, unknown>;
  if (!isWord(path) || typeof trigger !== 'string' || trigger.length > 80 || !TRIGGER.test(trigger) || !isWord(focus)) return undefined;
  const head = `${at.toISOString()} ${kind} path=${path} trigger="${trigger}" focus=${focus}`;
  const shownBefore = viewOf(before);
  const shownAfter = viewOf(after);
  if (shownBefore === undefined || shownAfter === undefined) return undefined;
  const views = `before=${shownBefore} after=${shownAfter}`;
  if (kind === 'view') return `${head} ${views}`;
  if ((kind !== 'collapse' && kind !== 'kept') || !Array.isArray(tiles) || tiles.length === 0) return undefined;
  // A tile id that isn't one shows as `?`, and a mass collapse names its first tiles and counts the rest: the line is kept.
  const named = tiles.slice(0, TILES_NAMED).map((tile) => (isWord(tile) ? tile : '?'));
  const more = tiles.length > TILES_NAMED ? [`+${tiles.length - TILES_NAMED}more`] : [];
  return `${head} tiles=${[...named, ...more].join(',')} ${views}`;
}

/**
 * Appends `line` to the trace at `path`; once it would pass `cap` bytes it starts again, the one before kept as
 * `path.1`. Never throws: a trace that can't be written must not get in the board's way.
 */
export function appendTraceLine(path: string, line: string, cap = TRACE_CAP_BYTES): void {
  try {
    const size = (() => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    })();
    if (size > 0 && size + line.length + 1 > cap) renameSync(path, `${path}.1`);
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  } catch {
    // Nothing to do about it.
  }
}

/** Writes each line a window sends of the expanded-tile trace to `path`. */
export function registerExpandedTrace(path: string): void {
  ipcMain.on(TRACE_IPC.expanded, (_event, entry: unknown) => {
    const line = traceLine(entry, new Date());
    if (line !== undefined) appendTraceLine(path, line);
  });
}
