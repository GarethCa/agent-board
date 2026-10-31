import type { Theme } from './themes';

// The Simplified design setting (docs/adr/0022-simplified-design.md): today's design, Classic, or the Simplified one,
// a flag over the same components. Kept by the main process in a file of its own, as the Appearance setting is, so it
// is known before a window paints.

export const DESIGNS = ['classic', 'simplified'] as const;
export type Design = (typeof DESIGNS)[number];

export const DEFAULT_DESIGN: Design = 'classic';

export function isDesign(value: unknown): value is Design {
  return DESIGNS.includes(value as Design);
}

/** The setting as saved or as a window's query carries it (`WINDOW_QUERY.design`), read back untyped: Classic unless it is a design. */
export function designFrom(saved: unknown): Design {
  return isDesign(saved) ? saved : DEFAULT_DESIGN;
}

/**
 * The Simplified design's desk in each mode, the `--surface` of its blocks in tokens.css (tokens.test.ts holds them
 * equal), for a new window's background before its page paints.
 */
const SIMPLIFIED_DESK: Record<Theme['scheme'], string> = { light: '#f3f3f5', dark: '#1b1b1e' };

/** The desk a window opens on: the theme's own, or under the Simplified design its desk in the theme's mode. */
export function deskFor(design: Design, theme: Theme): string {
  return design === 'simplified' ? SIMPLIFIED_DESK[theme.scheme] : theme.desk;
}
