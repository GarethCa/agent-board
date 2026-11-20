// How the app keeps where it left the board (its viewport, its windows, pop-outs' places) in the daemon's view state.
import { EXPANDED_HIDDEN_VIEW_KEY, EXPANDED_SIZES_VIEW_KEY, EXPANDED_VIEW_KEY, TILE_SIZES_VIEW_KEY, UNFOLDED_VIEW_KEY } from '@agent-board/daemon/board-layout';

/** The view state keys the app uses (`view.get`/`view.set`). */
export const VIEW_KEYS = {
  viewport: 'viewport',
  windows: 'windows',
  popOutBounds: 'popOutBounds',
  restartDismissed: 'restartBanner.dismissed',
  /** The session tiles expanded in place, with their sizes. The daemon reads it too, to lay tiles out at their size. */
  expanded: EXPANDED_VIEW_KEY,
  /** The expanded tiles whose session window is open, and their sizes: expanded again when it closes. The daemon reads it too, to keep their room. */
  hiddenExpanded: EXPANDED_HIDDEN_VIEW_KEY,
  /** The size each tile was last let go at once resized while expanded, by node id: it opens at that size again. */
  expandedSizes: EXPANDED_SIZES_VIEW_KEY,
  /**
   * The size each compact tile was resized to, by node id; a tile not in it is the default size. The daemon
   * reads it too, to lay tiles out at their size.
   */
  tileSizes: TILE_SIZES_VIEW_KEY,
  /** The closed agents the user unfolded from their chips, by node id; the rest of the closed ones are chips. The daemon reads it too. */
  unfolded: UNFOLDED_VIEW_KEY,
  /** The tiles dragged onto another, one of them expanded, by node id: left there, over it, not moved clear. */
  expandedOverlaps: 'expandedTiles.overlaps',
  /** The tiles put down while tiles were expanded, by node id, with those tiles: not pushed with their rows again. */
  putDown: 'expandedTiles.putDown',
  /** Whether onboarding was finished or skipped, and whether the board menu offers it again. */
  onboarding: 'onboarding',
  /** Whether onboarding sent its test notification, the one that makes the OS ask; not whether the OS allowed it. */
  notificationsTested: 'notifications.tested',
  /** Whether a drag snaps to the grid rather than to what is near it. */
  snapToGrid: 'snapToGrid',
  /** The session window shown on the board: its size and place, and whether it is maximised. */
  windowFrame: 'windowFrame',
  /** What a double-click on an agent's or shell tile opens: its session window or the tile expanded in place. */
  clickOpens: 'clickOpens',
  /** Which connections the board draws, all, hand-offs only or none. */
  connections: 'connections',
  /** Whether the board draws its tethers: the Captain's to the orchestrators it watches, and clocks' and agent notes' lines to their agents. Off by default. */
  tethers: 'tethers',
  /** How agent notes look: document cards or terminal cards. */
  agentNoteLook: 'agentNoteLook',
  /** Whether terminals draw with the GPU (xterm's WebGL renderer), falling back to the DOM renderer: on unless turned off. */
  gpuTerminals: 'gpuTerminals',
  /** Whether an open pane's terminal stays alive while it is off screen: off unless turned on. */
  keepTerminals: 'keepTerminals',
  /** Which of its quiet parts an agent's Classic tile shows at rest (Settings › Board › Agent tiles): the quiet tile unless set. */
  tileShows: 'tileShows',
  /** When the chat's Expand all / Collapse all show: always unless set to show on hover. */
  chatRunsShow: 'chatRunsShow',
  /** How a ticket's tile opens, Settings › Board › Agent tiles: its chat's terminal unless set to the clean card. */
  ticketTilesOpenAs: 'ticketTiles.openAs',
  /** The ticket tiles switched by hand to the card or the terminal, by node id: each keeps its own view. */
  ticketViews: 'ticketTiles.views',
  /** Which board the window shows: a ticket's own board, zoomed into from its tile (`{ ticket }`, its chat's session id), else the main board. */
  boardLevel: 'board.level',
  /** The order a pop-up's row of tabs was dragged into, by owner (`ticket:<chat's session id>`): each its tabs' keys, left to right. */
  popUpTabOrder: 'popUp.tabOrder',
  /** Whether the plan usage pill shows on the board, beside the zoom controls: off unless turned on. */
  usageOnBoard: 'usageOnBoard',
  /** Whether the keys added since the key registry work, the "Extended keyboard shortcuts" setting: on unless turned off. */
  extendedShortcuts: 'keyboard.extendedShortcuts',
  /** When the user last looked at the Overview window, as an ISO time: its "since HH:MM", which Mark all seen moves. */
  overviewSeenAt: 'overview.seenAt',
} as const;

/** Saves one view state key, a little after the last change: see `viewSaver`. */
export interface ViewSaver {
  (value: unknown): void;
  /** Sends the value waiting, if one is, at once; settles once it, and any save already on its way, have. */
  flush(): Promise<void>;
}

/** The flushes of the savers in this process with a save waiting or on its way. */
const unsaved = new Set<() => Promise<void>>();

/**
 * A saver for one view state key: each call replaces the value waiting to be saved, which is saved once `delayMs`
 * passes without another, or at once when it is flushed (`flushViewSaves`, as the app quits). Saving is best-effort: a
 * failure leaves the last saved value.
 */
export function viewSaver(set: (value: unknown) => Promise<unknown>, delayMs: number): ViewSaver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: { value: unknown } | undefined;
  let onItsWay: Promise<void> | undefined;
  const send = (): Promise<void> => {
    clearTimeout(timer);
    if (waiting !== undefined) {
      const { value } = waiting;
      waiting = undefined;
      const sent: Promise<void> = set(value).then(
        () => {},
        () => {},
      );
      onItsWay = sent;
      void sent.then(() => {
        if (onItsWay !== sent) return;
        onItsWay = undefined;
        if (waiting === undefined) unsaved.delete(send);
      });
    }
    return onItsWay ?? Promise.resolve();
  };
  return Object.assign(
    (value: unknown) => {
      waiting = { value };
      unsaved.add(send);
      clearTimeout(timer);
      timer = setTimeout(() => void send(), delayMs);
    },
    { flush: send },
  );
}

/** Sends every save waiting in this process at once (`ViewSaver.flush`); settles once they all have. */
export async function flushViewSaves(): Promise<void> {
  await Promise.all([...unsaved].map((flush) => flush()));
}
