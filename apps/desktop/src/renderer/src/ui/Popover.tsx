import type { ReactElement, ReactNode } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { cx } from './cx';

interface PopoverProps {
  /** The button that opens it: one element that takes a ref and DOM props, such as a Button. */
  children: ReactElement;
  /** What it shows: a few controls or a short list. */
  content: ReactNode;
  /** Its accessible name. */
  'aria-label': string;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
  /** Hears a press outside it, which closes it, before it closes. */
  onPointerDownOutside?(event: Event): void;
  /** As it closes and gives focus back to its button: `preventDefault()` keeps focus where it went instead. */
  onCloseAutoFocus?(event: Event): void;
}

/**
 * A card that opens from a button, over the page, for a few controls that don't need a dialog. Esc or a click
 * elsewhere closes it and gives focus back to the button.
 */
export function Popover({
  children,
  content,
  open,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  className,
  onPointerDownOutside,
  onCloseAutoFocus,
  ...rest
}: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{children}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={cx('ui-card ui-popover', className)}
          aria-label={rest['aria-label']}
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={8}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDownOutside={onPointerDownOutside}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {content}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** A popover's card drawn open in place, for the component gallery. */
export function PopoverPreview({ children, className, ...rest }: { children: ReactNode; className?: string; 'aria-label': string }) {
  return (
    <div className={cx('ui-card ui-popover', className)} role="dialog" aria-label={rest['aria-label']}>
      {children}
    </div>
  );
}

interface AnchoredPopoverProps {
  /** What it points at, such as an outline drawn on the board: one element that takes a ref. */
  anchor: ReactElement;
  /** What it shows. */
  children: ReactNode;
  'aria-label': string;
  open: boolean;
  onOpenChange(open: boolean): void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** How far from the anchor, px; negative overlaps it. */
  sideOffset?: number;
  className?: string;
}

/**
 * A popover with no button: it opens beside `anchor` while `open`. Esc or a click elsewhere asks to close it; focus
 * moving away does not, as the menu that opened it hands focus back to its own button as it closes. Keys typed in it
 * stay in it, so the board's shortcuts don't fire.
 */
export function AnchoredPopover({ anchor, children, open, onOpenChange, align = 'start', side = 'right', sideOffset = 10, className, ...rest }: AnchoredPopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Anchor asChild>{anchor}</RadixPopover.Anchor>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={cx('ui-card ui-popover', className)}
          aria-label={rest['aria-label']}
          align={align}
          side={side}
          sideOffset={sideOffset}
          collisionPadding={8}
          onFocusOutside={(event) => event.preventDefault()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
