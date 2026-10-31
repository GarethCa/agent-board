import { useCallback, useEffect, useState } from 'react';
import { useSimplified } from '../design';
import { pressed } from '../keys/registry';
import { inOverlay } from '../keys';
import { KEY_BLOCKERS } from '../board/board-shortcuts';

/** Which side of the docked pane is showing: the Needs-you list or the Captain's chat. Classic's panel is always the Captain's. */
export type PaneSide = 'needs-you' | 'captain';

export interface MasterPanelState {
  open: boolean;
  /** What the pane shows while it is open; the side it last opened on while it is shut. */
  side: PaneSide;
  /** Grows with each ⌘⇧M, which puts the focus in the panel. */
  focusRequest: number;
  /** A button's click: opens the pane on `side`, or closes it if it is open on that side already. */
  toggle(side: PaneSide): void;
  close(): void;
}

/**
 * Whether the Captain's panel is open, and under the Simplified design which side of it. ⌘⇧M opens it from the board window, a focused expanded tile's terminal
 * included, and puts the focus in its message box; pressed with it open, it gives the focus to the box again. Not while
 * a dialog, menu or session window is over the board.
 */
export function useMasterPanel(): MasterPanelState {
  const [pane, setPane] = useState<{ open: boolean; side: PaneSide }>({ open: false, side: 'captain' });
  const [focusRequest, setFocusRequest] = useState(0);
  const simplified = useSimplified();
  // Classic's panel is only ever the Captain's: a design switched off with the list open must not leave its side behind.
  useEffect(() => {
    if (!simplified) setPane((current) => (current.side === 'captain' ? current : { ...current, side: 'captain' }));
  }, [simplified]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('move.master', event)) return;
      // A dialog, menu or session window over the board keeps the key: the panel would open under it.
      if (inOverlay() || document.querySelector(KEY_BLOCKERS) !== null) return;
      event.preventDefault();
      event.stopPropagation();
      setPane({ open: true, side: 'captain' });
      setFocusRequest((count) => count + 1);
    };
    // Before the terminal's keys, as ⌘K's.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  const toggle = useCallback((next: PaneSide) => setPane((current) => (current.open && current.side === next ? { ...current, open: false } : { open: true, side: next })), []);
  const close = useCallback(() => setPane((current) => ({ ...current, open: false })), []);
  return { open: pane.open, side: pane.side, focusRequest, toggle, close };
}
