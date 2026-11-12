// What a memory's node and a queue's share on the board: their zone, the lift zoomed out, rows read again on each
// write, the add box focused once, the toolbar, and the peek's popover rules.
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { NodeToolbar, Position, useReactFlow, useStore } from '@xyflow/react';
import { ChevronsLeftRight, ChevronsRightLeft, Trash2, UserRoundCheck, UserRoundX } from 'lucide-react';
import { AnchoredPopover, IconButton, Kbd } from '../../ui';
import { keyText } from '../../keys/registry';
import { isZone } from '../tiles';

/** The zone with id `zoneId` as the board draws it: its name and colour. */
export function useZone(zoneId: string | null): { name?: string; color?: string } {
  const name = useStore((state) => {
    const node = zoneId === null ? undefined : state.nodeLookup.get(zoneId);
    return node !== undefined && isZone(node) ? node.data.zone.name : undefined;
  });
  const color = useStore((state) => {
    const node = zoneId === null ? undefined : state.nodeLookup.get(zoneId);
    return node !== undefined && isZone(node) ? node.data.zone.color : undefined;
  });
  return { name, color };
}

/** The board zoom below which a folded one's face stops shrinking with it, so it still reads as what it is. */
const ICON_MIN_ZOOM = 0.6;

/**
 * How much a folded one's face is scaled up against the board's zoom: 1 down to `ICON_MIN_ZOOM`, then enough to keep it
 * at that size. Only a folded one listens, and only below it does the value change.
 */
export function useLift(folded: boolean): number {
  return useStore((state) => (folded ? Math.max(1, Math.round((ICON_MIN_ZOOM / state.transform[2]) * 20) / 20) : 1));
}

/**
 * What it holds, read again whenever it is written: every write moves the card's `updatedAt`, as its count is saved with
 * it. Undefined until first read. A read that fails says so, and the next write reads again.
 */
export function useRows<Rows>(id: string, updatedAt: string, read: (id: string) => Promise<Rows>, failed: (error: unknown) => void): Rows | undefined {
  const [rows, setRows] = useState<Rows>();
  const calls = useRef({ read, failed });
  calls.current = { read, failed };
  useEffect(() => {
    let current = true;
    calls.current.read(id).then(
      (read) => current && setRows(read),
      (error: unknown) => current && calls.current.failed(error),
    );
    return () => {
      current = false;
    };
  }, [id, updatedAt]);
  return rows;
}

/**
 * Whether a card just made focuses its add box: once. The node's `editing` flag goes as it is used, or the box would
 * take the focus again each time the card is drawn anew (scrolled back into view, unfolded).
 */
export function useFocusOnce(nodeId: string, editing: boolean | undefined): boolean {
  const { updateNodeData } = useReactFlow();
  const [focus, setFocus] = useState(editing === true);
  useEffect(() => {
    if (editing !== true) return;
    updateNodeData(nodeId, { editing: false });
    setFocus(false);
  }, [editing, nodeId, updateNodeData]);
  return focus;
}

/** How long an agent's change flashes its row, and the folded icon says what it did. */
const FRESH_MS = 4000;

/**
 * The row an agent changed since the card last read, for a few seconds after: `freshOf` picks it from the rows and the
 * last change seen, `newestOf` is that change. Its timer runs on through later reads (the user's own reply to it, say),
 * and only a newer agent change starts it again.
 */
export function useFresh<Row>(rows: Row[] | undefined, freshOf: (rows: Row[], seen: string | undefined) => Row | undefined, newestOf: (rows: Row[]) => string | undefined): Row | undefined {
  const seen = useRef<string>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [fresh, setFresh] = useState<Row>();
  const pick = useRef({ freshOf, newestOf });
  pick.current = { freshOf, newestOf };
  useEffect(() => {
    if (rows === undefined) return;
    const changed = pick.current.freshOf(rows, seen.current);
    seen.current = pick.current.newestOf(rows) ?? seen.current ?? '';
    if (changed === undefined) return;
    setFresh(changed);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFresh(undefined), FRESH_MS);
  }, [rows]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return fresh;
}

export const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface ListCardToolbarProps {
  visible: boolean;
  folded: boolean;
  onFold(folded: boolean): void;
  /** Its No agents switch, with who may use it otherwise; none for one no agent reads anyway. */
  agents?: { noAgents: boolean; scope: string; toggle(): void };
  /** "memory" or "queue", for Delete's label. */
  noun: string;
  onDelete(): void;
  /** Buttons of its own, before Delete. */
  children?: ReactNode;
}

/** The toolbar over a selected memory or queue: fold or open, keep it from agents, and delete. */
export function ListCardToolbar({ visible, folded, onFold, agents, noun, onDelete, children }: ListCardToolbarProps) {
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} className="sticky-toolbar">
      <IconButton
        icon={folded ? <ChevronsLeftRight /> : <ChevronsRightLeft />}
        size="sm"
        aria-label={folded ? 'Open the card' : 'Fold to its icon'}
        tooltip={folded ? 'Open the card' : 'Fold to its icon'}
        onClick={() => onFold(!folded)}
      />
      {agents !== undefined && (
        <IconButton
          icon={agents.noAgents ? <UserRoundX /> : <UserRoundCheck />}
          size="sm"
          aria-label={agents.noAgents ? 'Let agents use it' : 'Keep it from agents'}
          tooltip={agents.noAgents ? `Let agents use it: ${agents.scope}` : 'Keep it from agents: only you read it'}
          onClick={agents.toggle}
        />
      )}
      {children}
      <IconButton
        icon={<Trash2 />}
        size="sm"
        aria-label={`Delete ${noun}`}
        tooltip={
          <>
            Delete {noun}
            <Kbd>{keyText('edit.delete')}</Kbd>
          </>
        }
        onClick={onDelete}
      />
    </NodeToolbar>
  );
}

/**
 * The peek over the board, beside its card. A toast's Undo is pressed with the peek still open, and it stays open to show
 * it: the toast may be gone from the page by the time the press is heard, so a press on what is no longer there counts as
 * one. Esc while editing a row puts the row back, and leaves the peek open.
 */
export function ListCardPeekPopover(props: Omit<ComponentProps<typeof AnchoredPopover>, 'onPointerDownOutside' | 'onEscapeKeyDown'>) {
  return (
    <AnchoredPopover
      {...props}
      onPointerDownOutside={(event) => {
        if (event.target instanceof Element && (!event.target.isConnected || event.target.closest('.ui-toasts') !== null)) event.preventDefault();
      }}
      onEscapeKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest('.listcard-edit') !== null) event.preventDefault();
      }}
    />
  );
}
