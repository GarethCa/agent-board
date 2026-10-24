import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { ChevronRight, Circle, CircleDot } from 'lucide-react';
import { Swatch } from './Field';
import { Kbd } from './Label';

/** A row that does something. */
export interface MenuAction {
  label: string;
  onSelect(): void;
  /** An icon before the label, from lucide-react. */
  icon?: ReactNode;
  /** The key that does the same from the board, shown at the row's end. */
  shortcut?: string;
  /** Destroys or stops something: drawn in the danger colour. */
  danger?: boolean;
  disabled?: boolean;
  /** A line under the row saying what it leaves alone, such as "Agents stay running". */
  hint?: string;
  /** One choice of the rows beside it: drawn as a radio button, picked when true, in place of an icon. */
  checked?: boolean;
  /** A few muted words at the row's end, such as the gaps a spacing keeps. */
  detail?: string;
}

/** A choice's radio button, picked or not; nothing for a row that is no choice. */
const radioOf = (checked: boolean | undefined) => (checked === undefined ? undefined : checked ? <CircleDot aria-hidden="true" /> : <Circle aria-hidden="true" />);

/** A row that opens a menu of its own beside it. */
export interface Submenu {
  label: string;
  icon?: ReactNode;
  entries: MenuEntry[];
  disabled?: boolean;
}

/** A labelled row of colours to pick from. */
export interface SwatchRow {
  label: string;
  /** Each colour to pick: its stored `value`, and the `color` it is drawn in (the value, unless the theme redraws it). */
  swatches: readonly { name: string; value: string; color?: string; pressed: boolean }[];
  onPick(value: string): void;
}

/**
 * A labelled slider of whole steps. `onChange` is called on every tick of a drag, for a preview; `onCommit` once the
 * drag (or a key press) is done and the value differs from the last committed, so a drag is one change to save;
 * `onCancel` instead if nothing is to be saved after a preview.
 */
export interface SliderRow {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The value as shown beside the slider, such as `8%`. */
  format(value: number): string;
  onChange(value: number): void;
  onCommit(value: number): void;
  /** Called when what `onChange` previewed is not to be saved: the drag ended where it began, or the menu closed mid-drag. */
  onCancel(): void;
}

/** A label over the rows after it, naming them as a group, such as "Run a script". */
export interface MenuHeading {
  heading: string;
}

export type MenuEntry = MenuAction | Submenu | SwatchRow | SliderRow | MenuHeading | 'separator';

const isSubmenu = (entry: MenuEntry): entry is Submenu => typeof entry === 'object' && 'entries' in entry;
const isSwatchRow = (entry: MenuEntry): entry is SwatchRow => typeof entry === 'object' && 'swatches' in entry;
const isSliderRow = (entry: MenuEntry): entry is SliderRow => typeof entry === 'object' && 'onCommit' in entry;
const isHeading = (entry: MenuEntry): entry is MenuHeading => typeof entry === 'object' && 'heading' in entry;

/**
 * A slider in a menu, as a row the menu's own arrow keys reach (Up and Down move on, as for any row). Left and Right
 * step it, Home and End go to its ends, and each key press is saved as it is let go. Its range input is for the
 * pointer only: dragging it previews every tick and saves once, on release.
 */
