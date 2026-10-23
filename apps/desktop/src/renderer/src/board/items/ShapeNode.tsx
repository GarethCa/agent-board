import { memo, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react';
import {
  MAX_TEXT_LENGTH,
  SHAPE_FILLS,
  SHAPE_STROKES,
  SHAPE_STROKE_WIDTHS,
  TEXT_ALIGNS,
  SHAPE_SECTIONS,
  type ShapeData,
  type ShapeSection,
  type ShapeType,
  type TextSize,
} from '@agent-board/daemon/protocol';
import { AlignCenter, AlignLeft, AlignRight, Bold, ChevronDown, Code } from 'lucide-react';
import { Button, Popover } from '../../ui';
import { BarButton, BarLabel, BarRow, BarSample, BarSeparator, BarSwatch, FontSizeControl, ItemStyleBar } from './ItemStyleBar';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { shapeData } from './text-style';
import { tokenNumber } from '../../theme';
import { DeleteButton } from './TextNode';
import { shapeInk, themedColor } from '../../board-colors';
import { useDraftText } from './useDraftText';
import { useFitResize, useGrowToFit, useWindowFocused } from './grow-to-fit';
import { DEFAULT_SHAPE_SIZE, SHAPES, type LabelBox } from './shapes/catalogue';
import { grownBox, heightToFit } from './shapes/fit';
import { kindChange, sectionTexts, stereotyped } from './shapes/sections';
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

const ALIGN_ICONS = { left: <AlignLeft />, center: <AlignCenter />, right: <AlignRight /> } as const;

/** The data a restyle changes the text's look with: the shape may need another height after it, which undoes with it. */
const TEXT_LOOK: (keyof ShapeData)[] = ['shape', 'textSize', 'fontSize', 'bold', 'mono', 'align'];

/** The bar's button that changes the kind of shape, drawn as the shape it is, opening the shape picker. */
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
    // A section's rule is drawn as its outline is.
    '--shape-stroke-width': `${style.strokeWidth}px`,
    '--shape-stroke-style': style.dashed ? 'dashed' : 'solid',
    // On a fill, the text is drawn for paper: a fill is light in every theme, as a note is.
    '--item-color': onFill ? shapeInk(style.textColor) : themedColor(style.textColor),
  } as CSSProperties;
}

/** Where a shape's text sits, in from its box's sides (row CK): inside its outline, or under a figure. */
function labelStyle({ top, right, bottom, left }: LabelBox): CSSProperties {
  return { inset: `${top * 100}% ${right * 100}% ${bottom * 100}% ${left * 100}%` };
}

/** A shape's text, as it shows when not being typed in: a class's name under its stereotype, if it has one. */
export function ShapeText({ style }: { style: ShapeData }) {
  const kind = SHAPES[style.shape];
  if (kind.sections === undefined) return <div className="shape-text">{style.text}</div>;
  const { stereotype, name } = stereotyped(style.text, kind.stereotype);
  return (
    <div className="shape-text">
      {stereotype !== null && <span className="shape-stereotype">{stereotype}</span>}
      {name}
    </div>
  );
}

/**
 * A shape's drawing and its text (`children`) where its kind puts it, inside a `.shape` `width` by `height`. A kind with
 * sections stacks them under the text, each divided by a rule and drawn as `section` draws it, or as its text.
 */
