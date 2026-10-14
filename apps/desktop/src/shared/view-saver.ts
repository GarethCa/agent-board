// How the app keeps where it left the board (its viewport, its windows, pop-outs' places) in the daemon's view state.

/** The view state keys the app uses (`view.get`/`view.set`). */
export const VIEW_KEYS = {
  viewport: 'viewport',
  windows: 'windows',
  popOutBounds: 'popOutBounds',
  restartDismissed: 'restartBanner.dismissed',
  /** The session tiles expanded in place, with their sizes. */
  expanded: 'expandedTiles',
  /** The size each tile was last let go at once resized while expanded, by node id: it opens at that size again. */
  expandedSizes: 'expandedTiles.sizes',
  /** The size each compact tile was resized to, by node id; a tile not in it is the default size. */
  tileSizes: 'tileSizes',
  /** The tiles dragged onto another, one of them expanded, by node id: left there, over it, not moved clear. */
  expandedOverlaps: 'expandedTiles.overlaps',
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
  /** How the board shows the agents an orchestrator started: in a crew frame beside it, or with a "from" chip. */
  crewLook: 'crewLook',
} as const;

/**
 * A saver for one view state key: each call replaces the value waiting to be saved, which is saved once `delayMs`
 * passes without another. Saving is best-effort: a failure leaves the last saved value.
 */
export function viewSaver(set: (value: unknown) => Promise<unknown>, delayMs: number): (value: unknown) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (value) => {
    clearTimeout(timer);
    timer = setTimeout(() => void set(value).catch(() => {}), delayMs);
  };
}
