import type { ReactNode } from 'react';
import type { GlanceState } from './glance-tile';

/** Each glance state's glyph on a 12 px grid: filled where it is at work or wants the user, outlined where it rests. */
const GLYPHS: Record<GlanceState, ReactNode> = {
  // A dot: under way.
  working: <circle cx="6" cy="6" r="4" fill="currentColor" />,
  // Three dots.
  thinking: (
    <>
      <circle cx="2.2" cy="6" r="1.45" fill="currentColor" />
      <circle cx="6" cy="6" r="1.45" fill="currentColor" />
      <circle cx="9.8" cy="6" r="1.45" fill="currentColor" />
    </>
  ),
  // A speech bubble.
  needs: <path d="M2 1.6h8a1.3 1.3 0 0 1 1.3 1.3v4.6A1.3 1.3 0 0 1 10 8.8H5.6L3 11V8.8H2A1.3 1.3 0 0 1 .7 7.5V2.9A1.3 1.3 0 0 1 2 1.6z" fill="currentColor" />,
  // A shield.
  permission: <path d="M6 .8l4.7 1.9v3.3c0 2.7-2 4.5-4.7 5.2C3.3 10.5 1.3 8.7 1.3 6V2.7z" fill="currentColor" />,
  // A crossed octagon.
  failed: (
    <>
      <path d="M4 1h4l3 3v4l-3 3H4L1 8V4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M4.4 4.4l3.2 3.2M7.6 4.4L4.4 7.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  // An empty ring.
  idle: <circle cx="6" cy="6" r="3.9" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  // A tick.
  done: <path d="M2 6.4l2.5 2.5L10 3.3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />,
  // Two bars.
  paused: (
    <>
      <rect x="2.8" y="2.2" width="2.3" height="7.6" rx=".7" fill="currentColor" />
      <rect x="6.9" y="2.2" width="2.3" height="7.6" rx=".7" fill="currentColor" />
    </>
  ),
  // An hourglass, run down.
  limit: (
    <>
      <path d="M2.6 1h6.8L6 6l3.4 5H2.6L6 6z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M4.2 10.2h3.6L6 7.8z" fill="currentColor" />
    </>
  ),
  // A page with a dot: its work is with a reviewer.
  review: (
    <>
      <rect x="1.4" y="1" width="7" height="9.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.2 3.8h3.4M3.2 5.8h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="8.8" cy="8.6" r="2.6" fill="currentColor" />
    </>
  ),
  // A clock face.
  scheduled: (
    <>
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3.6V6l1.7 1.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
};

/** A glance state's glyph, drawn beside its word, never in its place. */
export function GlanceGlyph({ state, size = 12, className }: { state: GlanceState; size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" width={size} height={size} aria-hidden="true" data-glyph={state}>
      {GLYPHS[state]}
    </svg>
  );
}
