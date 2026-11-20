/**
 * The tiles the user put down while tiles were expanded in place, by node id, each with the expanded tiles open then,
 * sorted. A drop saves where the tile was drawn, the push of those tiles already in it, so while any of them is still
 * open the tile is not pushed with its row or column again (`displaced`): it stays where it was put. Front-to-back
 * order, and tiles opened or closed elsewhere, change nothing. Hidden behind its session window, or pinned, a tile still
 * counts as open, as it comes back. Saved with the view, so it is the same after a restart.
 */
export type PutDown = ReadonlyMap<string, readonly string[]>;

const NONE: ReadonlySet<string> = new Set();

/** `putDown` with the tiles `ids` put down while the tiles `open` are expanded: none open, and they are put down plain. */
export function puttingDown(putDown: PutDown, ids: readonly string[], open: readonly string[]): PutDown {
  if (open.length === 0) return withoutPutDown(putDown, ids);
  const owners = [...new Set(open)].toSorted();
  return new Map([...putDown, ...ids.map((id) => [id, owners] as const)]);
}

/** `putDown` without the tiles `ids`: moved any other way (nudged, undone, tidied, arranged) or gone, so pushed with their rows again. */
export function withoutPutDown(putDown: PutDown, ids: Iterable<string>): PutDown {
  const gone = new Set(ids);
  const kept = [...putDown].filter(([id]) => !gone.has(id));
  return kept.length === putDown.size ? putDown : new Map(kept);
}

/**
 * `putDown` with only the expanded tiles still `open` (expanded, hidden behind a window, or pinned), and without the
 * tiles whose tiles have all closed: drawn where saved, which is where they were put.
 */
export function keepPutDown(putDown: PutDown, open: ReadonlySet<string>): PutDown {
  let changed = false;
  const kept: [string, readonly string[]][] = [];
  for (const [id, owners] of putDown) {
    const still = owners.filter((owner) => open.has(owner));
    if (still.length !== owners.length) changed = true;
    if (still.length === 0) continue;
    kept.push([id, still.length === owners.length ? owners : still]);
  }
  return changed ? new Map(kept) : putDown;
}

/** The tiles put down, for `displaced`. */
export function putDownIds(putDown: PutDown): ReadonlySet<string> {
  return putDown.size === 0 ? NONE : new Set(putDown.keys());
}

/** As saved with the view: each tile's node id and the expanded tiles open when it was put down. */
export function savedPutDown(putDown: PutDown): [string, string[]][] {
  return [...putDown].map(([id, owners]): [string, string[]] => [id, [...owners]]).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The tiles put down, as saved from the last run (view state); anything else in it is left out. */
export function putDownFrom(saved: unknown): PutDown {
  if (!Array.isArray(saved)) return new Map();
  const entries = saved.flatMap((entry: unknown): [string, string[]][] => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return [];
    const owners = (entry[1] as unknown[]).filter((owner): owner is string => typeof owner === 'string');
    return owners.length === 0 ? [] : [[entry[0], owners.toSorted()]];
  });
  return new Map(entries);
}
