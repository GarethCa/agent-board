import { useCallback, useState } from 'react';

const KEY = 'needs-you-dismissed-problems';
/** How many dismissals are kept: the newest, so the list never grows without end. */
const KEPT = 200;

function read(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(kept) ? kept.filter((each): each is string => typeof each === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The failed agents' problems the user dismissed from the Needs-you list (by `problemKey`), kept in this browser: a
 * convenience only, so with nothing kept every failure is listed again.
 */
export function useDismissedProblems(): [ReadonlySet<string>, (key: string) => void] {
  const [keys, setKeys] = useState(read);
  const dismiss = useCallback((key: string) => {
    setKeys((before) => {
      const next = [...before.filter((each) => each !== key), key].slice(-KEPT);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Only a convenience: it is dismissed until the list is drawn again.
      }
      return next;
    });
  }, []);
  return [new Set(keys), dismiss];
}
