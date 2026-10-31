import { memo, type ReactNode } from 'react';
import { HUMAN_STATUS_LABELS, type HumanStatus } from '@agent-board/daemon/human-status';
import { Character, type CharacterPose } from './Character';
import { useStatusLook, type StatusLook } from './status-look';

/**
 * Each status's glyph on a 16 px grid. Only the two that want the user, Needs you and Problem, are filled; their marks
 * are holes in the fill (even-odd), so whatever is behind shows through. The other four are outlines.
 */
const GLYPHS: Record<HumanStatus, ReactNode> = {
  // A speech bubble with three dots.
  'needs-you': (
    <path
      fillRule="evenodd"
      fill="currentColor"
      d="M3.2 2.5h9.6A1.7 1.7 0 0 1 14.5 4.2v5.6a1.7 1.7 0 0 1-1.7 1.7H7.6L4.3 14v-2.5H3.2A1.7 1.7 0 0 1 1.5 9.8V4.2a1.7 1.7 0 0 1 1.7-1.7Z M4.2 7a1 1 0 1 0 2 0a1 1 0 1 0-2 0Z M7 7a1 1 0 1 0 2 0a1 1 0 1 0-2 0Z M9.8 7a1 1 0 1 0 2 0a1 1 0 1 0-2 0Z"
    />
  ),
  // A warning triangle with an exclamation mark.
  problem: (
    <path
      fillRule="evenodd"
      fill="currentColor"
      d="M8 1.1 15.6 14.5H0.4Z M7.2 6.2a0.8 0.8 0 0 1 1.6 0v3.6a0.8 0.8 0 0 1-1.6 0Z M7.05 11.8a0.95 0.95 0 1 0 1.9 0a0.95 0.95 0 1 0-1.9 0Z"
    />
  ),
  // A circle half filled: under way.
  working: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 3.6a4.4 4.4 0 0 1 0 8.8Z" fill="currentColor" />
    </>
  ),
  // A tick in a circle.
  done: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="m5.2 8.2 1.9 1.9 3.8-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Two bars in a circle.
  paused: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.4 5.6v4.8M9.6 5.6v4.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </>
  ),
  // A clock face.
  scheduled: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
};

/**
 * The pose the orange character strikes for each status: a hand raised, mid-stride, happy with a tick, dozing, timing
 * with a stopwatch, toppled over.
 */
const STATUS_POSES: Record<HumanStatus, CharacterPose> = {
  'needs-you': 'waiting',
  working: 'running',
  done: 'done',
  paused: 'idle',
  scheduled: 'on-command',
  problem: 'failed',
};

/**
 * An agent's status as the Simplified design draws it: its glyph, or with Characters picked the orange character
 * acting it out, and always its word, so the status never rests on a shape or a colour alone. `look` overrides the
 * picked one.
 */
export const StatusMark = memo(function StatusMark({ status, look }: { status: HumanStatus; look?: StatusLook }) {
  const picked = useStatusLook();
  const drawn = look ?? picked;
  return (
    <span className="status-mark" data-testid="status-mark" data-status={status} data-look={drawn}>
      {drawn === 'characters' ? (
        <span className="status-mark-character" aria-hidden="true">
          {/* Claude's orange character for every agent, whatever its harness. */}
          <Character harness="claude" pose={STATUS_POSES[status]} />
        </span>
      ) : (
        <StatusGlyph status={status} className="status-mark-glyph" />
      )}
      <span className="status-mark-word">{HUMAN_STATUS_LABELS[status]}</span>
    </span>
  );
});

/** A status's glyph alone, for a control that names the status in its own words, such as the Needs you button. */
export function StatusGlyph({ status, className }: { status: HumanStatus; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {GLYPHS[status]}
    </svg>
  );
}
