import { useCallback, useState } from 'react';
import { errorMessage } from '../../shared/errors';

/**
 * Runs an async action from the UI: `busy` while it runs, and `error` saying why it failed (cleared when the next
 * starts). `onDone` runs after it succeeds, with what it resolved to.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(<T>(action: () => Promise<T>, onDone?: (result: T) => void) => {
    setBusy(true);
    setError(undefined);
    action().then(
      (result) => {
        setBusy(false);
        onDone?.(result);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(errorMessage(failure));
      },
    );
  }, []);
  return { busy, error, run };
}
