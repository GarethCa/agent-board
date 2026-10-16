import { PACK_THEMES, THEME_PACKS } from './theme-packs';

/*
 * The theme registry. A theme is a set of theme token values and nothing else: the light one is tokens.css's
 * `:root`, and each other one is a `:root[data-theme='<id>']` block that overrides its colours, terminal palette,
 * sticky notes and agent states. The two of the app's own are written in tokens.css; the theme packs' are made from
 * their palettes (theme-packs.ts) into theme-packs.css. Either way it becomes a choice in Settings › Appearance, and
 * tokens.test.ts holds it to the rules the dark theme meets.
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
  /** The pack it comes from, by its family's name, or none for the app's own. */
  family?: string;
}

/** The app's own: Workbench light and Warm graphite, the two System picks between. */
const OWN_THEMES = [
  { id: 'light', name: 'Light', scheme: 'light', system: true, desk: '#f6f4ef' },
  { id: 'dark', name: 'Dark', scheme: 'dark', system: true, desk: '#1b1a19' },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof OWN_THEMES)[number]['id'] | (typeof PACK_THEMES)[number]['id'];

export const THEMES: readonly (Theme & { id: ThemeId })[] = [
  ...OWN_THEMES,
  ...THEME_PACKS.flatMap(({ family, themes }) =>
    themes.map(({ id, name, scheme, palette }) => ({ id, name, scheme, system: false, desk: palette.desk, family })),
  ),
];
