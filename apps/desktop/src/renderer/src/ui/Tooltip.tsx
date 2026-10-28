import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

/** How long the pointer rests on a control before its tooltip shows, and the grace to move to the next one. */
const DELAY_MS = 500;
const SKIP_DELAY_MS = 300;

/** Shares one tooltip delay across the app: once one tooltip shows, the next shows at once. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={DELAY_MS} skipDelayDuration={SKIP_DELAY_MS}>
      {children}
    </RadixTooltip.Provider>
  );
}

interface TooltipProps {
  /** The hint: a few words, maybe with a Kbd. */
  content: ReactNode;
  /** The control it describes: one element that takes a ref and DOM props. */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/** Whether `control` opens a menu or popover (as a Radix trigger says it does) that is open now. */
const opensPopup = (control: HTMLElement | null) => control?.hasAttribute('aria-haspopup') === true && control.getAttribute('aria-expanded') === 'true';

/**
 * A hint for the control under the pointer or with the focus. It describes the control; it never names it. Never over
 * the menu or popover its control has open: Esc closes the top one first, so it would take the Esc meant for the menu.
 * (Focus comes back to the control a moment after its menu closes, as the menu may already be open again.)
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <RadixTooltip.Root open={open} onOpenChange={(next) => setOpen(next && !opensPopup(trigger.current))}>
      <RadixTooltip.Trigger asChild ref={trigger}>
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="ui-tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

interface HoverCardProps {
  /** The card's body: a few lines of text under a small caps label. Nothing shows without it. */
  content: ReactNode | undefined;
  /** The caps label over it. */
  label: string;
  /** The object it is about: one element that takes a ref and DOM props. */
  children: ReactElement;
}

/**
 * A card of text that shows below the object under the pointer after the tooltip delay (about 0.5 s): more than a hint
 * says, for something you glance at now and then. It follows `Tooltip`'s timing but not its look, and has a provider of
 * its own, so it needs none above it. It never takes the pointer, so it closes as the pointer leaves the object and
 * never blocks a click or a wheel on what lies below; its text is cut at a few lines.
 */
export function HoverCard({ content, label, children }: HoverCardProps) {
  return (
    <RadixTooltip.Provider delayDuration={DELAY_MS} skipDelayDuration={0} disableHoverableContent>
      <RadixTooltip.Root>
        {/* Hover only: the trigger's focus handler would open it at once, with no delay, for any control focused inside. */}
        <RadixTooltip.Trigger asChild onFocus={(event) => event.preventDefault()}>
          {children}
        </RadixTooltip.Trigger>
        {content !== undefined && (
          <RadixTooltip.Portal>
            <RadixTooltip.Content className="ui-hover-card" side="bottom" sideOffset={8} collisionPadding={8}>
              <span className="ui-section-label">{label}</span>
              <span className="ui-hover-card-text">{content}</span>
            </RadixTooltip.Content>
          </RadixTooltip.Portal>
        )}
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

/** A tooltip's chip drawn in place, for the component gallery. */
export function TooltipPreview({ children }: { children: ReactNode }) {
  return (
    <div className="ui-tooltip" role="tooltip">
      {children}
    </div>
  );
}