function MenuSlider({ entry }: { entry: SliderRow }) {
  const [value, setValue] = useState(entry.value);
  const shown = useRef(entry.value);
  const committed = useRef(entry.value);
  // Whether the entry has been told of a preview that is neither saved nor taken back yet.
  const previewing = useRef(false);
  const item = useRef<HTMLDivElement>(null);
  const latest = useRef(entry);
  latest.current = entry;
  const show = (next: number) => {
    shown.current = next;
    previewing.current = true;
    setValue(next);
    entry.onChange(next);
  };
  const commit = () => {
    const next = shown.current;
    if (next !== committed.current) {
      committed.current = next;
      previewing.current = false;
      entry.onCommit(next);
    } else if (previewing.current) {
      // Dragged and put back where it began: nothing to save, and the preview goes.
      previewing.current = false;
      entry.onCancel();
    }
  };
  // The menu closed mid-drag (Escape): what was previewed is not saved, so it is taken back.
  useEffect(
    () => () => {
      if (previewing.current) latest.current.onCancel();
    },
    [],
  );
  const step = (event: KeyboardEvent) => {
    const { min, max, step: by } = entry;
    const next =
      event.key === 'ArrowRight' ? shown.current + by : event.key === 'ArrowLeft' ? shown.current - by : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (next === undefined) return;
    // Handled here: the menu must not take Left and Right for its submenus, nor the board the key as its own.
    event.preventDefault();
    event.stopPropagation();
    show(Math.min(max, Math.max(min, next)));
  };
  return (
    <RadixMenu.Item
      ref={item}
      className="ui-menu-slider"
      role="slider"
      aria-label={entry.label}
      aria-valuemin={entry.min}
      aria-valuemax={entry.max}
      aria-valuenow={value}
      aria-valuetext={entry.format(value)}
      aria-orientation="horizontal"
      // Not a choice: a click on the row, or Enter on it, keeps the menu open.
      onSelect={(event) => event.preventDefault()}
      onKeyDown={step}
      onKeyUp={commit}
    >
      <span className="ui-menu-label" aria-hidden="true">
        {entry.label}
      </span>
      <div className="ui-menu-slider-row">
        <input
          type="range"
          tabIndex={-1}
          aria-hidden="true"
          min={entry.min}
          max={entry.max}
          step={entry.step}
          value={value}
          onChange={(event) => show(event.target.valueAsNumber)}
          onPointerUp={commit}
          // A click may focus it; the row is what the keys belong to.
          onFocus={() => item.current?.focus()}
          onKeyDown={(event) => event.preventDefault()}
        />
        <output aria-hidden="true">{entry.format(value)}</output>
      </div>
    </RadixMenu.Item>
  );
}

