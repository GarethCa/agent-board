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
  /** Its look in small, in the Theme popover: its desk and card edge, with its accent and three states' colours. */
  preview: ThemePreview;
  /** The pack it comes from, by its family's name, or none for the app's own. */
  family?: string;
}

export interface ThemePreview {
  desk: string;
  edge: string;
  accent: string;
  running: string;
  waiting: string;
  failed: string;
}

/** The app's own: Workbench light and Warm graphite (their previews are their tokens, as tokens.test.ts checks). */
const OWN_THEMES = [
  {
    id: 'light',
    name: 'Light',
    scheme: 'light',
    system: true,
    desk: '#f6f4ef',
    preview: { desk: '#f6f4ef', edge: '#e2ddd1', accent: '#3b5bdb', running: '#2f9e44', waiting: '#f76707', failed: '#c92a2a' },
  },
  {
    id: 'dark',
    name: 'Dark',
    scheme: 'dark',
    system: true,
    desk: '#1b1a19',
    preview: { desk: '#1b1a19', edge: '#34322f', accent: '#3b5bdb', running: '#4f9e5c', waiting: '#e07a35', failed: '#ef8080' },
  },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof OWN_THEMES)[number]['id'] | (typeof PACK_THEMES)[number]['id'];

export const THEMES: readonly (Theme & { id: ThemeId })[] = [
  ...OWN_THEMES,
  ...THEME_PACKS.flatMap(({ family, themes }) =>
    themes.map(({ id, name, scheme, palette }) => ({
      id,
      name,
      scheme,
      system: false,
      desk: palette.desk,
      preview: { desk: palette.desk, edge: palette.border, accent: palette.accent, running: palette.ok, waiting: palette.warn, failed: palette.fail },
      family,
    })),
  ),
];

/**
 * A card in Settings › Appearance's Theme popover: a light and a dark theme, of which the mode picks one. The app's own
 * is Light and Dark; a pack's family pairs its light and dark themes, and an extra variant for one mode (`ownChoice`)
 * is a choice of its own, with the family's theme for the other mode. Only a family with no theme at all for a mode
 * shows the app's own there.
 */
export interface ThemeChoice {
  /** What the Appearance setting saves: a family's id, or the theme's for a choice of its own. Never changes once shipped. */
  id: string;
  name: string;
  /** The family it is grouped under in the popover. */
  family: string;
  /** The family's attribution line, for a pack's. */
  credit?: string;
  light?: ThemeId;
  dark?: ThemeId;
}

const ownTheme = (scheme: Theme['scheme']) => OWN_THEMES.find((theme) => theme.system && theme.scheme === scheme)!.id;

export const THEME_CHOICES: readonly ThemeChoice[] = [
  { id: 'agent-board', name: 'Agent Board', family: 'Agent Board', light: ownTheme('light'), dark: ownTheme('dark') },
  ...THEME_PACKS.flatMap(({ id, family, credit, themes }) => {
    const paired = themes.filter((theme) => !('ownChoice' in theme && theme.ownChoice));
    const scheme = (wanted: Theme['scheme']) => paired.find((theme) => theme.scheme === wanted)?.id;
    return [
      { id, name: family, family, credit, light: scheme('light'), dark: scheme('dark') },
      ...themes
        .filter((theme) => !paired.includes(theme))
        .map((theme): ThemeChoice => ({ id: theme.id, name: theme.name, family, credit, light: scheme('light'), dark: scheme('dark'), [theme.scheme]: theme.id })),
    ];
  }),
];
