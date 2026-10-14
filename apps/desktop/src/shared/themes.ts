/*
 * The theme registry. A theme is a set of theme token values and nothing else: the light one is tokens.css's
 * `:root`, and each other one is a `:root[data-theme='<id>']` block there that overrides its colours, terminal palette,
 * sticky notes and agent states. Adding a theme is adding its block and its entry here: it becomes a choice in
 * Settings › Appearance, and tokens.test.ts holds it to the rules the dark theme meets.
 *
 * Shared by the main process, which needs a theme's light or dark mode and its desk before a window paints, and the
 * renderer, which shows it.
 */

export interface Theme {
  /** Its `data-theme` value. */
  id: string;
  /** What Settings › Appearance calls it. */
  name: string;
  /** Whether it is a light or a dark theme: what the OS's light or dark mode and native controls follow. */
  scheme: 'light' | 'dark';
  /** Whether System shows it when the OS is in its `scheme`'s mode. One per scheme. */
  system: boolean;
  /** Its `--surface`, a new window's background until the page paints (tokens.test.ts checks they agree). */
  desk: string;
}

export const THEMES = [
  { id: 'light', name: 'Light', scheme: 'light', system: true, desk: '#f6f4ef' },
  { id: 'dark', name: 'Dark', scheme: 'dark', system: true, desk: '#1b1a19' },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof THEMES)[number]['id'];
