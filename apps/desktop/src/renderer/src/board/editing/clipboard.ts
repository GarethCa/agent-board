// Copying board items: what goes on the clipboard, and the copies a paste or a duplicate makes from it.

import { BOARD_ITEM_KINDS, DEFAULT_CONNECTOR_LOOK, type BoardItem, type BoardItemKind, type Connector } from '@agent-board/daemon/protocol';
import { boundsOf } from './snap';
import { createParamsOf } from '../connectors/endpoints';

/** The clipboard type board items are copied under, beside plain text for other apps. */
export const BOARD_CLIPBOARD_TYPE = 'application/x-agent-board+json';

/** An item as copied: where it is on the board, out of any zone, at its angle. */
export type CopiedItem = Pick<BoardItem, 'id' | 'kind' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'data'>;
/** A connector between two copied items, as copied. */
export type CopiedConnector = Omit<Connector, 'createdAt' | 'updatedAt'>;

export interface Copied {
  items: CopiedItem[];
  connectors: CopiedConnector[];
}

/** A copy of `items`, each at its place on the board `at`, with those of `connectors` that join two of them. */
export function copied(items: readonly { item: BoardItem; at: { x: number; y: number } }[], connectors: readonly Connector[]): Copied {
  const ids = new Set(items.map(({ item }) => item.id));
  const joinsCopied = (end: Connector['from']) => end.type === 'item' && ids.has(end.id);
  return {
    items: items.map(({ item: { id, kind, width, height, rotation, data }, at }) => ({ id, kind, x: at.x, y: at.y, width, height, rotation, data })),
    connectors: connectors
      .filter((connector) => joinsCopied(connector.from) && joinsCopied(connector.to))
      .map(createParamsOf),
  };
}

/** The middle of what was copied, on the board. */
export function centreOf({ items }: Copied): { x: number; y: number } {
  const { x, y, width, height } = boundsOf(items) ?? { x: 0, y: 0, width: 0, height: 0 };
  return { x: x + width / 2, y: y + height / 2 };
}

/** The copies to make: each item shifted by `shift` under a new id, and the connectors between them, joined to the copies. */
export function placed(copy: Copied, shift: { dx: number; dy: number }, newId: () => string): Copied {
  const ids = new Map(copy.items.map((item) => [item.id, newId()]));
  return {
    items: copy.items.map((item) => ({ ...item, id: ids.get(item.id)!, x: item.x + shift.dx, y: item.y + shift.dy })),
    connectors: copy.connectors.map((connector) => ({
      ...connector,
      id: newId(),
      from: { ...connector.from, id: ids.get(connector.from.id)! },
      to: { ...connector.to, id: ids.get(connector.to.id)! },
    })),
  };
}

export const serialiseCopied = (copy: Copied): string => JSON.stringify(copy);

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Whether `value` is a copied item; one copied before items had angles has none. */
function isCopiedItem(value: unknown): value is Omit<CopiedItem, 'rotation'> & { rotation?: number } {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    BOARD_ITEM_KINDS.includes(item.kind as BoardItemKind) &&
    [item.x, item.y, item.width, item.height].every(isNumber) &&
    (item.rotation === undefined || isNumber(item.rotation)) &&
    typeof item.data === 'object' &&
    item.data !== null
  );
}

/** What was copied, if `text` is a copy of board items; connectors whose ends weren't copied are left out. */
export function parseCopied(text: string): Copied | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { items, connectors } = value as Record<string, unknown>;
  if (!Array.isArray(items) || !items.every(isCopiedItem) || !Array.isArray(connectors)) return undefined;
  const ids = new Set(items.map((item) => item.id));
  const joins = (end: unknown) => typeof end === 'object' && end !== null && ids.has((end as { id?: unknown }).id as string);
  return {
    items: items.map((item) => ({ ...item, rotation: item.rotation ?? 0 })),
    connectors: (connectors as CopiedConnector[])
      .filter((connector) => typeof connector === 'object' && connector !== null && joins(connector.from) && joins(connector.to))
      // One copied before lines bent has none; one copied before dashes and end labels, the default look's.
      .map((connector) => ({ ...DEFAULT_CONNECTOR_LOOK, ...connector, points: Array.isArray(connector.points) ? connector.points.filter((point) => isNumber(point?.x) && isNumber(point.y)) : [] })),
  };
}

/** The copied items as other apps read them: each one's text, or its link, a paragraph each. */
export function plainText({ items }: Copied): string {
  return items
    .map(({ data }) => (typeof data.text === 'string' && data.text !== '' ? data.text : typeof data.url === 'string' ? data.url : ''))
    .filter((text) => text !== '')
    .join('\n\n');
}
