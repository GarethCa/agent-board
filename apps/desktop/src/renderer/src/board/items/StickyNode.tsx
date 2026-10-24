import { memo, useContext, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { MAX_STICKY_TEXT, STICKY_COLORS, type StickyData } from '@agent-board/daemon/protocol';
import { Trash2 } from 'lucide-react';
import { stickyPaint } from '../../board-colors';
import { token, tokenNumber } from '../../theme';
import { IconButton, Kbd, Swatch } from '../../ui';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { useDraftText } from './useDraftText';
import { fitFontSize, parseMarkdown, plainText, type FontFit, type Inline, type MeasureText } from './sticky-text';
import { keyText } from '../../keys/registry';

const MIN_STICKY_SIZE = 80;
/** The font sizes a note's text is fitted between, px. */
const FONT_SIZES = { min: 8, max: 28 };

/** What fitting a note's text needs from the theme, read once: the same tokens `.sticky` and `.sticky-text` use. */
let metrics: { padding: number; fit: FontFit; font: (size: number) => string } | undefined;
function stickyMetrics(): NonNullable<typeof metrics> {
  if (metrics === undefined) {
    const [weight, family] = [token('--sticky-weight'), token('--font-hand')];
    metrics = {
      padding: tokenNumber('--sticky-padding'),
      fit: { ...FONT_SIZES, lineHeight: tokenNumber('--sticky-leading') },
      font: (size) => `${weight} ${size}px ${family}`,
    };
  }
  return metrics;
}

/**
 * Counts the font faces that have finished loading. A note's fit is measured on a canvas, which uses a fallback face
 * until the handwriting face has loaded, so notes fit again once it has. Nothing on the page uses that face before the
 * first note does, so the first note asks for it.
 */
let fontsLoaded = 0;
const fontListeners = new Set<() => void>();
const fontLoaded = () => {
  fontsLoaded++;
  for (const listener of fontListeners) listener();
};
function subscribeToFonts(listener: () => void): () => void {
  if (fontListeners.size === 0) {
    document.fonts.addEventListener('loadingdone', fontLoaded);
    void document.fonts.load(stickyMetrics().font(FONT_SIZES.max)).then(fontLoaded, () => {});
  }
  fontListeners.add(listener);
  return () => {
    fontListeners.delete(listener);
    if (fontListeners.size === 0) document.fonts.removeEventListener('loadingdone', fontLoaded);
  };
}

/** A new note's data. */
export const newStickyData = (): StickyData => ({ text: '', color: STICKY_COLORS[0].value });

let canvas: CanvasRenderingContext2D | null | undefined;
const measure: MeasureText = (text, size) => {
  canvas ??= document.createElement('canvas').getContext('2d');
  if (canvas === null) return text.length * size * 0.55;
  canvas.font = stickyMetrics().font(size);
  return canvas.measureText(text).width;
};

/** A note's data, with defaults for anything missing or of the wrong type. */
export function stickyData(data: Record<string, unknown>): StickyData {
  return {
    text: typeof data.text === 'string' ? data.text : '',
    color: typeof data.color === 'string' ? data.color : STICKY_COLORS[0].value,
  };
}

/**
 * A sticky note. Double-click it to type: its text is markdown, wrapped and shrunk to fit the note. What is typed is
 * saved as `useDraftText` says. Once selected, it can be resized from its edges and recoloured or deleted from the bar
 * above it.
 */
export const StickyNode = memo(function StickyNode({ id, data, selected: picked, dragging, width, height }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove, openLink } = useContext(ItemActionsContext);
  const { item } = data;
  const { text, color } = stickyData(item.data);
  const paint = stickyPaint(color);
  const editing = data.editing === true;
  const { shown, draft, startEditing, type, finishEditing } = useDraftText(id, editing, text, (typed) =>
    update({ id: item.id, data: { text: typed } }),
  );
  const { padding, fit } = stickyMetrics();
  const textWidth = (width ?? item.width) - 2 * padding;
  const textHeight = (height ?? item.height) - 2 * padding;
  const fonts = useSyncExternalStore(subscribeToFonts, () => fontsLoaded);
  const fontSize = useMemo(
    () => fitFontSize(plainText(shown), { width: textWidth, height: textHeight }, measure, fit),
    // `fonts`: measured again once the handwriting face has loaded.
    [shown, textWidth, textHeight, fit, fonts],
  );

  return (
    <div
      className="sticky"
      data-testid="sticky"
      data-color={color}
      data-zone={item.zoneId ?? ''}
      style={{ '--sticky-color': paint.color, '--sticky-ink': paint.ink, fontSize } as CSSProperties}
      onDoubleClick={(event) => {
        // Not a new note on the board behind it.
        event.stopPropagation();
        if (!editing) startEditing();
      }}
    >
      <NodeResizer
        isVisible={selected && !editing}
        color="var(--sticky-resizer)"
        minWidth={MIN_STICKY_SIZE}
        minHeight={MIN_STICKY_SIZE}
        onResizeEnd={(_event, { x, y, width, height }) => update({ id: item.id, x, y, width, height })}
      />
      <NodeToolbar isVisible={selected && !dragging && !editing} position={Position.Top} className="sticky-toolbar">
        {STICKY_COLORS.map((preset) => (
          <Swatch
            key={preset.value}
            color={stickyPaint(preset.value).color}
            aria-label={preset.name}
            pressed={preset.value === color}
            onClick={() => update({ id: item.id, data: { color: preset.value } })}
          />
        ))}
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Delete note"
          tooltip={
            <>
              Delete note
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      {editing ? (
        <textarea
          className="sticky-text sticky-editor nodrag nowheel nopan"
          aria-label="Note text"
          value={draft}
          maxLength={MAX_STICKY_TEXT}
          autoFocus
          onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
          onChange={(event) => type(event.target.value)}
          onBlur={finishEditing}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.currentTarget.blur();
          }}
        />
      ) : (
        <div className="sticky-text">{renderMarkdown(text, openLink)}</div>
      )}
    </div>
  );
});

