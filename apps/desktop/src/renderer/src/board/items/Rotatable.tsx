// The Rotate tool: an item turns about its own centre, by its handle or, for a selection of several, by the
// selection box's. Only ever by the user: every item starts straight.
import { createContext, memo, useContext, useEffect, useRef, useSyncExternalStore, type ComponentProps, type ComponentType, type CSSProperties, type PointerEvent } from 'react';
import { useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { RotateCw } from 'lucide-react';
import { Kbd, Tooltip } from '../../ui';
import { centreOf, type Point } from '../../geometry';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { angleAt, ROTATION_SNAP, rotatedBy } from './rotation';
import { keyText } from '../../keys/registry';

/** The angles of the items being turned, by item id, while a turn is under way: shown at once, saved as it ends. */
export interface LiveRotations {
  get(id: string): number | undefined;
  set(angles: ReadonlyMap<string, number>): void;
  subscribe(listener: () => void): () => void;
}

export function liveRotations(): LiveRotations {
  let angles: ReadonlyMap<string, number> = new Map();
  const listeners = new Set<() => void>();
  return {
    get: (id) => angles.get(id),
    set(next) {
      angles = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const LiveRotationsContext = createContext<LiveRotations>(liveRotations());

/** An item to turn: its id and the angle it starts at. */
interface Turning {
  id: string;
  rotation: number;
}

/**
 * Turns `items` as the pointer, pressed on a handle, goes round `centre` (on screen), each about its own centre and by
 * the same turn; Shift snaps each to `ROTATION_SNAP`. Saved once, as one undo step, when the pointer is let go.
 */
function useTurn(items: () => readonly Turning[], centre: (handle: Element) => Point) {
  const live = useContext(LiveRotationsContext);
  const { update } = useContext(ItemActionsContext);
  const turn = useRef<{ centre: Point; grab: number; items: readonly Turning[]; angles: Map<string, number> }>(undefined);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = centre(event.currentTarget);
    const start = items();
    turn.current = { centre: at, grab: angleAt(at, { x: event.clientX, y: event.clientY }), items: start, angles: new Map(start.map(({ id, rotation }) => [id, rotation])) };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = turn.current;
    if (current === undefined) return;
    const by = angleAt(current.centre, { x: event.clientX, y: event.clientY }) - current.grab;
    current.angles = new Map(current.items.map(({ id, rotation }) => [id, rotatedBy(rotation, by, event.shiftKey)]));
    live.set(current.angles);
  };
  const end = (save: boolean) => {
    const current = turn.current;
    if (current === undefined) return;
    turn.current = undefined;
    if (save) {
      for (const { id, rotation } of current.items) {
        const angle = current.angles.get(id)!;
        if (angle !== rotation) update({ id, rotation: angle });
      }
    }
    live.set(new Map());
  };
  return { onPointerDown, onPointerMove, onPointerUp: () => end(true), onPointerCancel: () => end(false) };
}

/**
 * The round handle that turns what it hangs from: under an item, or under the box round a selection of several. It is
 * the same size on screen at any zoom.
 */
function RotateHandle({ turn, testId }: { turn: ReturnType<typeof useTurn>; testId: string }) {
  const zoom = useStore((state) => state.transform[2]);
  return (
    <Tooltip
      side="bottom"
      content={
        <>
          Drag to turn it; hold <Kbd>{keyText('edit.snapTurn')}</Kbd> for {ROTATION_SNAP}° steps
        </>
      }
    >
      <RotateGrip
        data-testid={testId}
        style={{ '--zoom': zoom } as CSSProperties}
        {...turn}
        // Not a click on the board or the node under it, which would change the selection.
        onClick={(event) => event.stopPropagation()}
      />
    </Tooltip>
  );
}

/**
 * The handle as drawn, for the board and the component gallery. `nodrag nopan`: the board neither moves it nor pans
 * from it; `nokey`: pressed with Shift held, it isn't the start of React Flow's Shift-marquee.
 */
export function RotateGrip(props: ComponentProps<'div'> & { 'data-preview'?: 'hover' }) {
  return (
    <div className="rotate-handle nodrag nopan nokey" role="presentation" {...props}>
      <RotateCw aria-hidden />
    </div>
  );
}

/** The middle of the board node holding `handle`, on screen: an item's centre, however it is turned. */
function nodeCentre(handle: Element): Point {
  return centreOf(handle.closest('.react-flow__node')!.getBoundingClientRect());
}

/** The handle under one item selected on its own. */
function ItemRotateHandle({ id, rotation }: Turning) {
  const turn = useTurn(() => [{ id, rotation }], nodeCentre);
  return <RotateHandle turn={turn} testId="rotate-handle" />;
}

/**
 * `Node`, an item kind's node, drawn at the item's angle with its connector handles (`Node` has them, inside), and
 * with a rotate handle while it is selected on its own. React Flow measures where a connector's handle is from the
 * page, so it is measured again as the angle changes. A turned item hides its resize handles: they would drag along
 * its straight edges.
 */
export function withRotation(Node: ComponentType<NodeProps<ItemNodeType>>): ComponentType<NodeProps<ItemNodeType>> {
  const Rotatable = memo(function Rotatable(props: NodeProps<ItemNodeType>) {
    const { id, data, selected, dragging } = props;
    const { item } = data;
    const live = useContext(LiveRotationsContext);
    const rotation = useSyncExternalStore(live.subscribe, () => live.get(item.id)) ?? item.rotation;
    const only = useOnlySelected(selected);
    const updateNodeInternals = useUpdateNodeInternals();
    const measured = useRef(rotation);
    useEffect(() => {
      if (measured.current === rotation) return;
      measured.current = rotation;
      updateNodeInternals(id);
    }, [id, rotation, updateNodeInternals]);

    return (
      <div className="item-rotor" data-rotated={rotation !== 0 ? '' : undefined} data-rotation={rotation} style={{ rotate: `${rotation}deg` }}>
        <Node {...props} />
        {only && dragging !== true && data.editing !== true && <ItemRotateHandle id={item.id} rotation={item.rotation} />}
      </div>
    );
  });
  Rotatable.displayName = `Rotatable(${Node.displayName ?? Node.name})`;
  return Rotatable;
}

/** The items in a selection of several, with their angles, for its box's rotate handle. */
export function SelectionRotateHandle({ items }: { items: () => readonly Turning[] }) {
  const turn = useTurn(items, (handle) => centreOf(handle.closest('.selection-box')!.getBoundingClientRect()));
  return <RotateHandle turn={turn} testId="selection-rotate-handle" />;
}
