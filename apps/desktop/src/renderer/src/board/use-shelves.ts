// What the user chose for the shelved zones: the leads freed from the head row (kept, and heard by every window), the
// zones whose Done chips are shown, and the stack fanned out (this window's, gone with it). Esc folds the fan back.
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useEscStep } from '../keys/esc-ladder';
import { isTyping } from '../keys/typing';
import { storedValue } from '../stored-value';
import type { ShelvesChoice } from './shelves';

const freedStore = storedValue('agent-board.shelves.freed-leads');

/** The freed leads' session ids, from what was stored: only strings, once each. */
export function freedFrom(stored: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(stored ?? '[]');
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string'))] : [];
  } catch {
    return [];
  }
}

/** `freed` with `sessionId` freed (or pinned again), keeping only agents still on the board (`live`), so it never grows for good. */
export function withFreed(freed: readonly string[], sessionId: string, pinned: boolean, live: ReadonlySet<string>): string[] {
  const kept = freed.filter((id) => id !== sessionId && live.has(id));
  return pinned ? kept : [...kept, sessionId];
}

export function useShelves() {
  const stored = useSyncExternalStore(freedStore.subscribe, freedStore.get, () => undefined);
  const freed = useMemo(() => new Set(freedFrom(stored)), [stored]);
  const [doneShown, setDoneShown] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ShelvesChoice['open']>(null);

  // Esc folds the shelves, one step on the ladder; not while typing, where Esc is the field's or the terminal's, nor in a
  // session window or an expanded tile, the inner thing, which Esc leaves first.
  useEscStep('shelves', (event) => open !== null && !isTyping(event) && !(event.target instanceof Element && event.target.closest('.session-window, .expanded-tile') !== null), () => setOpen(null));

  /** Frees a lead from its shelved zone's head row, or pins it there again; `live` is every agent on the board. */
  const setPinned = useCallback((sessionId: string, pinned: boolean, live: ReadonlySet<string>) => {
    freedStore.set(JSON.stringify(withFreed(freedFrom(freedStore.get()), sessionId, pinned, live)));
  }, []);
  /** Shows a zone's Done, whatever it showed: to show an agent folded into it. */
  const showDone = useCallback((zoneId: string) => setDoneShown((current) => (current.has(zoneId) ? current : new Set([...current, zoneId]))), []);
  /** Fans the stack out, whatever was open: to show an agent folded into it. */
  const openStack = useCallback((zoneId: string, key: string) => setOpen({ zoneId, key }), []);
  const toggleStack = useCallback((zoneId: string, key: string) => setOpen((current) => (current?.zoneId === zoneId && current.key === key ? null : { zoneId, key })), []);
  const toggleDone = useCallback(
    (zoneId: string) =>
      setDoneShown((current) => {
        const next = new Set(current);
        if (!next.delete(zoneId)) next.add(zoneId);
        return next;
      }),
    [],
  );
  const choice = useMemo((): ShelvesChoice => ({ freed, doneShown, open }), [freed, doneShown, open]);
  return { choice, setPinned, openStack, showDone, toggleStack, toggleDone };
}
