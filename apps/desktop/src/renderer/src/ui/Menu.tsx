import type { CSSProperties, ReactElement, ReactNode } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { ChevronRight } from 'lucide-react';
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
}

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

export type MenuEntry = MenuAction | Submenu | SwatchRow | 'separator';

const isSubmenu = (entry: MenuEntry): entry is Submenu => typeof entry === 'object' && 'entries' in entry;
const isSwatchRow = (entry: MenuEntry): entry is SwatchRow => typeof entry === 'object' && 'swatches' in entry;

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
      >
        {entry.icon}
        {entry.label}
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
        const submenu = isSubmenu(entry);
        return (
          <div
            key={entry.label}
            role="menuitem"
            className="ui-menu-item"
            aria-haspopup={submenu ? 'menu' : undefined}
            data-danger={(!submenu && entry.danger) || undefined}
            data-hinted={!submenu && entry.hint !== undefined ? true : undefined}
            data-active={entry.label === active || undefined}
            data-disabled={entry.disabled ? '' : undefined}
            aria-disabled={entry.disabled || undefined}
          >
            {entry.icon}
            {entry.label}
            {submenu && <ChevronRight className="ui-menu-chevron" />}
            {!submenu && entry.shortcut !== undefined && <Kbd>{entry.shortcut}</Kbd>}
            {!submenu && entry.hint !== undefined && <span className="ui-menu-hint">{entry.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}
