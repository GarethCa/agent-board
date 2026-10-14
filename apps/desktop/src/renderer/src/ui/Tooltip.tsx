import type { ReactElement, ReactNode } from 'react';
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

/** A hint for the control under the pointer or with the focus. It describes the control; it never names it. */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="ui-tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
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
