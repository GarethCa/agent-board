/** How close to the bottom, in pixels, still counts as reading the latest: new messages then scroll into view. */
export const STICK_DISTANCE = 48;

/** Where a scroller stands: how tall what it holds is, how far down it is scrolled, and how much of it shows. */
export interface ScrollAt {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/**
 * Whether a chat still follows its conversation after a scroll, given whether it did before and where the scroll
 * before this one left it. It does when its end is near. While it follows, a scroll that did not go up keeps it
 * following, however far off the end is: only the reader scrolls up. The chat's own scroll to its end, and the
 * browser's as the log changes size, come as events after what the log holds may have grown again, with the end out of
 * reach for a moment.
 *
 * The browser sends one scroll event a frame. When the chat's own scroll to its end and a small scroll up by the reader
 * fall in the same frame, the event can show no scroll up: the chat follows once more, and the reader's next scroll up
 * stops it.
 */
export function stillFollowing(was: boolean, at: ScrollAt, lastTop: number): boolean {
  if (at.scrollHeight - at.scrollTop - at.clientHeight < STICK_DISTANCE) return true;
  return was && at.scrollTop >= lastTop;
}
