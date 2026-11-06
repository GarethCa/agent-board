// What the user chose for the shelved zones: the leads freed from the head row (kept, and heard by every window), the
// zones whose Done chips are shown, and the stack fanned out (this window's, gone with it). Esc folds the fan back.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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

  useEffect(() => {
    if (open === null) return;
    const fold = (event: KeyboardEvent) => {
      // Not while typing: Esc there is the field's, or the terminal's.
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || target.closest('input, textarea, select, .xterm') !== null)) return;
      if (event.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', fold);
    return () => window.removeEventListener('keydown', fold);
  }, [open]);

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
