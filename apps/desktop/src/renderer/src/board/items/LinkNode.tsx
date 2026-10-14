import { memo, useContext, useRef } from 'react';
import { NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { LinkData } from '@agent-board/daemon/protocol';
import { imageUrl } from '../../../../shared/image-url';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { Trash2 } from 'lucide-react';
import { IconButton, Kbd, Tag } from '../../ui';

export const LINK_CARD_SIZE = { width: 280, height: 96 };
const MIN_LINK_SIZE = { width: 160, height: 64 };
/** How far the pointer may move between pressing and releasing on a card for it to count as a click, px. */
const CLICK_SLOP = 4;

/** A link card's data; `url` is empty for data that is not one. */
function linkData(data: Record<string, unknown>): LinkData {
  return { ...(data as Partial<LinkData>), url: typeof data.url === 'string' ? data.url : '' };
}

/**
 * A card for a link: its page's title, domain and icon, and for a tracker issue or pull request its state. Until the
 * daemon has fetched the page, or if it can't, it shows the bare URL. Clicking it opens the URL in the browser.
 */
export const LinkNode = memo(function LinkNode({ data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove, openLink } = useContext(ItemActionsContext);
  const { item } = data;
  const { url, title, domain, favicon, status } = linkData(item.data);
  const pressed = useRef<{ x: number; y: number }>(undefined);
  const open = () => openLink(url);
  return (
    <div
      className="link-card"
      data-testid="link-card"
      data-zone={item.zoneId ?? ''}
      role="link"
      tabIndex={0}
      title={url}
      onPointerDown={(event) => {
        pressed.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={(event) => {
        const from = pressed.current;
        // A drag that ended on the card is not a click.
        if (from !== undefined && Math.hypot(event.clientX - from.x, event.clientY - from.y) > CLICK_SLOP) return;
        open();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') open();
      }}
    >
      <NodeResizer
        isVisible={selected}
        color="var(--sticky-resizer)"
        minWidth={MIN_LINK_SIZE.width}
        minHeight={MIN_LINK_SIZE.height}
        onResizeEnd={(_event, { x, y, width, height }) => update({ id: item.id, x, y, width, height })}
      />
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Delete link card"
          tooltip={
            <>
              Delete link card
              <Kbd>⌫</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      <div className="link-card-site">
        {favicon ? (
          <img className="link-card-icon" src={imageUrl(favicon)} alt="" draggable={false} />
        ) : (
          <span className="link-card-icon link-card-icon-blank" aria-hidden="true" />
        )}
        <span className="link-card-domain">{domain ?? new URL(url, 'https://x.invalid').hostname}</span>
        {status && (
          <Tag tone="accent" className="link-card-status" data-kind={status.kind}>
            {status.id} · {status.state}
          </Tag>
        )}
      </div>
      <div className="link-card-title" data-testid="link-card-title">
        {title ?? url}
      </div>
    </div>
  );
});
