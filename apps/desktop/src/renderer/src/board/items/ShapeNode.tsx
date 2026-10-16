import { memo, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import {
  MAX_TEXT_LENGTH,
  SHAPE_FILLS,
  SHAPE_STROKES,
  SHAPE_STROKE_WIDTHS,
  type ShapeData,
  type ShapeType,
  type TextSize,
} from '@agent-board/daemon/protocol';
import { Bold, ChevronDown } from 'lucide-react';
import { Button, Popover } from '../../ui';
import { BarButton, BarLabel, BarRow, BarSample, BarSeparator, BarSwatch, ItemStyleBar } from './ItemStyleBar';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { shapeData } from './text-style';
import { DeleteButton } from './TextNode';
import { shapeInk, themedColor } from '../../board-colors';
import { useDraftText } from './useDraftText';
import { DEFAULT_SHAPE_SIZE, SHAPES, type LabelBox } from './shapes/catalogue';
import { ShapeIcon, ShapeParts } from './shapes/ShapeArt';
import { noteShapeUsed } from './shapes/recents';
import { ShapePicker } from './shapes/ShapePicker';

export const SHAPE_SIZE = DEFAULT_SHAPE_SIZE;
export const MIN_SHAPE_SIZE = 40;

const WIDTH_NAMES = ['Thin', 'Medium', 'Thick'] as const;
const TEXT_SIZE_BUTTONS: { size: TextSize; label: string }[] = [
  { size: 'body', label: 'S' },
  { size: 'h2', label: 'M' },
  { size: 'h1', label: 'L' },
];

/** The bar's button that changes the kind of shape, drawn as the shape it is, opening the shape picker (CL1). */
function ChangeShape({ current, onPick }: { current: ShapeType; onPick(shape: ShapeType): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      aria-label="Shapes"
      className="shape-picker-popover"
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      content={
        <ShapePicker
          current={current}
          hint={<span>Changes this shape, keeping its text and colours</span>}
          onEscape={() => setOpen(false)}
          onPick={(shape) => {
            setOpen(false);
            noteShapeUsed(shape);
            onPick(shape);
          }}
        />
      }
    >
      <Button variant="ghost" size="sm" className="item-bar-button item-bar-shape" aria-label={`Change shape: ${SHAPES[current].name}`} tooltip="Change shape">
        <ShapeIcon shape={current} room={{ width: 18, height: 14 }} />
        <ChevronDown aria-hidden />
      </Button>
    </Popover>
  );
}

/** A shape's colours, for its outline and text, in the theme. */
export function shapePaint(style: ShapeData): CSSProperties {
  const onFill = style.fill !== null && SHAPES[style.shape].label.outside !== true;
  return {
    '--shape-fill': style.fill === null ? 'none' : themedColor(style.fill),
    '--shape-stroke': themedColor(style.stroke),
    // On a fill, the text is drawn for paper: a fill is light in every theme, as a note is.
    '--item-color': onFill ? shapeInk(style.textColor) : themedColor(style.textColor),
  } as CSSProperties;
}

/** Where a shape's text sits, in from its box's sides (row CK): inside its outline, or under a figure. */
function labelStyle({ top, right, bottom, left }: LabelBox): CSSProperties {
  return { inset: `${top * 100}% ${right * 100}% ${bottom * 100}% ${left * 100}%` };
}

/** A shape's drawing and its text (`children`) where its kind puts it, inside a `.shape` `width` by `height`. */
export function ShapeBody({ style, width, height, children }: { style: ShapeData; width: number; height: number; children: ReactNode }) {
  const label = SHAPES[style.shape].label;
  return (
    <>
      <svg className="shape-art" width={width} height={height} aria-hidden="true">
        <ShapeParts shape={style.shape} width={width} height={height} strokeWidth={style.strokeWidth} dashed={style.dashed} />
      </svg>
      <div className="shape-label" data-tight={label.tight || undefined} data-at-top={label.atTop || undefined} style={labelStyle(label)}>
        {children}
      </div>
    </>
  );
}

/**
 * One of the diagram shapes, with its text inside it. Double-click it to type. Once selected it can
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
      style={shapePaint(style)}
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
          <ChangeShape current={style.shape} onPick={(shape) => restyle({ shape })} />
          <BarSeparator />
          <DeleteButton onClick={() => remove(item.id)} />
        </BarRow>
      </ItemStyleBar>
      <ShapeBody style={style} width={w} height={h}>
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
      </ShapeBody>
    </div>
  );
});
