import { themeFor, type Appearance } from '../../shared/appearance';

// Which theme a window shows (the registry is shared/themes.ts): the Appearance setting's pick, or under System the
// theme for the window's light or dark mode. The main process points Electron's `nativeTheme.themeSource` at the
// setting, so `prefers-color-scheme` is the OS's mode under System and the picked theme's otherwise.

/** The query for whether the window is in dark mode. */
export const darkQuery = (): MediaQueryList => matchMedia('(prefers-color-scheme: dark)');

/** What `followTheme` needs of `darkQuery()`. */
interface DarkQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** What `followTheme` needs of the Appearance setting: its value as the window opened, and its changes. */
interface AppearanceSource {
  initial: Appearance;
  onChanged(listener: (appearance: Appearance) => void): () => void;
}

/**
 * Shows the theme on `root` (`data-theme`, which tokens.css and the terminal read, and `data-scheme`, its light or dark
 * mode, for what follows the mode rather than one theme), now and whenever it changes: the OS switching at sunset, or
 * the setting picked in any window. Returns a stop function.
 */
export function followTheme(
  root: { dataset: DOMStringMap } = document.documentElement,
  dark: DarkQuery = darkQuery(),
  appearance: AppearanceSource = window.agentBoard.appearance,
): () => void {
  let picked = appearance.initial;
  const show = () => {
    const theme = themeFor(picked, dark.matches);
    root.dataset.theme = theme.id;
    root.dataset.scheme = theme.scheme;
  };
  show();
  dark.addEventListener('change', show);
  const stopListening = appearance.onChanged((next) => {
    picked = next;
    show();
  });
  return () => {
    dark.removeEventListener('change', show);
    stopListening();
  };
}
