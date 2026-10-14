// Loading a list the daemon also announces changes to. The board subscribes before it lists, so no change is lost, but
// a change can cross the list in flight and be newer than it: such changes are kept and replayed over the list once it
// arrives, then applied directly. Pure, so it is unit-tested.

export interface ChangeBacklog<C> {
  /** Keeps `change` for the list in flight, saying so; false when nothing is being kept and it should be applied now. */
  hold(change: C): boolean;
  /** `listed` with every change kept meanwhile applied over it, in order. Nothing is kept after. */
  replayOver<T>(listed: T, apply: (current: T, change: C) => T): T;
  /** Starts keeping changes, afresh: a list is going out. */
  start(): void;
  /** Stops keeping changes and forgets those kept: the list failed. */
  drop(): void;
}

/** A backlog keeping changes from the start, unless `keeping` is false, when it waits for `start()`. */
export function changeBacklog<C>({ keeping = true }: { keeping?: boolean } = {}): ChangeBacklog<C> {
  let kept: C[] | undefined = keeping ? [] : undefined;
  return {
    hold(change) {
      if (kept === undefined) return false;
      kept.push(change);
      return true;
    },
    replayOver(listed, apply) {
      const replayed = (kept ?? []).reduce(apply, listed);
      kept = undefined;
      return replayed;
    },
    start() {
      kept = [];
    },
    drop() {
      kept = undefined;
    },
  };
}
