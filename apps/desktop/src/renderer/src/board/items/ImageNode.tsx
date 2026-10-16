import { memo, useContext, useEffect, useState } from 'react';
import { NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { ImageData } from '@agent-board/daemon/protocol';
import { imageUrl } from '../../../../shared/image-url';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { Trash2 } from 'lucide-react';
import { IconButton, Kbd } from '../../ui';
import { keyText } from '../../keys/registry';

const MIN_IMAGE_SIZE = 40;

/** An image item's data, with the defaults of an image that can't be shown. */
export function imageData(data: Record<string, unknown>): ImageData | undefined {
  return typeof data.sha256 === 'string' && typeof data.ext === 'string' ? (data as unknown as ImageData) : undefined;
}

/** Whether Shift is held: it frees a resize from the image's aspect ratio. */
function useShiftHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const track = (event: KeyboardEvent) => setHeld(event.shiftKey);
    const release = () => setHeld(false);
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', track);
      window.removeEventListener('keyup', track);
      window.removeEventListener('blur', release);
    };
  }, []);
  return held;
}

/**
 * An image on the board. Resizing it keeps its aspect ratio unless Shift is held; once selected, the bar above it
 * deletes it.
 */
export const ImageNode = memo(function ImageNode({ data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove } = useContext(ItemActionsContext);
  const { item } = data;
  const image = imageData(item.data);
  const free = useShiftHeld();
  return (
    <div className="board-image" data-testid="board-image" data-sha={image?.sha256 ?? ''} data-zone={item.zoneId ?? ''}>
      <NodeResizer
        isVisible={selected}
        keepAspectRatio={!free}
        color="var(--sticky-resizer)"
        minWidth={MIN_IMAGE_SIZE}
        minHeight={MIN_IMAGE_SIZE}
        onResizeEnd={(_event, { x, y, width, height }) => update({ id: item.id, x, y, width, height })}
      />
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Delete image"
          tooltip={
            <>
              Delete image
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      {image && <img className="board-image-pixels" src={imageUrl(image)} alt="" draggable={false} />}
    </div>
  );
});
