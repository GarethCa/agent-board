import { useEffect, useState } from 'react';
import { pressed } from '../keys/registry';

/** Whether a key pressed at `target` is for the tab at `root`: pressed inside it, or with nothing focused while the pointer is over it. Never a terminal's. */
function findKeyIsFor(root: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('.xterm') !== null) return false;
  if (root.contains(target)) return true;
  return (target === document.body || target === document.documentElement) && root.matches(':hover');
}

/**
 * ⌘F in a tab that can be found in: `finding` is 0 while the bar is shut and a count that grows with each press while it is
 * open, so a bar already open can take the keyboard again. `getRoot` gives the tab's element; `enabled` is false while the
 * tab is hidden or has nothing to find. `close` shuts the bar.
 */
export function useFindKey(getRoot: () => Element | null, enabled: boolean): { finding: number; close(): void } {
  const [finding, setFinding] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const root = getRoot();
      if (root === null || !pressed('window.find', event) || !findKeyIsFor(root, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      setFinding((count) => count + 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  return { finding: open ? finding : 0, close: () => setOpen(false) };
}
