import type { Design } from './design';

// Show technical details (docs/adr/0022-simplified-design.md): one switch that adds the technical layer back under the
// Simplified design. Kept by the main process in a file of its own, as the design is, so it is known before a window
// paints.

/** The switch as a window's query carries it (`WINDOW_QUERY.technical`): off unless it reads `true`. */
export function technicalFromQuery(query: string | null): boolean {
  return query === 'true';
}

/** Whether a window shows the technical layer: always under Classic, which has no other; under the Simplified design only with the switch on. */
export function showsTechnicalDetails(design: Design, technical: boolean): boolean {
  return design === 'classic' || technical;
}
