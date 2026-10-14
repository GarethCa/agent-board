import { THEMES, type Theme, type ThemeId } from './themes';

// The Appearance setting (AO1): which theme the app shows. System follows the OS's light or dark mode, live;
// picking a theme overrides it. Kept by the main process in a file of its own, so it is known before a window paints.

export const APPEARANCES = ['system', ...THEMES.map(({ id }) => id)] as const;
export type Appearance = 'system' | ThemeId;

/** The setting as saved (read back untyped): System unless a theme in the registry was saved. */
export function appearanceFrom(saved: unknown): Appearance {
  return APPEARANCES.find((appearance) => appearance === saved) ?? 'system';
}

/** The theme the setting shows, in a window whose light or dark mode (the OS's, under System) is `dark`. */
export function themeFor(appearance: Appearance, dark: boolean): Theme {
  const scheme = dark ? 'dark' : 'light';
  return THEMES.find((theme) => (appearance === 'system' ? theme.system && theme.scheme === scheme : theme.id === appearance))!;
}

/** Electron's `nativeTheme.themeSource` for the setting: the OS's mode, or the picked theme's. */
export function themeSourceFor(appearance: Appearance): 'system' | Theme['scheme'] {
  return appearance === 'system' ? 'system' : themeFor(appearance, false).scheme;
}
