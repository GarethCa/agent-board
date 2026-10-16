import { useState, type FormEvent, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import { keyText } from '../keys/registry';
import { Kbd } from './Label';

/** What a focusable control in a dialog's body is, to focus the first one when the dialog opens. */
const FIELD = 'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), [role="listbox"]';

interface DialogProps {
  /** The heading. It also names the dialog, unless `aria-label` gives a shorter name. */
  title: ReactNode;
  /** The dialog's accessible name, when the title is long or changes: "New agent", not "New Codex agent in web". */
  'aria-label'?: string;
  /** Closing it any way: Esc, the close button or a click on the scrim. */
  onClose(): void;
  /** The actions, right-aligned under the body: Cancel (ghost) before the primary action. */
  footer: ReactNode;
  /** An action set apart at the footer's start, such as Unlink or Remove. */
  footerStart?: ReactNode;
  children?: ReactNode;
  /**
   * `alertdialog` asks before something that can't be undone, or warns: it has no close button, and a click on the
   * scrim doesn't dismiss it, so an answer is a choice of the footer's buttons (or Esc).
   */
  role?: 'dialog' | 'alertdialog';
  /** Makes the dialog a form: Enter in a field submits it, through the footer's submit button. */
  onSubmit?(event: FormEvent<HTMLFormElement>): void;
  /** Drawn open in place, not over the page: for the component gallery. */
  inline?: boolean;
  'data-testid'?: string;
}

/**
 * A modal dialog: a header with the title and a close button, a body, and a footer of actions. Focus is trapped in it
 * while it is open and returns to what opened it after; Esc closes it. It opens on the body's first field (or the one
 * marked autoFocus), else on the footer's last button, the primary action; an alertdialog on its first, the safe answer.
 */
export function Dialog({ title, onClose, footer, footerStart, children, role = 'dialog', onSubmit, inline = false, ...rest }: DialogProps) {
  const alert = role === 'alertdialog';
  // Its parent opens it by mounting it, so Radix has no trigger to give focus back to: this is that trigger.
  const [opener] = useState(() => openerOf(document.activeElement));
  const card = (
    <>
      <div className="ui-dialog-head">
        <RadixDialog.Title className="ui-dialog-title">{title}</RadixDialog.Title>
        {!alert && (
          <RadixDialog.Close asChild>
            <IconButton
              icon={<X />}
              aria-label="Close"
              size="sm"
              tooltip={
                <>
                  Close
                  <Kbd>{keyText('dialog.close')}</Kbd>
                </>
              }
            />
          </RadixDialog.Close>
        )}
      </div>
      {children !== undefined && <div className="ui-dialog-body">{children}</div>}
      <div className="ui-dialog-foot">
        {footerStart ? <span className="ui-dialog-foot-start">{footerStart}</span> : null}
        {footer}
      </div>
    </>
  );
  const props = {
    className: 'ui-card ui-dialog',
    role,
    // A given name replaces the title's: aria-labelledby would win over it.
    ...(rest['aria-label'] !== undefined && { 'aria-label': rest['aria-label'], 'aria-labelledby': undefined }),
    'data-testid': rest['data-testid'],
    'data-inline': inline || undefined,
    // The dialog's text is the title and body; no separate description is wired.
    'aria-describedby': undefined,
  };
  const body = onSubmit === undefined ? <div {...props}>{card}</div> : <form {...props} onSubmit={onSubmit}>{card}</form>;

  if (inline) {
    // Radix's Title needs a Root; a non-modal, always-open one draws the card where it stands, with no portal or trap.
    return (
      <RadixDialog.Root open modal={false}>
        {body}
      </RadixDialog.Root>
    );
  }
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-scrim" />
        <RadixDialog.Content
          asChild
          onOpenAutoFocus={(event) => {
            // Radix fires it on the content: the dialog's card.
            const root = event.target as HTMLElement | null;
            const first =
              root?.querySelector<HTMLElement>(`.ui-dialog-body :is(${FIELD})`) ??
              // A question that can't be undone opens on its safe answer (Cancel, Back); the rest on the primary action.
              [...(root?.querySelectorAll<HTMLElement>('.ui-dialog-foot button:not(:disabled)') ?? [])].at(alert ? 0 : -1);
            if (first === undefined) return;
            event.preventDefault();
            first.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Without scrolling: an opener on the board sits in React Flow's overflow-hidden pane, and scrolling that
            // would slide the board out from under its own view.
            if (opener?.isConnected) opener.focus({ preventScroll: true });
          }}
          // An alertdialog wants an answer; and a click on a toast (a Retry raised meanwhile) never throws the dialog away.
          onPointerDownOutside={(event) => (alert || onToast(event.target)) && event.preventDefault()}
          onInteractOutside={(event) => (alert || onToast(event.target)) && event.preventDefault()}
        >
          {body}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * What a dialog gives focus back to when it closes: what had focus when it opened, or, for a menu's row (gone once the
 * menu closes), the button that opened the menu.
 */
function openerOf(active: Element | null): HTMLElement | null {
  const menu = active?.closest('[role="menu"]');
  const trigger = menu ? document.getElementById(menu.getAttribute('aria-labelledby') ?? '') : active;
  return trigger instanceof HTMLElement ? trigger : null;
}

const onToast = (target: EventTarget | null) => target instanceof Element && target.closest('.ui-toasts') !== null;
