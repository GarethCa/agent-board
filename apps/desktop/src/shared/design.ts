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
