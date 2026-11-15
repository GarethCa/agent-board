import { memo, useContext } from 'react';
import { NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { IconButton, Kbd } from '../../ui';
import { keyText } from '../../keys/registry';
import { itemKindTitle } from './kind-labels';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';

const MIN_SIZE = { width: 120, height: 56 };

/** The placeholder's face: the kind's name, and that this version can't show it. */
export function UnknownItemCard({ kind, zoneId }: { kind: string; zoneId: string | null }) {
  return (
    <div className="link-card unknown-item" data-testid="unknown-item" data-kind={kind} data-zone={zoneId ?? ''}>
      <div className="link-card-site">
        <span className="link-card-domain">This version of the app can&apos;t show it</span>
      </div>
      <div className="link-card-title">{itemKindTitle(kind)}</div>
    </div>
  );
}

/**
 * An item of a kind this app doesn't know, such as a newer app's: a plain card naming the kind. It moves, resizes and
 * deletes like any item (for good: this version can't make one again), but nothing edits it, so its data stays as the
 * newer app left it.
 */
export const UnknownItemNode = memo(function UnknownItemNode({ data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove } = useContext(ItemActionsContext);
  const { item } = data;
  // This version can't make one again, so undo can't bring it back.
  const deleteLabel = `Delete ${itemKindTitle(item.kind).toLowerCase()}: this version can't undo it`;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        color="var(--sticky-resizer)"
        minWidth={MIN_SIZE.width}
        minHeight={MIN_SIZE.height}
        onResizeEnd={(_event, { x, y, width, height }) => update({ id: item.id, x, y, width, height })}
      />
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label={deleteLabel}
          tooltip={
            <>
              {deleteLabel}
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      <UnknownItemCard kind={item.kind} zoneId={item.zoneId} />
    </>
  );
});
