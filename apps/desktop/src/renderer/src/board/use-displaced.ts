import { useEffect, useMemo, useRef, useState } from 'react';
import { displaced, heldFrom, type Held } from './displace';
import type { ExpandedTiles, OverlapsAllowed } from './expanded';
import type { BoardNode } from './tiles';

/** The class of a node moved clear of an expanded tile, or going back: it eases there (app.css). */
const DISPLACED_CLASS = 'displaced';

/** How long a node that has gone back keeps easing: longer than the move, `--motion-base`. */
const SETTLE_MS = 400;

/** Nothing held: no drag or resize under way. */
const AT_REST: Held = new Map();

/**
 * `nodes` as the board draws them with `expanded` open and each pair in `overlapsAllowed` free to overlap
 * (`displaced`), the ones moved, and for a moment the ones going back, marked to ease there. While a drag or resize
 * is under way, everything starts from where it was drawn as it began (`held`), so starting one moves nothing. The
 * board's own nodes keep their places, so nothing moved is saved: a drag starts from where a node is drawn and ends
 * where it was dropped, as the board saves any drag.
 */
export function useDisplaced(nodes: BoardNode[], expanded: ExpandedTiles, overlapsAllowed: OverlapsAllowed): BoardNode[] {
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
  const shown = useMemo(() => displaced(nodes, expanded, overlapsAllowed, holding ?? AT_REST), [nodes, expanded, overlapsAllowed, holding]);
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
