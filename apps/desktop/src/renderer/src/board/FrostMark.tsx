import type { ReactNode } from 'react';
import { Check, Snowflake, TriangleAlert } from 'lucide-react';
import { useNeedsYouShows } from '../needs-you-setting';
import { frozenChip, frozenKind, type FrostFacts, type FrozenKind } from './paused';

/** Why each kind of frozen agent is frozen, as its mark's tooltip. */
const MARK_TITLE: Record<FrozenKind, string> = {
  paused: 'Paused: Wake, or a message, starts it again',
  scheduled: 'Scheduled: its clock wakes it by itself',
  done: 'Done: Wake carries on its conversation',
  exited: 'Exited on an error: Wake, or a message, starts it again',
};

/** A clock face with its hands at `at` (a wake time), for the head's mark and the watermark. */
function ClockFace({ at, className }: { at: string | null; className?: string }) {
  const { hour, minute } = clockHands(at);
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="12" x2="12" y2="7" transform={`rotate(${hour} 12 12)`} />
      <line x1="12" y1="12" x2="12" y2="5" transform={`rotate(${minute} 12 12)`} />
    </svg>
  );
}

/**
 * A wake time's clock hands, in degrees from twelve, rounded to the nearest half hour, in local time: the hour hand
 * between its hours, as on a real clock. With no wake time, ten past ten: a clock at rest.
 */
export function clockHands(at: string | null): { hour: number; minute: number } {
  const when = at === null ? undefined : new Date(at);
  if (when === undefined || Number.isNaN(when.getTime())) return { hour: 300, minute: 60 };
  const halves = Math.round((when.getHours() * 60 + when.getMinutes()) / 30) % 24;
  return { hour: (halves * 15) % 360, minute: halves % 2 === 0 ? 0 : 180 };
}

/** The kind's glyph: a snowflake, a clock at its wake time, a tick or a warning. */
function KindGlyph({ kind, at, className }: { kind: FrozenKind; at: string | null; className?: string }) {
  if (kind === 'scheduled') return <ClockFace className={className} at={at} />;
  const Glyph = kind === 'paused' ? Snowflake : kind === 'done' ? Check : TriangleAlert;
  return <Glyph className={className} aria-hidden />;
}

/**
 * A frozen agent's mark, in its tile's head beside its name: a snowflake (paused, or stopped by a restart), a clock
 * (scheduled), a tick (done) or a warning (exited on an error); none while it runs. Its tile's status and line say why
 * already, so a screen reader skips it.
 */
export function FrostMark({ agent }: { agent: FrostFacts }) {
  const kind = frozenKind(agent, useNeedsYouShows());
  if (kind === undefined) return null;
  const title = kind === 'paused' && agent.state === 'stopped-by-restart' ? 'Stopped by a restart: Wake starts it again' : MARK_TITLE[kind];
  return (
    <span className="tile-frost-mark" data-testid="tile-frost-mark" data-kind={kind} aria-hidden title={title}>
      <KindGlyph kind={kind} at={agent.schedule?.nextRunAt ?? null} />
    </span>
  );
}

/**
 * A frozen agent's watermark: its kind's glyph, large and faint in the tile's bottom-right corner, under its text and
 * clipped by the tile. It never moves and takes no pointer.
 */
export function FrostWatermark({ agent }: { agent: FrostFacts }) {
  const kind = frozenKind(agent, useNeedsYouShows());
  if (kind === undefined) return null;
  return (
    <span className="tile-frost-watermark" data-testid="tile-frost-watermark" data-kind={kind} aria-hidden>
      <KindGlyph kind={kind} at={agent.schedule?.nextRunAt ?? null} />
    </span>
  );
}

/**
 * A frozen helper's badge, on its icon on its ticket's tile: a snowflake, a clock, a tick or a warning. Its card's word
 * says why already, so a screen reader skips it.
 */
export function FrostBadge({ kind }: { kind: FrozenKind | undefined }) {
  if (kind === undefined) return null;
  return (
    <span className="ticket-helper-frost" data-testid="ticket-helper-frost" data-kind={kind} aria-hidden>
      <KindGlyph kind={kind} at={null} />
    </span>
  );
}

/**
 * A frozen agent's chip in its expanded tile's and its window's head, in place of its state pill: its kind and the one
 * time that matters ("Scheduled · wakes 22:30", "Done · finished 18:02", "Exited · error 17:48"). None while it is live.
 */
export function FrozenChip({ agent, now }: { agent: FrostFacts; now?: number }) {
  const shows = useNeedsYouShows();
  const text = frozenChip(agent, shows, now);
  if (text === undefined) return null;
  const [word, ...rest] = text.split(' · ');
  return (
    <span className="tile-frost-chip" data-testid="frozen-chip" data-kind={frozenKind(agent, shows)}>
      <b className="tile-frost-chip-word">{word}</b>
      {rest.length > 0 && <span className="tile-frost-chip-when"> · {rest.join(' · ')}</span>}
    </span>
  );
}

/** Its head's state: the frozen chip while it is frozen, else `live` (its state pill or Simplified's status). */
export function FrozenOr({ agent, children }: { agent: FrostFacts; children: ReactNode }) {
  return frozenKind(agent, useNeedsYouShows()) === undefined ? children : <FrozenChip agent={agent} />;
}
