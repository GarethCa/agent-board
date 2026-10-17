import type { KeyboardEvent } from 'react';
import { ArrowUpRight, Waypoints } from 'lucide-react';
import { AnchoredPopover, Kbd } from '../../ui';
import { keyText } from '../../keys/registry';

/**
 * Asks what a connector just dropped from one agent's tile on another's is: an Arrow, as it is drawn
 * (the default: Enter, Esc or a click elsewhere), or a hand-off carrying `payload` (H). Beside `at`, where it was let
 * go, on the window.
 */
export function HandOffChooser({ at, payload, onArrow, onHandOff }: { at: { x: number; y: number }; payload: string; onArrow(): void; onHandOff(): void }) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'h' && event.key !== 'H') return;
    event.preventDefault();
    onHandOff();
  };
  return (
    <AnchoredPopover
      anchor={<span className="handoff-chooser-anchor" style={{ left: at.x, top: at.y }} />}
      open
      onOpenChange={(open) => open || onArrow()}
      aria-label="Arrow or hand-off"
      className="handoff-chooser"
      side="right"
      sideOffset={12}
    >
      <div role="menu" className="handoff-chooser-options" data-testid="handoff-chooser" onKeyDown={onKeyDown}>
        {/* Focused as it opens, so Enter keeps the arrow. */}
        <button type="button" role="menuitem" className="ui-menu-item handoff-chooser-option" autoFocus onClick={onArrow}>
          <ArrowUpRight aria-hidden />
          <span className="handoff-chooser-name">Arrow</span>
          <Kbd aria-hidden>{keyText('dialog.pick')}</Kbd>
          <Kbd aria-hidden>{keyText('dialog.close')}</Kbd>
        </button>
        <button type="button" role="menuitem" className="ui-menu-item handoff-chooser-option" onClick={onHandOff}>
          <Waypoints aria-hidden />
          <span className="handoff-chooser-name">
            Hand off ▸ <span className="handoff-chooser-payload">{payload}</span>
          </span>
          <Kbd aria-hidden>{keyText('dialog.handOff')}</Kbd>
        </button>
      </div>
    </AnchoredPopover>
  );
}
