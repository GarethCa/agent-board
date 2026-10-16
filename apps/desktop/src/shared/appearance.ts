import { THEME_CHOICES, THEMES, type Theme, type ThemeChoice } from './themes';

// The Appearance setting: a mode and a theme choice. The mode is Light, Dark or System, which follows the OS's light or
// dark mode, live; the choice is a family, whose theme for the mode shows (Catppuccin is Latte in light, Mocha in
// dark). A choice with no theme for the mode shows the app's own. Kept by the main process in a file of its own, so it
// is known before a window paints.

export const MODES = ['light', 'dark', 'system'] as const;
export type Mode = (typeof MODES)[number];
type Scheme = Theme['scheme'];

export interface Appearance {
  mode: Mode;
  /** A theme choice's id (`THEME_CHOICES`). */
  theme: string;
}

export const DEFAULT_APPEARANCE: Appearance = { mode: 'system', theme: 'agent-board' };

/** Whether `value` is a setting as written now: a mode and a choice the registry knows. */
export function isAppearance(value: unknown): value is Appearance {
  if (typeof value !== 'object' || value === null) return false;
  const { mode, theme } = value as Record<string, unknown>;
  return MODES.includes(mode as Mode) && THEME_CHOICES.some(({ id }) => id === theme);
}

/**
 * The setting as saved (read back untyped). A theme's id, as saved before themes were picked by family, and as tests
 * pin it, becomes its choice in that theme's own mode, so it still shows; `system` is System with the app's own.
 * Anything else is the default.
 */
export function appearanceFrom(saved: unknown): Appearance {
  if (isAppearance(saved)) return { mode: saved.mode, theme: saved.theme };
  if (saved === 'system') return DEFAULT_APPEARANCE;
  const theme = THEMES.find(({ id }) => id === saved);
  const choice = theme && THEME_CHOICES.find((each) => each[theme.scheme] === theme.id);
  return theme && choice ? { mode: theme.scheme, theme: choice.id } : DEFAULT_APPEARANCE;
}

/** The setting as a window's query carries it (`WINDOW_QUERY.appearance`). */
export function appearanceQuery(appearance: Appearance): string {
  return JSON.stringify(appearance);
}

/** A window's query read back, or the default if it isn't one. A bare theme id moves as a saved one does. */
export function appearanceFromQuery(query: string | null): Appearance {
  if (query === null) return DEFAULT_APPEARANCE;
  try {
    return appearanceFrom(JSON.parse(query));
  } catch {
    return appearanceFrom(query);
  }
}

/** The setting's choice. */
export function choiceFor(appearance: Appearance): ThemeChoice {
  return THEME_CHOICES.find(({ id }) => id === appearance.theme) ?? THEME_CHOICES[0]!;
}

/** The theme the setting shows, in a window whose light or dark mode (the OS's, under System) is `dark`. */
export function themeFor(appearance: Appearance, dark: boolean): Theme {
  const scheme: Scheme = appearance.mode === 'system' ? (dark ? 'dark' : 'light') : appearance.mode;
  const id = choiceFor(appearance)[scheme] ?? THEME_CHOICES[0]![scheme];
  return THEMES.find((theme) => theme.id === id)!;
}

/** The mode the setting's choice has no theme of its own for, if the setting can be in it, so the app's own shows. */
export function missingMode(appearance: Appearance): Scheme | undefined {
  const choice = choiceFor(appearance);
  const missing = (['light', 'dark'] as const).find((scheme) => choice[scheme] === undefined);
  return missing !== undefined && (appearance.mode === 'system' || appearance.mode === missing) ? missing : undefined;
}

/** Electron's `nativeTheme.themeSource` for the setting: its mode. */
export function themeSourceFor(appearance: Appearance): Mode {
  return appearance.mode;
}
