import { cloneElement, useLayoutEffect, useRef, useState, type PointerEvent, type ReactElement, type ReactNode, type Ref, type SyntheticEvent } from 'react';
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

/** What woke a tooltip: the pointer coming over its control, or the focus coming to it. */
type Wake = { node: HTMLElement; by: 'hover' | 'focus' };

/**
 * Wakes a hint on first use. A board holds hundreds of controls and a Radix tooltip is a dozen components each, so a
 * control mounts none until the pointer first rests on it or the focus first comes to it; `live` then mounts the
 * tooltip beside the control, which is never remounted (it keeps its focus, its state, and for a `HoverCard` the
 * whole tile). The control's hover and focus handlers stay as they were.
 */
function useWake(child: ReactElement, hover: boolean) {
  const [wake, setWake] = useState<Wake | undefined>();
  const props = child.props as Record<string, unknown>;
  const wakeBy = (by: Wake['by']) => (event: SyntheticEvent<HTMLElement>) => {
    const node = event.currentTarget;
    setWake((now) => (now !== undefined && now.node === node ? now : { node, by: now === undefined ? by : now.by }));
  };
  const chain = (name: string, handler: (event: SyntheticEvent<HTMLElement>) => void) => (event: SyntheticEvent<HTMLElement>) => {
    (props[name] as ((event: SyntheticEvent<HTMLElement>) => void) | undefined)?.(event);
    handler(event);
  };
  const control = cloneElement(child as ReactElement<Record<string, unknown>>, {
    onPointerEnter: chain('onPointerEnter', (event) => {
      if ((event as PointerEvent<HTMLElement>).pointerType !== 'touch') wakeBy('hover')(event);
    }),
    ...(hover ? {} : { onFocus: chain('onFocus', wakeBy('focus')) }),
  });
  return { wake, control };
}

/**
 * Stands in for the real control inside a Radix trigger: the trigger hands this element its handlers, ARIA and ref,
 * and it applies them to the control already on the page instead of rendering one. That is what lets the tooltip mount
 * late, beside a control that never remounts. `hoverOnly` leaves out the focus handlers.
 */
function OnControl({ node, first, hoverOnly = false, ref, ...props }: { node: HTMLElement; first: Wake['by']; hoverOnly?: boolean; ref?: Ref<HTMLElement> } & Record<string, unknown>) {
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
    const events = Object.keys(props)
      .filter((name) => /^on[A-Z]/.test(name) && !(hoverOnly && (name === 'onFocus' || name === 'onBlur')))
      .map((name) => {
        // React's onFocus and onBlur bubble, as focusin and focusout do; the native focus and blur do not.
        const type = name === 'onFocus' ? 'focusin' : name === 'onBlur' ? 'focusout' : name.slice(2).toLowerCase();
        const listener = (event: Event) => (latest.current[name] as (event: Event) => void)(event);
        node.addEventListener(type, listener);
        return () => node.removeEventListener(type, listener);
      });
    // The pointer is over the control, or the focus is on it, now: tell the trigger, as it would have heard. Only if it
    // still is: a hover card with no text yet mounts when its text arrives, long after the pointer has gone.
    if (first === 'hover' && node.matches(':hover')) (props.onPointerMove as (event: Event) => void)(new PointerEvent('pointermove', { pointerType: 'mouse' }));
    else if (first === 'focus' && !hoverOnly && node.matches(':focus-within')) (props.onFocus as (event: Event) => void)(new FocusEvent('focus'));
    return () => {
      for (const off of events) off();
      if (typeof ref === 'function') ref(null);
    };
    // The handlers are read through `latest`; only a different control starts this over.
  }, [node]);
  // The trigger's `aria-describedby`, while its tip is open. Not its `data-state`: the control may use its own, as a tile does.
  const describedBy = props['aria-describedby'] as string | undefined;
  useLayoutEffect(() => {
    if (describedBy === undefined || node.hasAttribute('aria-describedby')) return;
    node.setAttribute('aria-describedby', describedBy);
    return () => node.removeAttribute('aria-describedby');
  }, [node, describedBy]);
  return null;
}

/**
 * A hint for the control under the pointer or with the focus. It describes the control; it never names it. Never over
 * the menu or popover its control has open: Esc closes the top one first, so it would take the Esc meant for the menu.
 * (Focus comes back to the control a moment after its menu closes, as the menu may already be open again.)
 * Nothing of it is mounted until the pointer or the focus first comes to the control.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const { wake, control } = useWake(children, false);
  return (
    <>
      {control}
      {wake?.node.isConnected && <LiveTooltip wake={wake} content={content} side={side} />}
    </>
  );
}

function LiveTooltip({ wake, content, side }: { wake: Wake; content: ReactNode; side: NonNullable<TooltipProps['side']> }) {
  const [open, setOpen] = useState(false);
  return (
    <RadixTooltip.Root open={open} onOpenChange={(next) => setOpen(next && !opensPopup(wake.node))}>
      <RadixTooltip.Trigger asChild>
        <OnControl node={wake.node} first={wake.by} />
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
 * never blocks a click or a wheel on what lies below; its text is cut at a few lines. Like a `Tooltip`, nothing of it
 * is mounted until the pointer first comes over the object.
 */
export function HoverCard({ content, label, children }: HoverCardProps) {
  const { wake, control } = useWake(children, true);
  return (
    <>
      {control}
      {wake?.node.isConnected && content !== undefined && <LiveHoverCard wake={wake} content={content} label={label} />}
    </>
  );
}

function LiveHoverCard({ wake, content, label }: { wake: Wake; content: ReactNode; label: string }) {
  return (
    <RadixTooltip.Provider delayDuration={DELAY_MS} skipDelayDuration={0} disableHoverableContent>
      <RadixTooltip.Root>
        {/* Hover only: a trigger's focus handler would open it at once, with no delay, for any control focused inside. */}
        <RadixTooltip.Trigger asChild>
          <OnControl node={wake.node} first="hover" hoverOnly />
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="ui-hover-card" side="bottom" sideOffset={8} collisionPadding={8}>
            <span className="ui-section-label">{label}</span>
            <span className="ui-hover-card-text">{content}</span>
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
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
