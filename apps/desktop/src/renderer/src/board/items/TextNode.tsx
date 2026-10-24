import { memo, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react';
import {
  COLOR_SLOTS,
  MAX_TEXT_LENGTH,
  TEXT_ALIGNS,
  TEXT_PRESET_FONT_SIZES,
  TEXT_SIZES,
  type TextData,
  type TextSize,
} from '@agent-board/daemon/protocol';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Trash2 } from 'lucide-react';
import { BarButton, BarRow, BarSeparator, FontSizeControl, ItemStyleBar, SlotSwatches } from './ItemStyleBar';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { clampTextHeight, resizedText, textItemSize } from './text-layout';
import { clampFontSize, fixedColor, inSlot, textData, textMetrics } from './text-style';
import { slotPaint } from '../../board-colors';
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

/**
 * The size `data` takes: as wide as its text, or, once `wrap`ped, `width` wide; as tall as the text wraps to, or as the
 * `minHeight` it was dragged to, if more.
 */
function sizeOf(data: TextData, text: string, width: number) {
  const { box, measure } = textMetrics(data);
  const size = textItemSize(text, measure, box, data.wrap ? width : undefined);
  return { ...size, height: clampTextHeight(data.minHeight, size.height) };
}

/**
 * Whether Shift is held, which makes a corner drag scale the font with the box. Tracked from the keys and from each
 * press, so Shift held before the grab counts, and one let go while the window was away doesn't stick. `ref` is the
 * same, for a callback that must see it as it is now.
 */
function useShiftHeld(active: boolean) {
  const [held, setHeld] = useState(false);
  const ref = useRef(false);
  useEffect(() => {
    const set = (value: boolean) => {
      ref.current = value;
      setHeld(value);
    };
    if (!active) return set(false);
    const track = (event: KeyboardEvent | PointerEvent) => set(event.shiftKey);
    const release = () => set(false);
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    window.addEventListener('pointerdown', track, true);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', track);
      window.removeEventListener('keyup', track);
      window.removeEventListener('pointerdown', track, true);
      window.removeEventListener('blur', release);
    };
  }, [active]);
  return { held, ref };
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
  const shift = useShiftHeld(selected === true);
  // The box at the start of a resize, and which handle is dragged: a corner when it moves both ways.
  const drag = useRef({ width: 0, height: 0, corner: false });
  const { shown, draft, startEditing, type, finishEditing } = useDraftText(id, editing, style.text, (typed) =>
    update({
      id: item.id,
      ...sizeOf(style, typed, currentWidth),
      data: { text: typed },
    }),
  );

  // Sized as it is typed in, before the typing is saved.
  // One line of text, the least a drag can reach; a shorter box than its text is lifted to it when the drag ends.
  const { box } = textMetrics(style);
  const oneLine = Math.ceil(box.lineHeight + 2 * box.padding);
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
      data-font-size={style.fontSize}
      data-bold={style.bold}
      data-italic={style.italic}
      data-align={style.align}
      data-wrap={style.wrap}
      data-editing={editing || undefined}
      data-selected={selected || undefined}
      data-zone={item.zoneId ?? ''}
      style={{ '--item-color': slotPaint(style.colorSlot, style.color), '--text-font-size': `${style.fontSize}px` } as CSSProperties}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!editing) startEditing();
      }}
    >
      {alone && !editing && (
        <NodeResizer
          color="var(--item-handle)"
          handleClassName="item-resize-handle nokey"
          lineClassName="item-resize-line"
          minWidth={MIN_WRAPPED_WIDTH}
          minHeight={oneLine}
          keepAspectRatio={shift.held}
          onResizeStart={(_event, start) => {
            drag.current = { width: start.width, height: start.height, corner: false };
          }}
          onResize={(_event, { direction }) => {
            drag.current.corner = direction[0] !== 0 && direction[1] !== 0;
          }}
          onResizeEnd={(_event, { x, y, width: resized, height: dragged }) => {
            const { width: wasWidth, height: wasHeight, corner } = drag.current;
            // Shift on a corner scales the font with the box: by how much the width changed.
            const fontSize = shift.ref.current && corner ? clampFontSize((style.fontSize * resized) / wasWidth) : style.fontSize;
            const scaled = { ...style, fontSize };
            const needs = sizeOf({ ...scaled, minHeight: 0, wrap: true }, style.text, resized).height;
            const { widthChanged, minHeight } = resizedText({
              from: { width: wasWidth, height: wasHeight },
              to: { width: resized, height: dragged },
              minHeight: style.minHeight,
              needs,
            });
            const next = { ...scaled, wrap: style.wrap || widthChanged, minHeight };
            update({
              id: item.id,
              x,
              y,
              width: next.wrap ? resized : sizeOf(next, style.text, resized).width,
              height: sizeOf(next, style.text, resized).height,
              data: { wrap: next.wrap, fontSize, minHeight },
            });
          }}
        />
      )}
      <ItemStyleBar label="Text style" visible={alone && !dragging}>
        <BarRow>
          {TEXT_SIZES.map((option) => (
            <BarButton
              key={option}
              name={SIZE_LABELS[option]}
              pressed={style.fontSize === TEXT_PRESET_FONT_SIZES[option]}
              // A heading comes bold and body text plain, as in a document; bold is then the user's to toggle.
              onClick={() => restyle({ size: option, fontSize: TEXT_PRESET_FONT_SIZES[option], bold: option !== 'body' })}
            >
              {SIZE_SHORT[option]}
            </BarButton>
          ))}
          <BarSeparator />
          <FontSizeControl px={style.fontSize} onChange={(fontSize) => restyle({ fontSize })} />
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
          <DeleteButton onClick={() => remove(item.id)} />
        </BarRow>
        <BarRow>
          <SlotSwatches
            label="Text"
            slots={COLOR_SLOTS}
            slot={style.colorSlot}
            color={style.color}
            onPick={(slot) => restyle(inSlot('color', slot))}
            onFixed={(hex) => restyle(fixedColor('color', hex))}
          />
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