export function ShapeBody({
  style,
  width,
  height,
  children,
  section,
}: {
  style: ShapeData;
  width: number;
  height: number;
  children: ReactNode;
  section?: (section: ShapeSection) => ReactNode;
}) {
  const { label, sections } = SHAPES[style.shape];
  return (
    <>
      <svg className="shape-art" width={width} height={height} aria-hidden="true">
        <ShapeParts shape={style.shape} width={width} height={height} strokeWidth={style.strokeWidth} dashed={style.dashed} />
      </svg>
      <div className="shape-label" data-tight={label.tight || undefined} data-at-top={label.atTop || undefined} style={labelStyle(label)}>
        {sections === undefined ? (
          children
        ) : (
          <div className="shape-sections">
            <div className="shape-section" data-section="name">
              {children}
            </div>
            {sectionTexts(style).map(({ section: name, text }) => (
              <div key={name} className="shape-section" data-section={name}>
                {section?.(name) ?? <div className="shape-text">{text}</div>}
              </div>
            ))}
          </div>
        )}
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
  const { updateNode } = useReactFlow<ItemNodeType>();
  const { item } = data;
  const style = shapeData(item.data);
  const editing = data.editing === true;
  // What the text being typed needs, drawn as it is typed and saved with the text; none at the start of each edit.
  const typedFit = useRef<{ x: number; y: number; height: number } | undefined>(undefined);
  // Which text is typed in: the shape's own, or one of its sections. Editing starts in its own text, unless a
  // double-click on a section starts it there.
  const sections = sectionTexts(style);
  const [typingIn, setTypingIn] = useState<'text' | ShapeSection>('text');
  // While the editor moves to another section: the one it leaves blurs, which doesn't end the editing.
  const switching = useRef(false);
  useLayoutEffect(() => {
    typedFit.current = undefined;
    if (!editing) setTypingIn('text');
  }, [editing]);
  const { draft, flush, startEditing, type, finishEditing } = useDraftText(
    id,
    editing,
    style[typingIn],
    (typed) => {
      const fit = typedFit.current;
      typedFit.current = undefined;
      // Only the text typed in, so another window typing in another of them keeps its own. Each undoes on its own: the
      // saves of one typing in a section are one step, as the text's are (the board keys those by the text).
      update(
        { id: item.id, data: { [typingIn]: typed }, ...(fit !== undefined && fit.height > item.height ? fit : {}) },
        typingIn === 'text' ? undefined : `section:${item.id}:${typingIn}`,
      );
    },
    typingIn,
  );
  /** Saves what was typed and moves the editor to `to`. */
  const typeIn = (to: 'text' | ShapeSection) => {
    if (to === typingIn) return;
    switching.current = true;
    flush();
    setTypingIn(to);
  };
  /** The next text along, `step` 1 or -1, from the last back round to the shape's own. */
  const nextText = (step: 1 | -1): 'text' | ShapeSection => {
    const order: ('text' | ShapeSection)[] = ['text', ...sections.map(({ section }) => section)];
    return order[(order.indexOf(typingIn) + step + order.length) % order.length]!;
  };
  // The last restyle of the text's look made here, so the growth it needs undoes with it and with nothing else.
  const lastLook = useRef<{ key: string; at: number } | undefined>(undefined);
  const looks = useRef(0);
  const restyle = (patch: Partial<ShapeData>) => {
    if (!TEXT_LOOK.some((key) => key in patch)) return update({ id: item.id, data: patch });
    const key = `look:${item.id}:${looks.current++}`;
    lastLook.current = { key, at: Date.now() };
    update({ id: item.id, data: patch }, key);
  };
  const w = width ?? item.width;
  const h = height ?? item.height;
  const shownFontSize = style.fontSize ?? tokenNumber(`--shape-text-${style.textSize}-size`);
  const root = useRef<HTMLDivElement>(null);
  const focused = useWindowFocused();
  const resize = useFitResize((at) => heightToFit(root.current, at), item.y, (box) => update({ id: item.id, ...box }));
  useGrowToFit(
    (at) => heightToFit(root.current, at),
    h,
    resize.paused,
    (taller) => {
      // From the saved box, whatever it was drawn at meanwhile: a shape grown twice in one edit is placed as one grow.
      const grown = grownBox({ x: item.x, y: item.y, height: item.height, rotation: item.rotation }, taller);
      if (editing) {
        typedFit.current = grown;
        return updateNode(id, { height: taller, ...(item.rotation === 0 ? {} : { position: { x: grown.x, y: grown.y } }) });
      }
      // Made by this window's own restyle, it is part of that step. Any other (a saved shape drawn for the first time,
      // another window's restyle) is not a step of the user's, and the window in front saves it for all.
      const look = lastLook.current;
      if (look !== undefined && Date.now() - look.at < 1000) update({ id: item.id, ...grown }, look.key);
      else if (focused) update({ id: item.id, ...grown }, undefined, { silent: true });
    },
    [focused, w, editing ? draft : style.text, typingIn, style.attributes, style.methods, style.shape, style.textSize, style.fontSize, style.bold, style.mono, style.align],
  );

  const editor = (
    <textarea
      key={typingIn}
      className="shape-editor nodrag nowheel nopan"
      aria-label={typingIn === 'text' ? 'Shape text' : `${SHAPES[style.shape].name} ${typingIn}`}
      value={draft}
      // The text and its sections share one text's length, as the daemon keeps them.
      maxLength={MAX_TEXT_LENGTH - [style.text, ...sections.map(({ text }) => text)].join('').length + style[typingIn].length}
      autoFocus
      onFocus={(event) => {
        switching.current = false;
        event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length);
      }}
      onChange={(event) => type(event.target.value)}
      onBlur={() => {
        if (!switching.current) finishEditing();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.currentTarget.blur();
        // A shape with sections: ⇥ and ⇧⇥ move between its text and theirs.
        if (event.key === 'Tab' && sections.length > 0) {
          event.preventDefault();
          typeIn(nextText(event.shiftKey ? -1 : 1));
        }
      }}
    />
  );

  return (
    <div
      className="shape"
      data-testid="shape"
      data-shape={style.shape}
      data-fill={style.fill ?? 'none'}
      data-stroke={style.stroke}
      data-text-size={style.textSize}
      data-bold={style.bold}
      data-align={style.align}
      data-mono={style.mono}
      data-zone={item.zoneId ?? ''}
      ref={root}
      style={{ ...shapePaint(style), ...(style.fontSize === null ? {} : { fontSize: style.fontSize }) }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        const under = (event.target as Element).closest<HTMLElement>('.shape-section')?.dataset.section;
        const at = SHAPE_SECTIONS.find((section) => section === under) ?? 'text';
        if (editing) return typeIn(at);
        setTypingIn(at);
        startEditing();
      }}
    >
      <NodeResizer
        isVisible={alone && !editing}
        handleClassName="item-resize-handle"
        lineClassName="item-resize-line"
        minWidth={MIN_SHAPE_SIZE}
        minHeight={MIN_SHAPE_SIZE}
        onResizeStart={resize.onResizeStart}
        onResizeEnd={resize.onResizeEnd}
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
              pressed={style.fontSize === null && style.textSize === size}
              onClick={() => restyle({ textSize: size, fontSize: null })}
            >
              {label}
            </BarButton>
          ))}
          <FontSizeControl px={shownFontSize} onChange={(fontSize) => restyle({ fontSize })} />
          <BarButton name="Bold" pressed={style.bold} onClick={() => restyle({ bold: !style.bold })}>
            <Bold />
          </BarButton>
          <BarButton name="Mono" pressed={style.mono} onClick={() => restyle({ mono: !style.mono })}>
            <Code />
          </BarButton>
          {TEXT_ALIGNS.map((align) => (
            <BarButton key={align} name={`Align ${align}`} pressed={style.align === align} onClick={() => restyle({ align })}>
              {ALIGN_ICONS[align]}
            </BarButton>
          ))}
          <BarSeparator />
          <ChangeShape current={style.shape} onPick={(shape) => restyle(kindChange(style, shape))} />
          <BarSeparator />
          <DeleteButton onClick={() => remove(item.id)} />
        </BarRow>
      </ItemStyleBar>
      <ShapeBody style={style} width={w} height={h} section={(index) => (editing && typingIn === index ? editor : undefined)}>
        {editing && typingIn === 'text' ? editor : <ShapeText style={style} />}
      </ShapeBody>
    </div>
  );
});
