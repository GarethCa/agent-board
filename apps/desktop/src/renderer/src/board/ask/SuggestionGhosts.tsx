import { createContext, Fragment, memo, useCallback, useContext, useMemo, type CSSProperties } from 'react';
import { useStore, ViewportPortal, type ReactFlowState } from '@xyflow/react';
import { Check, X } from 'lucide-react';
import { DEFAULT_CONNECTOR_LOOK, type BoardItem, type Connector, type ConnectorEndType, type SuggestedEdit, type UpdateItemParams } from '@agent-board/daemon/protocol';
import type { Rect } from '../../geometry';
import { nodeIdOf } from '../connectors/endpoints';
import { agentNoteData } from '../items/agent-note';
import { boundsOnBoard, isItemNode, placeOnBoard } from '../items/items';
import { ShapeParts } from '../items/shapes/ShapeArt';
import { newShapeData } from '../items/text-style';
import { chipAt, sideMiddle, suggestionPlan, withoutSuggestions, type SuggestionPlan } from './suggestions';

/** What a note's suggested edits can be asked to do: become real, or go. All of them without `ids`. */
export interface SuggestionActions {
  accept(noteId: string, ids?: readonly string[]): void;
  dismiss(noteId: string, ids?: readonly string[]): void;
}

const nothing = () => {};
export const SuggestionActionsContext = createContext<SuggestionActions>({ accept: nothing, dismiss: nothing });
export const useSuggestionActions = () => useContext(SuggestionActionsContext);

/** An object's box on the board, as the board has drawn it; undefined once it has gone. */
function rectIn(state: ReactFlowState, object: { type: ConnectorEndType; id: string }): Rect | undefined {
  const node = state.nodeLookup.get(nodeIdOf(object));
  if (node === undefined) return undefined;
  return boundsOnBoard(node.internals.userNode, { ...node.internals.positionAbsolute, width: node.measured.width ?? 0, height: node.measured.height ?? 0 });
}

/** The agent notes with suggestions waiting, as `[note id, its suggestions]`. */
function waiting(state: ReactFlowState): [string, SuggestedEdit[]][] {
  const found: [string, SuggestedEdit[]][] = [];
  for (const node of state.nodeLookup.values()) {
    const user = node.internals.userNode;
    if (!isItemNode(user) || user.data.item.kind !== 'agent-note') continue;
    const { suggestions } = agentNoteData(user.data.item.data);
    if (suggestions !== undefined && suggestions.length > 0) found.push([user.data.item.id, suggestions]);
  }
  return found;
}

interface SuggestionActionOptions {
  /** The item on the board, by id. */
  item(id: string): BoardItem | undefined;
  rectOf(object: { type: ConnectorEndType; id: string }): Rect | undefined;
  putItem(item: BoardItem): void;
  putConnector(connector: Connector): void;
  updateItem(params: UpdateItemParams): void;
  zoneLayouts(): (Rect & { id: string })[];
  topZ(): number;
}

/**
 * Accepting a suggestion makes its shapes and arrows real and takes it off its note; dismissing one only takes it off.
 * Each is one undo step: undone, the shapes go and the note offers the suggestion again.
 */
export function useSuggestionCommands({ item, rectOf, putItem, putConnector, updateItem, zoneLayouts, topZ }: SuggestionActionOptions): SuggestionActions {
  const settle = useCallback(
    (noteId: string, ids: readonly string[] | undefined, make: boolean) => {
      const note = item(noteId);
      if (note === undefined) return;
      const suggestions = agentNoteData(note.data).suggestions ?? [];
      const picked = new Set(ids ?? suggestions.map((suggestion) => suggestion.id));
      if (make) {
        let z = topZ();
        const layouts = zoneLayouts();
        for (const suggestion of suggestions.filter((each) => picked.has(each.id))) {
          const plan = suggestionPlan(suggestion, rectOf, () => crypto.randomUUID());
          for (const shape of plan.shapes) {
            const size = { width: shape.rect.width, height: shape.rect.height };
            const data = { ...newShapeData(shape.shape), text: shape.text };
            putItem({ id: shape.id, kind: 'shape', ...placeOnBoard(shape.rect, size, layouts), ...size, z: ++z, rotation: 0, data, createdAt: '', updatedAt: '' });
          }
          for (const { id, from, to, label } of plan.connectors) {
            putConnector({ id, from, to, ...DEFAULT_CONNECTOR_LOOK, label, points: [], createdAt: '', updatedAt: '' });
          }
        }
      }
      updateItem({ id: noteId, data: { suggestions: withoutSuggestions(suggestions, picked) } });
    },
    [item, rectOf, putItem, putConnector, updateItem, zoneLayouts, topZ],
  );
  return useMemo(() => ({ accept: (noteId, ids) => settle(noteId, ids, true), dismiss: (noteId, ids) => settle(noteId, ids, false) }), [settle]);
}

