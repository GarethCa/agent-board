import { useState, type ReactNode } from 'react';
import { TEXT_FONT_SIZES, type ColorSlot } from '@agent-board/daemon/protocol';
import { Minus, Plus } from 'lucide-react';
import { stepFontSize } from './text-style';
import { NodeToolbar, Position } from '@xyflow/react';
import { Button, Input, Popover, Swatch } from '../../ui';
import { slotName, slotToken } from '../../board-colors';

/** The bar above a selected text item or shape: floats over it, keeping its size at any zoom. */
export function ItemStyleBar({ label, visible, children }: { label: string; visible: boolean; children: ReactNode }) {
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} className="item-bar">
      <div role="toolbar" aria-label={label} className="item-bar-rows">
        {children}
      </div>
    </NodeToolbar>
  );
}

/** One row of the bar: a bar with a lot to say has more than one. */
export const BarRow = ({ children }: { children: ReactNode }) => <div className="item-bar-row">{children}</div>;

export const BarSeparator = () => <span className="item-bar-sep" aria-hidden="true" />;

export const BarLabel = ({ children }: { children: ReactNode }) => <span className="item-bar-label">{children}</span>;

/**
 * A colour to pick, as the board draws it (`paint`), `null` for none (drawn struck through). A fill's is ringed in
 * `edge`, its outline's colour; a `fixed` one, which no theme changes, is marked so.
 */
export function BarSwatch({
  name,
  paint,
  edge,
  fixed = false,
  title,
  pressed,
  onPick,
}: {
  name: string;
  paint: string | null;
  edge?: string;
  fixed?: boolean;
  title?: string;
  pressed: boolean;
  onPick: () => void;
}) {
  return (
    <Swatch
      className="item-bar-swatch"
      data-none={paint === null || undefined}
      data-fixed={fixed || undefined}
      edge={edge}
      color={paint ?? 'transparent'}
      aria-label={name}
      title={title}
      pressed={pressed}
      onClick={onPick}
    />
  );
}

const HEX = /^#?([0-9a-f]{6})$/i;

/** The `#` at the end of a row of colours: a fixed `#rrggbb` to type, which stays as it is in every theme. */
function FixedColorButton({ name, color, onPick }: { name: string; color: string; onPick(hex: string): void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(color);
  const typed = HEX.exec(draft.trim())?.[1];
  const pick = () => {
    if (typed === undefined) return;
    setOpen(false);
    onPick(`#${typed.toLowerCase()}`);
  };
  return (
    <Popover
      aria-label={name}
      className="item-bar-hex"
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(color);
        setOpen(next);
      }}
      side="bottom"
      content={
        <form
          className="item-bar-hex-form"
          onSubmit={(event) => {
            event.preventDefault();
            pick();
          }}
        >
          <Input
            size="sm"
            aria-label="Hex colour"
            aria-invalid={typed === undefined || undefined}
            value={draft}
            spellCheck={false}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={typed === undefined}>
            Set
          </Button>
          <span className="item-bar-hex-hint">Stays the same in every theme</span>
        </form>
      }
    >
      <Button variant="ghost" size="sm" className="item-bar-button item-bar-hex-button" aria-label={name} tooltip="Fixed colour">
        #
      </Button>
    </Popover>
  );
}

/**
 * A row's theme colours to pick (`slots`), each named `label` and the slot, then the fixed colour the item has, if it
 * has one, and the `#` that sets one.
 */
export function SlotSwatches({
  label,
  slots,
  slot,
  color,
  onPick,
  onFixed,
}: {
  label: string;
  slots: readonly ColorSlot[];
  /** The slot the item's colour is in, or null for a fixed `color`. */
  slot: ColorSlot | null;
  color: string;
  onPick(slot: ColorSlot): void;
  onFixed(hex: string): void;
}) {
  return (
    <>
      {slots.map((each) => (
        <BarSwatch
          key={each}
          name={`${label} ${each}`}
          title={`${slotName(each)} · follows the theme`}
          paint={slotToken(each)}
          pressed={slot === each}
          onPick={() => onPick(each)}
        />
      ))}
      <BarSeparator />
      {slot === null && <BarSwatch name={`${label} ${color}, fixed`} title={`${color} · fixed`} paint={color} fixed pressed onPick={() => onFixed(color)} />}
      <FixedColorButton name={`${label}: fixed colour`} color={color} onPick={onFixed} />
    </>
  );
}

/**
 * A button on the bar: a toggle when `pressed` is given. Its children are a short label or an icon. Only one bar shows
 * at a time, so it has the designed tooltip.
 */
export function BarButton({
  name,
  pressed,
  onClick,
  children,
}: {
  name: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="sm" className="item-bar-button" aria-label={name} aria-pressed={pressed} tooltip={name} onClick={onClick}>
      {children}
    </Button>
  );
}

/**
 * A sample of the item's own style, drawn from SVG path data, such as a stroke's weight or a shape's outline: not an
 * icon (those come from lucide), any more than a swatch is. Its line `weight` (in the sample's 24 units) is given when
 * it matters, a part of it drawn `filled` (such as a filled end), `dashed` for a dashed line's, and `mirrored` end for end
 * (a line's start, drawn as its end is).
 */
export function BarSample({
  path,
  weight,
  filled,
  dashed = false,
  mirrored = false,
}: {
  path: string;
  weight?: number;
  filled?: string;
  dashed?: boolean;
  mirrored?: boolean;
}) {
  return (
    <svg
      className="item-bar-sample"
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-mirrored={mirrored || undefined}
      style={weight === undefined ? undefined : { strokeWidth: weight }}
    >
      <path d={path} strokeDasharray={dashed ? '3 2.5' : undefined} />
      {filled !== undefined && <path d={filled} className="item-bar-sample-fill" />}
    </svg>
  );
}

/** A smaller and a larger button around a list of font sizes, for a text item or a shape: `px` is the size now. */
export function FontSizeControl({ px, onChange }: { px: number; onChange(px: number): void }) {
  return (
    <>
      <BarButton name="Smaller text" onClick={() => onChange(stepFontSize(px, -1))}>
        <Minus />
      </BarButton>
      <select className="item-bar-select" aria-label="Font size" value={px} onChange={(event) => onChange(Number(event.target.value))}>
        {[...new Set([...TEXT_FONT_SIZES, px])]
          .sort((a, b) => a - b)
          .map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
      </select>
      <BarButton name="Larger text" onClick={() => onChange(stepFontSize(px, 1))}>
        <Plus />
      </BarButton>
    </>
  );
}
