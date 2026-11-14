import type xtermHeadless from '@xterm/headless';
import type xtermSerialize from '@xterm/addon-serialize';
import type { SavedScreen } from './sessions.ts';

/**
 * How soon after leaving its alternate screen a session must exit for that screen to be its last: long enough for a
 * harness to run its exit hooks, short enough that one which left it and carried on (an overlay closed) is not shown
 * as it was then.
 */
export const LEFT_SCREEN_EXIT_MS = 10_000;

/** The private modes that switch to the alternate screen and back. */
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

/** What `serialize` puts between the normal screen and the alternate one. */
const ALT_SCREEN_START = '\x1b[?1049h\x1b[H';

/** Back to plain text, so one part's colours don't run into the next. */
const PLAIN = '\x1b[0m';

export interface LeftScreen {
  /**
   * The session's last screen, if it left its alternate screen no more than `LEFT_SCREEN_EXIT_MS` ago and has not gone
   * back to it since: its normal screen and scrollback, the alternate screen it left laid out under them, and under
   * that what it has written to the normal screen since (an error it died of, how to resume it).
   */
  last(): SavedScreen | undefined;
}

type Buffer = xtermHeadless.IBuffer;

/**
 * Keeps the screen a full-screen program leaves. Claude Code's TUI draws in the terminal's alternate screen; as it
 * exits it leaves that screen, which takes everything it drew with it, and the normal screen it goes back to shows
 * little more than how to resume it, or the error it died of. So the screen it is leaving is kept, as it leaves, to save
 * as the session's last with what it writes after. It is laid out as plain lines on the normal screen, so it still
 * shows under a shell started over it.
 */
export function watchLeftScreen(
  model: xtermHeadless.Terminal,
  serializer: xtermSerialize.SerializeAddon,
  scrollback: number,
  now: () => number = Date.now,
): LeftScreen {
  let left: { screen: SavedScreen; at: number; after: number } | undefined;
  const switches = (params: (number | number[])[]) => params.some((param) => typeof param === 'number' && ALT_SCREEN_MODES.has(param));
  // Run before the terminal's own handler (returning false lets it run), while the alternate screen still shows.
  model.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (!switches(params) || model.buffer.active.type !== 'alternate') return false;
    const { normal } = model.buffer;
    // What it writes from here on starts at the normal screen's cursor, but never above a line the screen kept.
    const after = Math.max(normal.baseY + normal.cursorY, lastContentLine(normal) + 1);
    left = { screen: { cols: model.cols, rows: model.rows, data: flattened(model, serializer, scrollback) }, at: now(), after };
    return false;
  });
  model.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (switches(params)) left = undefined;
    return false;
  });
  return {
    last() {
      if (left === undefined || now() - left.at > LEFT_SCREEN_EXIT_MS) return undefined;
      // A few lines at most: one screen of them keeps it bounded. A full-screen program's normal screen holds next to
      // nothing, so it never scrolls far enough to trim its scrollback and move the line it was left at.
      const end = lastContentLine(model.buffer.normal);
      const start = Math.max(left.after, end - model.rows + 1);
      if (end < start) return left.screen;
      const since = serializer.serialize({ range: { start, end }, excludeAltBuffer: true, excludeModes: true });
      return { ...left.screen, data: `${left.screen.data}${PLAIN}\r\n${since}` };
    },
  };
}

/**
 * The terminal's normal screen and scrollback, then its alternate screen's rows under them, as one screen: the cursor
 * left at the end of its last row.
 */
function flattened(model: xtermHeadless.Terminal, serializer: xtermSerialize.SerializeAddon, scrollback: number): string {
  const { normal, alternate } = model.buffer;
  const first = Math.max(0, normal.length - (scrollback + model.rows));
  const lastNormal = lastContentLine(normal);
  const above = lastNormal < first ? '' : serializer.serialize({ range: { start: first, end: lastNormal }, excludeAltBuffer: true, excludeModes: true });
  // With a range, only that much of the normal screen comes first; the alternate one, whole, follows its marker.
  const both = serializer.serialize({ range: { start: 0, end: 0 }, excludeModes: true });
  const split = both.lastIndexOf(ALT_SCREEN_START);
  const lastAlternate = lastContentLine(alternate);
  if (split < 0 || lastAlternate < 0) return above;
  // It ends with the cursor moved to where the alternate screen's was: down (or up) from there to its last row.
  const toEnd = lastAlternate - alternate.cursorY;
  const move = toEnd > 0 ? `\x1b[${toEnd}B` : toEnd < 0 ? `\x1b[${-toEnd}A` : '';
  return `${above}${above === '' ? '' : `${PLAIN}\r\n`}${both.slice(split + ALT_SCREEN_START.length)}${move}`;
}

/** The last line of `buffer` that shows anything, or -1 if none does. */
function lastContentLine(buffer: Buffer): number {
  for (let line = buffer.length - 1; line >= 0; line--) if (buffer.getLine(line)?.translateToString(true) !== '') return line;
  return -1;
}
