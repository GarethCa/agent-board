import { useCallback, useEffect, useState } from 'react';
import { pressed } from '../keys/registry';
import { inOverlay } from '../keys';
import { KEY_BLOCKERS } from '../board/board-shortcuts';

export interface MasterPanelState {
  open: boolean;
  /** Grows with each ⌘⇧M, which puts the focus in the panel. */
  focusRequest: number;
  /** The Master button: opens the panel, or closes it. */
  toggle(): void;
  close(): void;
}

/**
 * Whether the board master's panel is open. ⌘⇧M opens it from the board window, a focused expanded tile's terminal
 * included, and puts the focus in its message box; pressed with it open, it gives the focus to the box again. Not while
 * a dialog, menu or session window is over the board.
 */
export function useMasterPanel(): MasterPanelState {
  const [open, setOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('move.master', event)) return;
      // A dialog, menu or session window over the board keeps the key: the panel would open under it.
      if (inOverlay() || document.querySelector(KEY_BLOCKERS) !== null) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      setFocusRequest((count) => count + 1);
    };
    // Before the terminal's keys, as ⌘K's.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, focusRequest, toggle, close };
}
