import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { SessionBody } from '../../session/SessionBody';
import { useSessionView } from '../../session/session-view';
import { ROW_TAB_TYPE } from '../../session/TabStrip';
import { Dividers, useDividerDrag } from '../../session/use-divider-drag';
import type { SplitTree } from '@agent-board/daemon/pane-layout';
import { atRightEdge, type SplitSide } from '../popup-split';
import type { PopUpSplitControl } from './use-agent-view-row';

/** A side of the split, as its divider drags it. */
type SideLeaf = { type: 'pane'; side: SplitSide };

const SPLIT_ID = 'popup-split';

const percent = (fraction: number) => `${fraction * 100}%`;

/**
 * The body's panes: the row's own pane (`children`), and split, the agent beside it on the right, its chat or terminal
 * as the header's switch has it, with no sidebar, strip or controls of its own; a divider between them drags. A tab
 * dropped on a pane shows there; one dropped at the right edge of a body not split opens beside.
 */
export function PopupPanes({ split, viewKey, children, className, id, role }: { split: PopUpSplitControl; viewKey: string; children: ReactNode; className: string; id: string; role: string | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const [view] = useSessionView(viewKey);
  const [over, setOver] = useState<SplitSide | 'edge'>();
  const { live, right } = split;
  const layout: SplitTree<SideLeaf> =
    live === undefined ? { type: 'pane', side: 'left' } : { type: 'split', id: SPLIT_ID, direction: 'horizontal', ratio: live.ratio, first: { type: 'pane', side: 'left' }, second: { type: 'pane', side: 'right' } };
  const latest = useRef(split);
  latest.current = split;
  const { geometry, dividers } = useDividerDrag(box, layout, (leaf) => leaf.side, (_id, ratio) => Promise.resolve(latest.current.ratio(ratio)), { onStep: () => latest.current.ratio(0.5) });
  const leftWidth = geometry.panes.find((pane) => pane.id === 'left')?.rect.width ?? 1;
  const sideAt = (clientX: number): SplitSide | 'edge' | undefined => {
    const rect = box.current?.getBoundingClientRect();
    if (rect === undefined) return undefined;
    const x = clientX - rect.left;
    if (live === undefined) return atRightEdge(x, rect.width) ? 'edge' : undefined;
    return x < rect.width * live.ratio ? 'left' : 'right';
  };
  const carries = (event: DragEvent) => event.dataTransfer.types.includes(ROW_TAB_TYPE);
  const pane = (side: SplitSide) => ({
    className: 'agent-popup-pane',
    'data-side': side,
    'data-testid': `agent-popup-pane-${side}`,
    'data-focused': (live !== undefined && live.focused === side) || undefined,
    onPointerDownCapture: () => split.focus(side),
    onFocusCapture: () => split.focus(side),
  });
  return (
    <div
      ref={box}
      className={className}
      id={id}
      role={role}
      data-split={live !== undefined || undefined}
      data-drop={over}
      onDragOver={(event) => {
        if (!carries(event)) return;
        const at = sideAt(event.clientX);
        const side = at !== undefined && split.canDrop(at) ? at : undefined;
        setOver(side);
        if (side === undefined) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(undefined);
      }}
      onDrop={(event) => {
        setOver(undefined);
        const key = event.dataTransfer.getData(ROW_TAB_TYPE);
        const side = sideAt(event.clientX);
        if (key === '' || side === undefined) return;
        event.preventDefault();
        split.drop(side, key);
      }}
    >
      <div {...pane('left')} style={live === undefined ? undefined : { flexBasis: percent(leftWidth) }}>
        {children}
      </div>
      {live !== undefined && right !== undefined && (
        <div {...pane('right')}>
          <SessionBody
            key={right.sessionId}
            content={{ kind: 'session', sessionId: right.sessionId, agent: right }}
            detailsCollapsed
            onDetailsCollapsed={() => {}}
            shelves={false}
            view={view === 'terminal' ? 'terminal' : 'chat'}
            chatControlsSlot={null}
            ownStrip={false}
            viewKey={viewKey}
            autoFocus={false}
          />
        </div>
      )}
      {live !== undefined && <Dividers {...dividers} testId="agent-popup-divider" />}
    </div>
  );
}
