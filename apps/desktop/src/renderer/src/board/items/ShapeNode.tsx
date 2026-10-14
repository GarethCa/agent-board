import { memo, useContext, type CSSProperties } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import {
  MAX_TEXT_LENGTH,
  SHAPE_FILLS,
  SHAPE_STROKES,
  SHAPE_STROKE_WIDTHS,
  SHAPE_TYPES,
  type ShapeData,
  type ShapeType,
  type TextSize,
} from '@agent-board/daemon/protocol';
import { Bold } from 'lucide-react';
import { BarButton, BarLabel, BarRow, BarSample, BarSeparator, BarSwatch, ItemStyleBar } from './ItemStyleBar';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { shapeData } from './text-style';
import { DeleteButton } from './TextNode';
import { shapeInk, themedColor } from '../../board-colors';
import { useDraftText } from './useDraftText';

export const SHAPE_SIZE = { width: 240, height: 140 };
export const MIN_SHAPE_SIZE = 40;

/** Each shape's outline, drawn on its button. */
const SHAPE_SAMPLES: Record<ShapeType, string> = {
  rectangle: 'M4 5h16v14H4z',
  rounded: 'M7 5h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z',
  ellipse: 'M12 5c4.4 0 8 3 8 7s-3.6 7-8 7-8-3-8-7 3.6-7 8-7z',
  diamond: 'M12 2 22 12 12 22 2 12z',
};
const SHAPE_NAMES: Record<ShapeType, string> = {
  rectangle: 'Rectangle',
  rounded: 'Rounded rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
};
const WIDTH_NAMES = ['Thin', 'Medium', 'Thick'] as const;
const TEXT_SIZE_BUTTONS: { size: TextSize; label: string }[] = [
  { size: 'body', label: 'S' },
  { size: 'h2', label: 'M' },
  { size: 'h1', label: 'L' },
];

/** The outline of `shape` in a box `width` by `height`, drawn inside a line `stroke` px wide. */
function Outline({
  shape,
  width,
  height,
  stroke,
}: {
  shape: ShapeType;
  width: number;
  height: number;
  stroke: number;
}) {
  const inset = stroke / 2;
  switch (shape) {
    case 'ellipse':
      return (
        <ellipse
          cx={width / 2}
          cy={height / 2}
          rx={Math.max(0, width / 2 - inset)}
          ry={Math.max(0, height / 2 - inset)}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={`${width / 2},${inset} ${width - inset},${height / 2} ${width / 2},${height - inset} ${inset},${height / 2}`}
        />
      );
    default:
      return (
        <rect
          className={shape === 'rounded' ? 'shape-rounded' : undefined}
          x={inset}
          y={inset}
          width={Math.max(0, width - stroke)}
          height={Math.max(0, height - stroke)}
        />
      );
  }
}

/**
 * A rectangle, rounded rectangle, ellipse or diamond, with centred text. Double-click it to type. Once selected it can
 * be resized from its edges, and its fill, stroke, text and kind of shape set from the bar above it. It draws below
 * tiles, so one can frame a group of agents.
 */
