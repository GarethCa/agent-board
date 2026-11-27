// The frame every full screen over the board shares (memory, queues, to-do lists): a head with a round face, the
// title, a line under it, a count, its own buttons and a close button; a bar for search and filters; a body of two
// panes, a list beside the one picked (or one body of its own); and a line of keys at the foot. Esc, the close button
// or a click on the dimmed board closes it, and the focus goes back to the object.
import { useState, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { IconButton, Kbd } from '../../ui';
import { focusBack } from './full-screen';

/** One key at the foot: what to press, and what it does. */
export interface FullScreenKey {
  keys: string;
  label: string;
}

/** What the frame draws. */
interface FrameProps {
  /** Its own class beside the frame's, for what it draws inside. */
  className: string;
  testId: string;
  title: string;
  /** The icon on its round face. */
  face: ReactNode;
  /** A line under the title. */
  sub?: ReactNode;
  /** How many it holds, after the title. */
  count?: ReactNode;
  /** Beside the title: a scope chip, say. */
  beside?: ReactNode;
  /** The head's own controls, at its end before the close button: tabs, buttons. */
  headEnd?: ReactNode;
  /** The bar under the head: search, filters, add buttons. */
  bar?: ReactNode;
  /** The list pane, on the left. With detail, the body is two panes. */
  side?: ReactNode;
  /** The pane of the one picked, on the right. */
  detail?: ReactNode;
  /** A body of its own, in place of the two panes. */
  children?: ReactNode;
  /** The keys at the foot. */
  keys?: readonly FullScreenKey[];
  onClose(): void;
  /** Drawn open in place, not over the page: for a gallery. */
  inline?: boolean;
  /** Keys on the whole frame. */
  onKeyDown?: HTMLAttributes<HTMLDivElement>['onKeyDown'];
}

export interface FullScreenProps extends FrameProps {
  /** What takes the focus as it opens, inside it (nothing, if it finds none); the dialog itself without. */
  initialFocus?(root: HTMLElement): HTMLElement | null | undefined;
  /** Esc that should stay inside (a search to clear, a draft to cancel), not close it. */
  escapeStays?(focused: Element | null): boolean;
  /** The object it shows, for the focus as it closes when what opened it went. */
  object?(): HTMLElement | null | undefined;
}

/** A full screen over the board, or drawn in place for a gallery. */
export function FullScreen({ initialFocus, escapeStays, object, ...frame }: FullScreenProps) {
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  if (frame.inline === true)
    return (
      <RadixDialog.Root open modal={false}>
        <Frame {...frame} />
      </RadixDialog.Root>
    );
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && frame.onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-scrim" />
        <RadixDialog.Content
          asChild
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            if (initialFocus === undefined) return;
            event.preventDefault();
            const root = event.target as HTMLElement | null;
            if (root !== null) initialFocus(root)?.focus();
          }}
          onEscapeKeyDown={(event) => escapeStays?.(document.activeElement) === true && event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusBack(opener, () => object?.())?.focus({ preventScroll: true });
          }}
          onInteractOutside={(event) => event.target instanceof Element && event.target.closest('.ui-toasts') !== null && event.preventDefault()}
        >
          <Frame {...frame} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** What the dialog's content puts on the card it wraps: its ref, for the focus trap, and its own attributes and keys. */
type Passed = Omit<HTMLAttributes<HTMLDivElement>, keyof FrameProps> & { ref?: Ref<HTMLDivElement> };

function Frame({ className, testId, title, face, sub, count, beside, headEnd, bar, side, detail, children, keys, onClose, inline = false, onKeyDown, ...passed }: FrameProps & Passed) {
  const named = <RadixDialog.Title className="full-screen-title">{title}</RadixDialog.Title>;
  return (
    <div
      {...passed}
      className={`ui-card full-screen ${className}`}
      role="dialog"
      aria-label={`${title}: full screen`}
      data-inline={inline || undefined}
      data-bar={bar !== undefined || undefined}
      data-foot={keys !== undefined || undefined}
      data-testid={testId}
      // Over the board, the dialog's own keys come composed with these.
      onKeyDown={onKeyDown}
    >
      <div className="full-screen-head">
        <span className="full-screen-face" aria-hidden="true">
          {face}
        </span>
        {sub === undefined ? (
          named
        ) : (
          <span className="full-screen-named">
            {named}
            <span className="full-screen-sub">{sub}</span>
          </span>
        )}
        {count !== undefined && <span className="full-screen-count">{count}</span>}
        {beside}
        <span className="full-screen-head-end">
          {headEnd}
          {inline ? (
            <IconButton icon={<X />} size="sm" aria-label="Close" onClick={onClose} />
          ) : (
            <RadixDialog.Close asChild>
              <IconButton icon={<X />} size="sm" aria-label="Close" tooltip="Close · esc" />
            </RadixDialog.Close>
          )}
        </span>
      </div>
      {bar !== undefined && <div className="full-screen-bar">{bar}</div>}
      {detail !== undefined ? (
        <div className="full-screen-body">
          <div className="full-screen-side">{side}</div>
          <div className="full-screen-detail">{detail}</div>
        </div>
      ) : (
        <div className="full-screen-body" data-single>
          {children}
        </div>
      )}
      {keys !== undefined && (
        <div className="full-screen-foot" aria-label="Keys">
          {keys.map((key) => (
            <span key={`${key.keys} ${key.label}`}>
              <Kbd>{key.keys}</Kbd> {key.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