/** A line of a note's markdown as elements, its links opened by `openLink`. */
export function renderInline(inlines: Inline[], openLink: (url: string) => void): ReactNode[] {
  const inline = (parts: Inline[]): ReactNode[] =>
    parts.map((part, index) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'code':
          return <code key={index}>{part.text}</code>;
        case 'bold':
          return <strong key={index}>{inline(part.children)}</strong>;
        case 'italic':
          return <em key={index}>{inline(part.children)}</em>;
        case 'link':
          return (
            // Not an <a href>: there is nothing to navigate to, so a middle- or modifier-click can't open the URL in an
            // app window. It opens in the browser, through the app's https-only path.
            <span
              key={index}
              role="link"
              tabIndex={0}
              className="sticky-link nodrag"
              title={part.href}
              onClick={() => openLink(part.href)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') openLink(part.href);
              }}
            >
              {inline(part.children)}
            </span>
          );
      }
    });
  return inline(inlines);
}

/** A note's markdown (`parseMarkdown`) as elements, its links opened by `openLink`. */
export function renderMarkdown(text: string, openLink: (url: string) => void): ReactNode {
  const inline = (inlines: Inline[]) => renderInline(inlines, openLink);
  return parseMarkdown(text).map((block, index) => {
    if (block.type === 'paragraph') {
      return (
        <p key={index}>
          {block.lines.map((line, n) => (
            <span key={n}>
              {n > 0 && <br />}
              {inline(line)}
            </span>
          ))}
        </p>
      );
    }
    const items = block.items.map((item, n) => <li key={n}>{inline(item)}</li>);
    return block.ordered ? (
      <ol key={index} start={block.start}>
        {items}
      </ol>
    ) : (
      <ul key={index}>{items}</ul>
    );
  });
}