export const ShapeNode = memo(function ShapeNode({
  id,
  data,
  selected,
  dragging,
  width,
  height,
}: NodeProps<ItemNodeType>) {
  const alone = useOnlySelected(selected);
  const { update, remove } = useContext(ItemActionsContext);
  const { item } = data;
  const style = shapeData(item.data);
  const editing = data.editing === true;
  const { draft, startEditing, type, finishEditing } = useDraftText(id, editing, style.text, (typed) =>
    update({ id: item.id, data: { text: typed } }),
  );
  const restyle = (patch: Partial<ShapeData>) => update({ id: item.id, data: patch });
  const w = width ?? item.width;
  const h = height ?? item.height;

  return (
    <div
      className="shape"
      data-testid="shape"
      data-shape={style.shape}
      data-fill={style.fill ?? 'none'}
      data-stroke={style.stroke}
      data-text-size={style.textSize}
      data-bold={style.bold}
      data-zone={item.zoneId ?? ''}
      style={
        {
          '--shape-fill': style.fill === null ? 'none' : themedColor(style.fill),
          '--shape-stroke': themedColor(style.stroke),
          // On a fill, the text is drawn for paper: a fill is light in every theme, as a note is.
          '--item-color': style.fill === null ? themedColor(style.textColor) : shapeInk(style.textColor),
        } as CSSProperties
      }
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!editing) startEditing();
      }}
    >
      <NodeResizer
        isVisible={alone && !editing}
        handleClassName="item-resize-handle"
        lineClassName="item-resize-line"
        minWidth={MIN_SHAPE_SIZE}
        minHeight={MIN_SHAPE_SIZE}
        onResizeEnd={(_event, { x, y, width: resizedWidth, height: resizedHeight }) =>
          update({
            id: item.id,
            x,
            y,
            width: resizedWidth,
            height: resizedHeight,
          })
        }
      />
      <ItemStyleBar label="Shape style" visible={alone && !dragging}>
        <BarRow>
          <BarLabel>Fill</BarLabel>
          {SHAPE_FILLS.map((preset) => (
            <BarSwatch
              key={preset.value}
              name={`Fill ${preset.name.toLowerCase()}`}
              value={preset.value}
              pressed={style.fill === preset.value}
              onPick={() => restyle({ fill: preset.value })}
            />
          ))}
          <BarSwatch name="No fill" value={null} pressed={style.fill === null} onPick={() => restyle({ fill: null })} />
          <BarSeparator />
          <BarLabel>Stroke</BarLabel>
          {SHAPE_STROKES.map((preset) => (
            <BarSwatch
              key={preset.value}
              name={`Stroke ${preset.name.toLowerCase()}`}
              value={preset.value}
              pressed={style.stroke === preset.value}
              onPick={() => restyle({ stroke: preset.value })}
            />
          ))}
        </BarRow>
        <BarRow>
          {SHAPE_STROKE_WIDTHS.map((strokeWidth, index) => (
            <BarButton
              key={strokeWidth}
              name={`${WIDTH_NAMES[index]} stroke`}
              pressed={style.strokeWidth === strokeWidth}
              onClick={() => restyle({ strokeWidth })}
            >
              <BarSample path="M3 12h18" weight={strokeWidth} />
            </BarButton>
          ))}
          <BarButton name="Dashed stroke" pressed={style.dashed} onClick={() => restyle({ dashed: !style.dashed })}>
            <BarSample path="M3 12h4M10 12h4M17 12h4" />
          </BarButton>
          <BarSeparator />
          <BarLabel>Text</BarLabel>
          {TEXT_SIZE_BUTTONS.map(({ size, label }) => (
            <BarButton
              key={size}
              name={`Text size ${label}`}
              pressed={style.textSize === size}
              onClick={() => restyle({ textSize: size })}
            >
              {label}
            </BarButton>
          ))}
          <BarButton name="Bold" pressed={style.bold} onClick={() => restyle({ bold: !style.bold })}>
            <Bold />
          </BarButton>
          <BarSeparator />
          {SHAPE_TYPES.map((shape) => (
            <BarButton
              key={shape}
              name={SHAPE_NAMES[shape]}
              pressed={style.shape === shape}
              onClick={() => restyle({ shape })}
            >
              <BarSample path={SHAPE_SAMPLES[shape]} />
            </BarButton>
          ))}
          <BarSeparator />
          <DeleteButton onClick={() => remove(item.id)} />
        </BarRow>
      </ItemStyleBar>
      <svg className="shape-art" width={w} height={h} aria-hidden="true">
        <g
          fill="var(--shape-fill)"
          stroke="var(--shape-stroke)"
          strokeWidth={style.strokeWidth}
          strokeDasharray={style.dashed ? `${style.strokeWidth * 3} ${style.strokeWidth * 2}` : undefined}
          strokeLinejoin="round"
        >
          <Outline shape={style.shape} width={w} height={h} stroke={style.strokeWidth} />
        </g>
      </svg>
      <div className="shape-label">
        {editing ? (
          <textarea
            className="shape-editor nodrag nowheel nopan"
            aria-label="Shape text"
            value={draft}
            maxLength={MAX_TEXT_LENGTH}
            autoFocus
            onFocus={(event) => event.currentTarget.setSelectionRange(draft.length, draft.length)}
            onChange={(event) => type(event.target.value)}
            onBlur={finishEditing}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.blur();
            }}
          />
        ) : (
          <div className="shape-text">{style.text}</div>
        )}
      </div>
    </div>
  );
});
