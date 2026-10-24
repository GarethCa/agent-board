import { memo, type CSSProperties } from 'react';
import { Sparkles } from 'lucide-react';
import { useStore, useStoreApi, ViewportPortal, type ReactFlowState } from '@xyflow/react';
import type { BoardItemKind } from '@agent-board/daemon/protocol';
import { boundsOnBoard, isItemNode, ITEM_NODE_PREFIX } from '../items/items';
import { SelectionRotateHandle } from '../items/Rotatable';
import { AGENT_NODE_PREFIX, EXTERNAL_NODE_PREFIX, SHELL_NODE_PREFIX } from '../tiles';
import type { Rect } from '../../geometry';
import { selectedNodes } from './selection';
import { boundsOf, type Guide } from './snap';
import { keyText } from '../../keys/registry';
import { Kbd } from '../../ui';

/** What the selection box calls each kind of object, one and many. */
const NAMES: Record<BoardItemKind | 'zone' | 'agent' | 'shell' | 'external', [string, string]> = {
  sticky: ['note', 'notes'],
  text: ['text', 'texts'],
  shape: ['shape', 'shapes'],
  image: ['image', 'images'],
  link: ['link card', 'link cards'],
  issue: ['issue card', 'issue cards'],
  'agent-note': ['agent note', 'agent notes'],
  document: ['document', 'documents'],
  plan: ['plan card', 'plan cards'],
  clock: ['clock', 'clocks'],
  zone: ['zone', 'zones'],
  agent: ['agent', 'agents'],
  shell: ['shell', 'shells'],
  external: ['session', 'sessions'],
};

/** The kind of object a node is, by its id and type. */
function kindOf(id: string, type: string | undefined): keyof typeof NAMES | undefined {
  if (type === 'zone') return 'zone';
  if (id.startsWith(ITEM_NODE_PREFIX)) return type?.slice(ITEM_NODE_PREFIX.length) as BoardItemKind;
  if (id.startsWith(AGENT_NODE_PREFIX)) return 'agent';
  if (id.startsWith(SHELL_NODE_PREFIX)) return 'shell';
  if (id.startsWith(EXTERNAL_NODE_PREFIX)) return 'external';
  return undefined;
}

/** "4 selected · 3 notes, 1 agent". */
function selectionLabel(kinds: readonly (keyof typeof NAMES)[]): string {
  const counts = new Map<keyof typeof NAMES, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, count]) => `${count} ${NAMES[kind][count === 1 ? 0 : 1]}`);
  return `${kinds.length} selected · ${parts.join(', ')}`;
}

interface Box extends Rect {
  label: string;
  /** Whether it holds items, which its handle turns. */
  rotatable: boolean;
}

/** The box round the selected nodes, when there are two or more; what is in a selected zone counts with it. */
function selectedBox(state: ReactFlowState): Box | undefined {
  const { top } = selectedNodes(state.nodeLookup.values());
  if (top.length < 2) return undefined;
  const bounds = boundsOf(
    top.map((node) => boundsOnBoard(node, { ...node.internals.positionAbsolute, width: node.measured.width ?? 0, height: node.measured.height ?? 0 })),
  )!;
  const kinds = top.flatMap((node) => kindOf(node.id, node.type) ?? []);
  return { ...bounds, label: selectionLabel(kinds), rotatable: top.some(isItemNode) };
}

const sameBox = (a: Box | undefined, b: Box | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.label === b.label && a.rotatable === b.rotatable);

/** The selected items, each with its angle. */
function selectedItems(state: ReactFlowState) {
  return selectedNodes(state.nodeLookup.values())
    .all.map((node) => node.internals.userNode)
    .filter(isItemNode)
    .map((node) => ({ id: node.data.item.id, rotation: node.data.item.rotation }));
}

/**
 * One box round a selection of several, labelled with what is in it (WbTools), with Ask Claude… beside the label (CM)
 * and a handle under it that turns each item in it about its own centre.
 */
export const SelectionBox = memo(function SelectionBox({ onAsk }: { onAsk(): void }) {
  const box = useStore(selectedBox, sameBox);
  const zoom = useStore((state) => state.transform[2]);
  const store = useStoreApi();
  if (box === undefined) return null;
  return (
    <ViewportPortal>
      <div
        className="selection-box"
        data-testid="selection-box"
        style={{ '--box-x': `${box.x}px`, '--box-y': `${box.y}px`, '--box-width': `${box.width}px`, '--box-height': `${box.height}px`, '--zoom': zoom } as CSSProperties}
      >
        <span className="selection-box-head">
          <span className="selection-box-label" data-testid="selection-label">{box.label}</span>
          <button type="button" className="selection-box-ask nodrag nopan" onClick={onAsk}>
            <Sparkles aria-hidden />
            Ask Claude…
            <Kbd>{keyText('make.askClaude')}</Kbd>
          </button>
        </span>
        {box.rotatable && <SelectionRotateHandle items={() => selectedItems(store.getState())} />}
      </div>
    </ViewportPortal>
  );
});

/** The alignment guides of a drag, on the board. */
export function SnapGuides({ guides }: { guides: readonly Guide[] }) {
  if (guides.length === 0) return null;
  return (
    <ViewportPortal>
      <svg className="snap-guides" data-testid="snap-guides" aria-hidden="true">
        {guides.map((guide) =>
          guide.axis === 'x' ? (
            <line key={`x${guide.at}`} x1={guide.at} x2={guide.at} y1={guide.from} y2={guide.to} />
          ) : (
            <line key={`y${guide.at}`} x1={guide.from} x2={guide.to} y1={guide.at} y2={guide.at} />
          ),
        )}
      </svg>
    </ViewportPortal>
  );
}
