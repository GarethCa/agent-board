import { memo, useContext, useEffect, type CSSProperties } from 'react';
import { NodeResizeControl, useReactFlow, type NodeProps } from '@xyflow/react';
import {
  MAX_TEXT_LENGTH,
  TEXT_ALIGNS,
  TEXT_COLORS,
  TEXT_SIZES,
  type TextData,
  type TextSize,
} from '@agent-board/daemon/protocol';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Trash2 } from 'lucide-react';
import { BarButton, BarRow, BarSeparator, BarSwatch, ItemStyleBar } from './ItemStyleBar';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { textItemSize } from './text-layout';
import { textData, textMetrics } from './text-style';
import { themedColor } from '../../board-colors';
import { useDraftText } from './useDraftText';

const SIZE_LABELS: Record<TextSize, string> = {
  h1: 'Heading 1',
  h2: 'Heading 2',
  body: 'Body',
};
const SIZE_SHORT: Record<TextSize, string> = {
  h1: 'H1',
  h2: 'H2',
  body: 'Body',
};
const ALIGN_ICONS = { left: <AlignLeft />, center: <AlignCenter />, right: <AlignRight /> } as const;

/** The least width a text item can be resized to, px. */
const MIN_WRAPPED_WIDTH = 40;

/** The size `data` takes: as wide as its text, or, once `wrap`ped, `width` wide and as tall as the text wraps to. */
function sizeOf(data: TextData, text: string, width: number) {
  const { box, measure } = textMetrics(data);
  return textItemSize(text, measure, box, data.wrap ? width : undefined);
}

/** The delete button every item's bar ends with. */
export function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <BarButton name="Delete" onClick={onClick}>
      <Trash2 />
    </BarButton>
  );
}

/**
 * Free text with no background. Double-click it to type: it is as wide as its longest line while typed, until it is
 * resized from a side, when it keeps that width and wraps. Heading 1, heading 2 and body, bold, italics, alignment and
 * colour are set from the bar above it once selected. Left empty, it is removed.
 */
export const TextNode = memo(function TextNode({ id, data, selected, dragging, width }: NodeProps<ItemNodeType>) {
  const alone = useOnlySelected(selected);
  const { update, remove } = useContext(ItemActionsContext);
  const { updateNode } = useReactFlow<ItemNodeType>();
  const { item } = data;
  const style = textData(item.data);
  const editing = data.editing === true;
  const currentWidth = width ?? item.width;
  const { shown, draft, startEditing, type, finishEditing } = useDraftText(id, editing, style.text, (typed) =>
    update({
      id: item.id,
      ...sizeOf(style, typed, currentWidth),
      data: { text: typed },
    }),
  );

  // Sized as it is typed in, before the typing is saved.
  const size = sizeOf(style, shown, currentWidth);
  useEffect(() => {
    if (editing) updateNode(id, size);
  }, [editing, updateNode, id, size.width, size.height]);

  /** Changes the style, and the size that goes with it. */
  const restyle = (patch: Partial<TextData>) =>
    update({
      id: item.id,
      ...sizeOf({ ...style, ...patch }, shown, currentWidth),
      data: patch,
    });

  const finish = () => (draft.trim() === '' ? remove(item.id, { abandoned: true }) : finishEditing());

  return (
    <div
      className="text-item"
      data-testid="text-item"
      data-size={style.size}
      data-bold={style.bold}
      data-italic={style.italic}
      data-align={style.align}
      data-wrap={style.wrap}
      data-editing={editing || undefined}
      data-selected={selected || undefined}
      data-zone={item.zoneId ?? ''}
      style={{ '--item-color': themedColor(style.color) } as CSSProperties}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!editing) startEditing();
      }}
    >
      {alone &&
        !editing &&
        (['left', 'right'] as const).map((position) => (
          <NodeResizeControl
            key={position}
            position={position}
            resizeDirection="horizontal"
            minWidth={MIN_WRAPPED_WIDTH}
            className="item-resize-handle"
            onResizeEnd={(_event, { x, y, width: resized }) =>
              update({
                id: item.id,
                x,
                y,
                width: resized,
                height: sizeOf({ ...style, wrap: true }, style.text, resized).height,
                data: { wrap: true },
              })
            }
          />
        ))}
      <ItemStyleBar label="Text style" visible={alone && !dragging}>
        <BarRow>
          {TEXT_SIZES.map((option) => (
            <BarButton
              key={option}
              name={SIZE_LABELS[option]}
              pressed={style.size === option}
              // A heading comes bold and body text plain, as in a document; bold is then the user's to toggle.
              onClick={() => restyle({ size: option, bold: option !== 'body' })}
            >
              {SIZE_SHORT[option]}
            </BarButton>
          ))}
          <BarSeparator />
          <BarButton name="Bold" pressed={style.bold} onClick={() => restyle({ bold: !style.bold })}>
            <Bold />
          </BarButton>
          <BarButton name="Italic" pressed={style.italic} onClick={() => restyle({ italic: !style.italic })}>
            <Italic />
          </BarButton>
          <BarSeparator />
          {TEXT_ALIGNS.map((align) => (
            <BarButton
              key={align}
              name={`Align ${align}`}
              pressed={style.align === align}
              onClick={() => restyle({ align })}
            >
              {ALIGN_ICONS[align]}
            </BarButton>
          ))}
          <BarSeparator />
          {TEXT_COLORS.map((preset) => (
            <BarSwatch
              key={preset.value}
              name={`Text ${preset.name.toLowerCase()}`}
              value={preset.value}
              pressed={style.color === preset.value}
              onPick={() => restyle({ color: preset.value })}
            />
          ))}
          <BarSeparator />
          <DeleteButton onClick={() => remove(item.id)} />
        </BarRow>
      </ItemStyleBar>
      {editing ? (
        <textarea
          className="text-item-editor nodrag nowheel nopan"
          aria-label="Text"
          value={draft}
          maxLength={MAX_TEXT_LENGTH}
          wrap={style.wrap ? 'soft' : 'off'}
          autoFocus
          onFocus={(event) => event.currentTarget.setSelectionRange(draft.length, draft.length)}
          onChange={(event) => type(event.target.value)}
          onBlur={finish}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.currentTarget.blur();
          }}
        />
      ) : (
        <div className="text-item-text">{style.text}</div>
      )}
    </div>
  );
});
