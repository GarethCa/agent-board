// An Ask Claude answer's suggested edits: what each draws as a ghost on the diagram, and what accepting it makes.
import type { ConnectorEnd, ConnectorEndType, ConnectorSide, ShapeType, SuggestedEdit, SuggestedEnd } from '@agent-board/daemon/protocol';
import type { Rect } from '../../geometry';
import { autoSides } from '../connectors/endpoints';

/** What a suggestion makes once accepted, or draws while it waits: its shapes on the board, and its arrows' ends. */
export interface SuggestionPlan {
  shapes: { id: string; shape: ShapeType; text: string; rect: Rect }[];
  connectors: { id: string; from: ConnectorEnd; to: ConnectorEnd; label: string; fromRect: Rect; toRect: Rect }[];
}

/**
 * `suggestion` laid out on the board: each shape under an id from `newId`, and each arrow between two of its shapes or
 * objects still on the board (`rectOf`), on the sides that face each other. An arrow to an object that has gone is left
 * out.
 */
export function suggestionPlan(
  suggestion: SuggestedEdit,
  rectOf: (object: { type: ConnectorEndType; id: string }) => Rect | undefined,
  newId: () => string,
): SuggestionPlan {
  const shapes = suggestion.shapes.map(({ key, shape, text, x, y, width, height }) => ({ key, id: newId(), shape, text, rect: { x, y, width, height } }));
  const byKey = new Map(shapes.map((shape) => [shape.key, shape]));
  const resolve = (end: SuggestedEnd): { type: ConnectorEndType; id: string; rect: Rect } | undefined => {
    if ('shape' in end) {
      const shape = byKey.get(end.shape);
      return shape === undefined ? undefined : { type: 'item', id: shape.id, rect: shape.rect };
    }
    const rect = rectOf(end.object);
    return rect === undefined ? undefined : { ...end.object, rect };
  };
  const connectors = suggestion.arrows.flatMap((arrow) => {
    const from = resolve(arrow.from);
    const to = resolve(arrow.to);
    if (from === undefined || to === undefined) return [];
    const { fromSide, toSide } = autoSides('auto', 'auto', from.rect, to.rect);
    return [
      {
        id: newId(),
        from: { type: from.type, id: from.id, side: fromSide },
        to: { type: to.type, id: to.id, side: toSide },
        label: arrow.label,
        fromRect: from.rect,
        toRect: to.rect,
      },
    ];
  });
  return { shapes: shapes.map(({ id, shape, text, rect }) => ({ id, shape, text, rect })), connectors };
}

/** The middle of `side` of `rect`, where a ghost arrow leaves or arrives. */
export function sideMiddle(rect: Rect, side: ConnectorSide): { x: number; y: number } {
  if (side === 'top' || side === 'bottom') return { x: rect.x + rect.width / 2, y: side === 'top' ? rect.y : rect.y + rect.height };
  return { x: side === 'left' ? rect.x : rect.x + rect.width, y: rect.y + rect.height / 2 };
}

/** The note's suggestions once `ids` have been accepted or dismissed. */
export const withoutSuggestions = (suggestions: readonly SuggestedEdit[], ids: ReadonlySet<string>): SuggestedEdit[] =>
  suggestions.filter((suggestion) => !ids.has(suggestion.id));

/** The gap between a ghost and its chip, px. */
const CHIP_GAP = 8;

/** Where a suggestion's ✓/✕ chip starts: right of its first shape, level with its middle; else at its first arrow's middle. */
export function chipAt(plan: SuggestionPlan): { x: number; y: number } | undefined {
  const [shape] = plan.shapes;
  if (shape !== undefined) return { x: shape.rect.x + shape.rect.width + CHIP_GAP, y: shape.rect.y + shape.rect.height / 2 };
  const [arrow] = plan.connectors;
  if (arrow === undefined) return undefined;
  const a = sideMiddle(arrow.fromRect, arrow.from.side);
  const b = sideMiddle(arrow.toRect, arrow.to.side);
  return { x: (a.x + b.x) / 2 + CHIP_GAP, y: (a.y + b.y) / 2 };
}