/** Each waiting suggestion laid out on the board, with ids for drawing only. */
function plans(state: ReactFlowState): { noteId: string; suggestion: SuggestedEdit; plan: SuggestionPlan }[] {
  return waiting(state).flatMap(([noteId, suggestions]) =>
    suggestions.map((suggestion) => {
      let n = 0;
      return { noteId, suggestion, plan: suggestionPlan(suggestion, (object) => rectIn(state, object), () => `${noteId}:${suggestion.id}:${n++}`) };
    }),
  );
}

const samePlans = (a: ReturnType<typeof plans>, b: ReturnType<typeof plans>) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The suggested edits of every Ask Claude answer on the board (CM3, CPb): each shape and arrow drawn dashed in the accent
 * colour where it would go, and a chip with its number, its title, ✓ to make it real and ✕ to dismiss it.
 */
export const SuggestionGhosts = memo(function SuggestionGhosts() {
  const shown = useStore(plans, samePlans);
  const zoom = useStore((state) => state.transform[2]);
  const { accept, dismiss } = useSuggestionActions();
  if (shown.length === 0) return null;
  return (
    <ViewportPortal>
      <div className="suggestion-ghosts" data-testid="suggestion-ghosts" style={{ '--zoom': zoom } as CSSProperties}>
        <svg className="suggestion-ghost-lines" aria-hidden>
          <defs>
            <marker id="suggestion-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" />
            </marker>
          </defs>
        </svg>
        {shown.map(({ noteId, suggestion, plan }) => {
          const chip = chipAt(plan);
          return (
            <Fragment key={`${noteId}:${suggestion.id}`}>
              {plan.shapes.map((shape) => (
                <div
                  key={shape.id}
                  className="suggestion-ghost"
                  data-testid="suggestion-ghost"
                  style={{ '--ghost-x': `${shape.rect.x}px`, '--ghost-y': `${shape.rect.y}px`, width: shape.rect.width, height: shape.rect.height } as CSSProperties}
                >
                  <svg width={shape.rect.width} height={shape.rect.height} aria-hidden>
                    <ShapeParts shape={shape.shape} width={shape.rect.width} height={shape.rect.height} strokeWidth={1.5} dashed />
                  </svg>
                  {shape.text !== '' && <span className="suggestion-ghost-text">{shape.text}</span>}
                </div>
              ))}
              <svg className="suggestion-ghost-lines" aria-hidden>
                {plan.connectors.map((connector) => {
                  const a = sideMiddle(connector.fromRect, connector.from.side);
                  const b = sideMiddle(connector.toRect, connector.to.side);
                  return <path key={connector.id} d={`M${a.x} ${a.y}L${b.x} ${b.y}`} markerEnd="url(#suggestion-arrow)" />;
                })}
              </svg>
              {chip !== undefined && (
                <div
                  className="suggestion-chip nodrag nopan"
                  data-testid="suggestion-chip"
                  style={{ '--chip-x': `${chip.x}px`, '--chip-y': `${chip.y}px` } as CSSProperties}
                >
                  <span className="suggestion-chip-num">{suggestion.id}</span>
                  <span className="suggestion-chip-title">{suggestion.title}</span>
                  <button type="button" className="suggestion-chip-ok" aria-label={`Accept ${suggestion.title}`} onClick={() => accept(noteId, [suggestion.id])}>
                    <Check aria-hidden />
                  </button>
                  <button type="button" className="suggestion-chip-no" aria-label={`Dismiss ${suggestion.title}`} onClick={() => dismiss(noteId, [suggestion.id])}>
                    <X aria-hidden />
                  </button>
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </ViewportPortal>
  );
});
