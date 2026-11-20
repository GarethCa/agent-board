import { useEffect, useMemo, useRef, useState } from 'react';
import { displaced, geometryKey, heldFrom, redisplaced, type Held } from './displace';
import type { ExpandedTiles, OverlapsAllowed } from './expanded';
import type { TileSizes } from './tile-size';
import type { BoardNode } from './tiles';

/** The class of a node moved clear of an expanded tile, or going back: it eases there (app.css). */
const DISPLACED_CLASS = 'displaced';

/** How long a node that has gone back keeps easing: longer than the move, `--motion-base`. */
const SETTLE_MS = 400;

/** Nothing held: no drag or resize under way. */
const AT_REST: Held = new Map();

/** No crew to move as one. */
const NO_CREWS: readonly (readonly string[])[] = [];

/** No tile pinned expanded. */
const NOT_PINNED: ReadonlySet<string> = new Set();

/** No tile put down while tiles are expanded. */
const NONE_PUT: ReadonlySet<string> = new Set();

/** No tile resized while compact. */
const NO_SIZES: TileSizes = {};

/**
 * `nodes` as the board draws them with `expanded` open, each pair in `overlapsAllowed` free to overlap and each of
 * `crews` moved as one, each of `pinned` kept where it is (`displaced`), the ones moved, and for a moment the ones going back, marked to ease there. While a drag or resize
 * is under way, everything starts from where it was drawn as it began (`held`), so starting one moves nothing. The
 * board's own nodes keep their places, so nothing moved is saved: a drag starts from where a node is drawn and ends
 * where it was dropped, as the board saves any drag. What was dropped is saved where it was drawn, pushed already: while
 * a tile open then stays open it is not pushed with its row or column again (`putDown`), so it stays where it was put.
 */
export function useDisplaced(
  nodes: BoardNode[],
  expanded: ExpandedTiles,
  overlapsAllowed: OverlapsAllowed,
  crews: readonly (readonly string[])[] = NO_CREWS,
  compactSizes: TileSizes = NO_SIZES,
  pinned: ReadonlySet<string> = NOT_PINNED,
  putDown: ReadonlySet<string> = NONE_PUT,
): BoardNode[] {
  const changing = nodes.some((node) => node.dragging === true || node.resizing === true);
  /** The nodes, and where they were drawn, as last rendered with nothing changing: what a change starts from. */
  const rest = useRef<{ nodes: BoardNode[]; shown: BoardNode[] }>(undefined);
  const [held, setHeld] = useState<Held>();
  // Taken while rendering, so the first frame of the change already starts from it.
  let holding = held;
  if (changing && held === undefined && rest.current !== undefined) {
    holding = heldFrom(rest.current.nodes, rest.current.shown);
    setHeld(holding);
  } else if (!changing && held !== undefined) {
    holding = undefined;
    setHeld(undefined);
  }
  // Laid out again only when what `displaced` reads changes: an agent's status line changing anywhere gives a new
  // `nodes`, and the last layout is moved onto it as it was.
  const geometry = geometryKey(nodes);
  const laidOut = useMemo(
    () => ({ nodes, shown: displaced(nodes, expanded, overlapsAllowed, holding ?? AT_REST, crews, compactSizes, pinned, putDown) }),
    // `geometry` stands for `nodes`: the same key, the same layout.
    [geometry, expanded, overlapsAllowed, holding, crews, compactSizes, pinned, putDown],
  );
  const shown = useMemo(() => (laidOut.nodes === nodes ? laidOut.shown : redisplaced(nodes, laidOut.nodes, laidOut.shown)), [laidOut, nodes]);
  // Kept as it renders, not after an effect: a change in the very next render starts from this one.
  if (!changing) rest.current = { nodes, shown };
  // `displaced` keeps the nodes in order, and the ones it doesn't move as they were.
  const moved = useMemo(() => new Set(shown.filter((node, index) => node !== nodes[index]).map((node) => node.id)), [nodes, shown]);
  const key = [...moved].toSorted().join('\n');
  const [last, setLast] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: '', ids: new Set() });
  const [returning, setReturning] = useState<ReadonlySet<string>>(new Set());
  // Worked out while rendering, not after: the node must have the class in the same frame it starts going back.
  if (key !== last.key) {
    setLast({ key, ids: moved });
    const back = [...last.ids].filter((id) => !moved.has(id));
    if (back.length > 0) setReturning(new Set([...returning, ...back]));
  }
  useEffect(() => {
    if (returning.size === 0) return;
    const timer = setTimeout(() => setReturning(new Set()), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [returning]);

  return useMemo(() => {
    if (moved.size === 0 && returning.size === 0) return shown;
    return shown.map((node) =>
      moved.has(node.id) || returning.has(node.id)
        ? { ...node, className: node.className === undefined ? DISPLACED_CLASS : `${node.className} ${DISPLACED_CLASS}` }
        : node,
    );
  }, [shown, moved, returning]);
}