interface MenuProps {
  /** The button that opens it: one element that takes a ref and DOM props, such as a Button. */
  children: ReactElement;
  entries: MenuEntry[];
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Whether it is open, for a menu opened from elsewhere too; it opens and closes itself without. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

/** The rows of a menu, its submenus' too. */
function Entries({ entries }: { entries: MenuEntry[] }) {
  return entries.map((entry, index) => {
    if (entry === 'separator') return <RadixMenu.Separator key={`separator-${index}`} className="ui-menu-separator" />;
    if (isHeading(entry)) {
      return (
        <RadixMenu.Label key={`heading-${entry.heading}`} className="ui-section-label ui-menu-heading">
          {entry.heading}
        </RadixMenu.Label>
      );
    }
    if (isSwatchRow(entry)) {
      return (
        <RadixMenu.Group key={entry.label} className="ui-menu-swatches" aria-label={entry.label}>
          <RadixMenu.Label className="ui-menu-label">{entry.label}</RadixMenu.Label>
          <div className="ui-menu-swatch-row">
            {entry.swatches.map((swatch) => (
              <RadixMenu.Item key={swatch.value} asChild onSelect={() => entry.onPick(swatch.value)}>
                <Swatch color={swatch.color ?? swatch.value} pressed={swatch.pressed} aria-label={swatch.name} onClick={() => {}} />
              </RadixMenu.Item>
            ))}
          </div>
        </RadixMenu.Group>
      );
    }
    if (isSliderRow(entry)) return <MenuSlider key={entry.label} entry={entry} />;
    if (isSubmenu(entry)) {
      return (
        <RadixMenu.Sub key={entry.label}>
          <RadixMenu.SubTrigger className="ui-menu-item" disabled={entry.disabled}>
            {entry.icon}
            {entry.label}
            <ChevronRight className="ui-menu-chevron" />
          </RadixMenu.SubTrigger>
          <RadixMenu.Portal>
            <RadixMenu.SubContent className="ui-card ui-menu" sideOffset={6} collisionPadding={8} loop onKeyDown={(event) => event.stopPropagation()}>
              <Entries entries={entry.entries} />
            </RadixMenu.SubContent>
          </RadixMenu.Portal>
        </RadixMenu.Sub>
      );
    }
    return (
      <RadixMenu.Item
        key={entry.label}
        className="ui-menu-item"
        data-danger={entry.danger || undefined}
        data-hinted={entry.hint === undefined ? undefined : true}
        disabled={entry.disabled}
        onSelect={entry.onSelect}
        {...(entry.checked === undefined ? {} : { role: 'menuitemradio', 'aria-checked': entry.checked })}
      >
        {entry.icon ?? radioOf(entry.checked)}
        {entry.label}
        {entry.detail !== undefined && <span className="ui-menu-detail">{entry.detail}</span>}
        {entry.shortcut !== undefined && <Kbd>{entry.shortcut}</Kbd>}
        {entry.hint !== undefined && <span className="ui-menu-hint">{entry.hint}</span>}
      </RadixMenu.Item>
    );
  });
}

const contentProps = {
  className: 'ui-card ui-menu',
  sideOffset: 6,
  collisionPadding: 8,
  // The arrow keys wrap round from the last row to the first.
  loop: true,
  // The board must not see the menu's keys as its own.
  onKeyDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
};

/**
 * A button that drops down a menu of actions, as the WAI-ARIA menu button pattern has it: the arrow keys, Home, End
 * and typing a label's first letters move between rows, wrapping round; Enter or a click picks one; Esc or a click elsewhere closes it
 * and gives focus back to the button.
 */
export function Menu({ children, entries, align = 'start', side = 'bottom', open, onOpenChange }: MenuProps) {
  return (
    <RadixMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <RadixMenu.Trigger asChild>{children}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content {...contentProps} align={align} side={side}>
          <Entries entries={entries} />
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

/**
 * A menu opened at a point on the screen, as a right-click opens one, with the keys of `Menu`. It closes on Esc, a
 * click elsewhere or a pick, calling `onClose`.
 */
export function ContextMenu({ at, entries, label, onClose }: { at: { x: number; y: number }; entries: MenuEntry[]; label: string; onClose(): void }) {
  return (
    <RadixMenu.Root modal={false} open onOpenChange={(open) => !open && onClose()}>
      <RadixMenu.Trigger asChild>
        <span className="ui-context-anchor" aria-hidden="true" style={{ '--anchor-x': `${at.x}px`, '--anchor-y': `${at.y}px` } as CSSProperties} />
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content {...contentProps} sideOffset={0} align="start" side="bottom" aria-label={label}>
          <Entries entries={entries} />
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

/** A menu's rows drawn open in place, for the component gallery; `active` marks the row under the pointer. */
export function MenuPreview({ entries, active }: { entries: MenuEntry[]; active?: string }) {
  return (
    <div className="ui-card ui-menu" role="menu" aria-label="Menu preview">
      {entries.map((entry, index) => {
        if (entry === 'separator') return <div key={`separator-${index}`} role="separator" className="ui-menu-separator" />;
        if (isHeading(entry)) {
          return (
            <div key={`heading-${entry.heading}`} className="ui-section-label ui-menu-heading">
              {entry.heading}
            </div>
          );
        }
        if (isSwatchRow(entry)) {
          return (
            <div key={entry.label} role="group" className="ui-menu-swatches" aria-label={entry.label}>
              <div className="ui-menu-label">{entry.label}</div>
              <div className="ui-menu-swatch-row">
                {entry.swatches.map((swatch) => (
                  <Swatch key={swatch.value} color={swatch.color ?? swatch.value} pressed={swatch.pressed} aria-label={swatch.name} onClick={() => {}} />
                ))}
              </div>
            </div>
          );
        }
        if (isSliderRow(entry)) {
          return (
            <div key={entry.label} role="group" className="ui-menu-slider" aria-label={entry.label}>
              <div className="ui-menu-label">{entry.label}</div>
              <div className="ui-menu-slider-row">
                <input type="range" aria-label={entry.label} min={entry.min} max={entry.max} step={entry.step} value={entry.value} readOnly />
                <output>{entry.format(entry.value)}</output>
              </div>
            </div>
          );
        }
        const submenu = isSubmenu(entry);
        return (
          <div
            key={entry.label}
            role={!submenu && entry.checked !== undefined ? 'menuitemradio' : 'menuitem'}
            aria-checked={submenu ? undefined : entry.checked}
            className="ui-menu-item"
            aria-haspopup={submenu ? 'menu' : undefined}
            data-danger={(!submenu && entry.danger) || undefined}
            data-hinted={!submenu && entry.hint !== undefined ? true : undefined}
            data-active={entry.label === active || undefined}
            data-disabled={entry.disabled ? '' : undefined}
            aria-disabled={entry.disabled || undefined}
          >
            {entry.icon ?? (submenu ? undefined : radioOf(entry.checked))}
            {entry.label}
            {!submenu && entry.detail !== undefined && <span className="ui-menu-detail">{entry.detail}</span>}
            {submenu && <ChevronRight className="ui-menu-chevron" />}
            {!submenu && entry.shortcut !== undefined && <Kbd>{entry.shortcut}</Kbd>}
            {!submenu && entry.hint !== undefined && <span className="ui-menu-hint">{entry.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}
