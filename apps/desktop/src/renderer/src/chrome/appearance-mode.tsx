import { useCallback, useEffect, useState } from 'react';
import { Moon, Sun, SunMoon } from 'lucide-react';
import type { Appearance } from '../../../shared/appearance';

/** The mode's options, in the order every control of it shows them: Settings › Appearance and the board menu's quick setting. */
export const MODE_OPTIONS = [
  { id: 'light', label: 'Light', icon: <Sun /> },
  { id: 'dark', label: 'Dark', icon: <Moon /> },
  { id: 'system', label: 'System', icon: <SunMoon /> },
] as const;

type OnError = (action: string) => (error: unknown) => void;

/**
 * The appearance setting (the main process's, main/appearance.ts) as picked in any window, and a way to change it:
 * `appearance` is undefined until read, and `pick` shows a change at once and puts the old value back if it fails.
 */
export function useAppearance(onError: OnError): { appearance: Appearance | undefined; pick(change: Partial<Appearance>): void } {
  const [appearance, setAppearance] = useState<Appearance>();
  useEffect(() => {
    const api = window.agentBoard.appearance;
    api.get().then(setAppearance, onError('read the appearance'));
    return api.onChanged(setAppearance);
  }, [onError]);

  const pick = useCallback(
    (change: Partial<Appearance>) => {
      if (appearance === undefined) return;
      const was = appearance;
      const next = { ...appearance, ...change };
      setAppearance(next);
      window.agentBoard.appearance.set(next).catch((error: unknown) => {
        setAppearance(was);
        onError('change the appearance')(error);
      });
    },
    [appearance, onError],
  );
  return { appearance, pick };
}
