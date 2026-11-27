import type { ClickOpens } from './click-opens';
import type { WindowPath } from './expanded';
import type { TileData } from './tile';

/** A button in an expanded tile's header: what it is called and what its tooltip says. */
export type HeadButton = { label: string; tooltip: string };

/** The window buttons and the closing button an expanded tile's header shows, for the tile as it is now. */
export type HeadButtons = {
  /**
   * ⤢: an agent's pop-up, where it splits, under the pop-up's setting; else its session window, as a shell's. An
   * external session has neither.
   */
  maximise?: HeadButton & { open: 'popUp' | 'maximise'; path: WindowPath };
  /** Into an OS window of its own. */
  popOut?: HeadButton;
  /** Where the header ends: Unpin while pinned expanded, else Collapse. */
  closer: 'unpin' | 'collapse';
};

/**
 * What a double-click on an expanded tile's header opens: what a double-click on its tile opens, the pop-up or its
 * session window, asked for as the user's own (a tile pinned expanded opens it too, and is back, pinned, once it
 * closes). Under Expand in place, and for an external session, nothing: the tile is open already. The terminal below
 * keeps its double-click for selecting a word.
 */
export function headDoubleClick(setting: ClickOpens, { agent, shell }: Pick<TileData, 'agent' | 'shell'>): { open: 'popUp' | 'maximise'; path: WindowPath } | undefined {
  if (setting === 'expand' || (agent === undefined && shell === undefined)) return undefined;
  return setting === 'popup' && agent !== undefined ? { open: 'popUp', path: 'popUp' } : { open: 'maximise', path: 'maximise' };
}

/**
 * The header's window buttons, the same for a tile pinned expanded as for any other: pinned, its window and pop-out
 * open, and it is back where it was, pinned, once they close. Only the closing button differs. An agent's ⤢ opens what
 * opening its tile would, its pop-up by default; under the other settings, its session window.
 */
export function headButtons({ agent, shell }: Pick<TileData, 'agent' | 'shell'>, setting: ClickOpens = 'window'): HeadButtons {
  const windowed = agent !== undefined || shell !== undefined;
  const popUp = agent !== undefined && setting === 'popup';
  return {
    ...(windowed && {
      maximise: popUp
        ? { label: 'Open the pop-up', tooltip: 'Open its pop-up: bigger, and it can split', open: 'popUp', path: 'popUp' }
        : { label: 'Maximise', tooltip: 'Maximise into its session window', open: 'maximise', path: 'maximise' },
      popOut: { label: 'Pop out', tooltip: 'Into its own window' },
    }),
    closer: agent?.pinnedExpanded === true ? 'unpin' : 'collapse',
  };
}
